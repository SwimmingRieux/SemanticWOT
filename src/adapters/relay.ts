import { untraced, type TraceRunner } from '../application/tracing.js';
import type { RelayObserver, RelayObservation } from './relay-observation.js';
export type { RelayObserver, RelayObservation } from './relay-observation.js';
import { createRelayCancellation } from './relay-cancellation.js';
import { createRelayPool } from './relay-pool.js';
import { normalizeRelay } from '../application/indexing.js';
import { Relay } from 'nostr-tools/relay';
import type { AbstractRelayConstructorOptions } from 'nostr-tools/abstract-relay';
import WebSocket from 'ws';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { IndexError, RelayQuery, RelayRequest } from '../application/indexing.js';
import type { NostrEvent, Result } from '../core/types.js';
/** Connection failures apply across filters; subscription failures remain scope-specific. */
export interface RelayPageError extends IndexError { connectionFailure?: true }
export interface RelayPageReader { read(input: RelayRequest): Promise<Result<NostrEvent[], RelayPageError>> }
export interface RelayLimits { get(relay: string, timeoutMs: number): Promise<{ maxLimit?: number; maxMessageLength?: number; maxSubscriptions?: number }> }
/** SDK invokes this as a constructor; returning a socket avoids global SDK mutation. */
function nodeWebSocket(url: string | URL, protocols?: string | string[]): WebSocket {
  const socket = new WebSocket(url, protocols);
  // SDK removes its DOM error handler before closing a timed-out handshake.
  // ws emits one final error asynchronously; keep its EventEmitter channel handled.
  // The SDK's own onerror still reports connection failures through read's Result.
  socket.on('error', () => {});
  return socket;
}
/** SDK deadlines call oneose themselves: the earlier explicit deadline keeps timeout distinct from wire EOSE. */
export function createRelayPageReader(): RelayPageReader {
  return { async read(input) {
    let relay: Relay | undefined;
    let connected = false;
    try {
      // Node's native WebSocket re-enters onerror when the SDK closes a failed
      // connection. Supply ws for this instance so transport errors stay typed.
      // The SDK declares the browser constructor, while ws supplies the same
      // handlers the relay uses (without the unused DOM dispatchEvent method).
      const options = { websocketImplementation: nodeWebSocket as unknown as typeof globalThis.WebSocket, enablePing: false, enableReconnect: false } satisfies Omit<AbstractRelayConstructorOptions, 'verifyEvent'>;
      relay = new Relay(input.relay, options);
      await relay.connect({ timeout: input.timeoutMs });
      connected = true;
      const connectedRelay = relay;
      return await new Promise<Result<NostrEvent[], IndexError>>(resolve => {
        const events: NostrEvent[] = [];
        let settled = false;
        const finish = (result: Result<NostrEvent[], IndexError>) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        const timer = setTimeout(() => finish({ ok: false, error: { code: 'relay-failure', message: `Timed out before EOSE from ${input.relay}.` } }), input.timeoutMs);
        connectedRelay.onclose = () => finish({ ok: false, error: { code: 'relay-failure', message: `Connection closed before EOSE from ${input.relay}.` } });
        connectedRelay.subscribe([{ ...input.filter, limit: input.pageSize }], {
          eoseTimeout: input.timeoutMs * 2,
          onevent(event) { if (matchFilter(input.filter as Filter, event) && events.length < input.pageSize) events.push(event); },
          oneose() { finish({ ok: true, value: events }); },
          onclose(reason) { finish({ ok: false, error: { code: 'relay-failure', message: `Subscription closed before EOSE: ${reason}` } }); },
        });
      });
    } catch (error) { return { ok: false, error: { code: 'relay-failure', ...(!connected ? { connectionFailure: true as const } : {}), message: `Relay ${input.relay}: ${error instanceof Error ? error.message : String(error)}` } }; }
    finally { relay?.close(); }
  } };
}
export function createNip11Limits(fetcher: typeof fetch = fetch, trace: TraceRunner = untraced): RelayLimits {
  // One instance belongs to one indexing workflow. Share the initial lookup,
  // including while in flight, rather than re-fetching metadata for every scope.
  const observations = new Map<string, ReturnType<RelayLimits['get']>>();
  const fetchLimits: RelayLimits['get'] = async (relay, timeoutMs) => {
    try {
      const url = new URL(relay); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      const response = await fetcher(url, { headers: { Accept: 'application/nostr+json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return {};
      const body = await response.json() as { limitation?: { max_limit?: number; max_message_length?: number; max_subscriptions?: number } };
      const valid = (n: unknown): number | undefined => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined;
      const capacity = body.limitation?.max_subscriptions;
      return { maxLimit: valid(body.limitation?.max_limit), maxMessageLength: valid(body.limitation?.max_message_length),
        ...(typeof capacity === 'number' && Number.isSafeInteger(capacity) && capacity >= 0 ? { maxSubscriptions: capacity } : {}) };
    } catch { return {}; } // NIP-11 is optional; no advertisement is required.
  };
  return { async get(relay, timeoutMs) {
    let observation = observations.get(relay);
    if (!observation) {
      observation = trace.run('relay.metadata.fetch', { relay, 'timeout.ms': timeoutMs }, () => fetchLimits(relay, timeoutMs));
      observations.set(relay, observation);
    }
    return { ...await observation };
  } };
}
export function createRelayQuery(options: { pageReader?: RelayPageReader; limits?: RelayLimits; now?: () => number } = {}): RelayQuery {
  const reader = options.pageReader ?? createRelayPageReader();
  const now = options.now ?? Date.now;
  const connectionFailures = new Map<string, { retryAt: number; message: string }>();
  return { async query(input) {
    const failure = connectionFailures.get(input.relay);
    if (failure && now() < failure.retryAt) return { ok: false, error: { code: 'relay-failure', message: `Relay ${input.relay} is in connection cooldown for ${Math.ceil((failure.retryAt - now()) / 1000)} seconds after: ${failure.message}` } };
    connectionFailures.delete(input.relay);
    const limits = options.limits ? await options.limits.get(input.relay, input.timeoutMs) : {};
    const pageSize = Math.max(1, Math.min(input.pageSize, limits.maxLimit ?? input.pageSize));
    if (limits.maxMessageLength && JSON.stringify(['REQ', 'wot', { ...input.filter, limit: pageSize }]).length > limits.maxMessageLength) return { ok: false, error: { code: 'relay-failure', message: 'Request exceeds advertised relay message limit; reduce relayPageSize.' } };
    const events = new Map<string, NostrEvent>();
    let until = input.filter.until, incomplete = false, reason: string | undefined;
    for (let pages = 1; pages <= input.maxPages; pages++) {
      const result = await reader.read({ ...input, pageSize, filter: { ...input.filter, ...(until === undefined ? {} : { until }) } });
      if (!result.ok && result.error.connectionFailure) connectionFailures.set(input.relay, { retryAt: now() + 30_000, message: result.error.message });
      if (!result.ok) return events.size ? { ok: true, value: { events: [...events.values()], complete: false, pages, reason: result.error.message } } : result;
      if (!result.value.length) return { ok: true, value: { events: [...events.values()], complete: !incomplete, pages, reason } };
      let oldest = Infinity, added = 0;
      for (const event of result.value) {
        if (!events.has(event.id)) { events.set(event.id, event); added++; }
        oldest = Math.min(oldest, event.created_at);
      }
      if (input.filter.ids && input.filter.ids.every(id => events.has(id))) return { ok: true, value: { events: [...events.values()], complete: true, pages } };
      if (events.size >= input.maxEvents) return { ok: true, value: { events: [...events.values()].slice(0, input.maxEvents), complete: false, pages, reason: 'Event cap reached.' } };
      if (!added || oldest === 0) {
        // A saturated second cannot be enumerated by NIP-01 IDs. Continue older history,
        // but never assert that a repeated inclusive boundary proves complete coverage.
        incomplete = true; reason = 'Inclusive timestamp boundary could not be exhausted; coverage may have gaps.';
        until = oldest - 1;
      } else until = oldest;
      if (until < (input.filter.since ?? 0)) return { ok: true, value: { events: [...events.values()], complete: !incomplete, pages, reason } };
    }
    return { ok: true, value: { events: [...events.values()], complete: false, pages: input.maxPages, reason: reason ?? 'Page cap reached.' } };
  } };
}

export interface ManagedRelayOptions {
  trace?: TraceRunner; limits?: RelayLimits; now?: () => number; maxConnections?: number; signal?: AbortSignal; observer?: RelayObserver;
}
/** The composition root owns transport cleanup; borrowed RelayQuery capabilities stay query-only. */
export async function withRelayQuery<T>(options: ManagedRelayOptions, operation: (query: RelayQuery) => Promise<T>): Promise<T> {
  if (options.maxConnections !== undefined && (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1)) throw new RangeError('maxConnections must be a positive integer.');
  const report = (observation: RelayObservation) => { try { options.observer?.report(observation); } catch { /* Observations cannot change collection outcomes. */ } };
  const trace = options.trace ?? untraced;
  const rawLimits = options.limits ?? createNip11Limits(fetch, trace);
  const limits: RelayLimits = { get: (relay, timeoutMs) => trace.run('relay.metadata', { relay, 'timeout.ms': timeoutMs }, () => rawLimits.get(relay, timeoutMs)) };
  const pool = createRelayPool(limits, options.maxConnections, report, trace);
  const query = createRelayQuery({ pageReader: pool.pageReader, limits, now: options.now });
  let closed = false;
  const cancellation = createRelayCancellation();
  const stopped = (): Result<never, IndexError> => ({ ok: false, error: { code: 'relay-failure', message: 'Relay workflow has ended.' } });
  const interrupted = () => { closed = true; cancellation.stop(); void pool.close(); };
  options.signal?.addEventListener('abort', interrupted, { once: true });
  if (options.signal?.aborted) interrupted();
  try { return await operation({ query(input) {
    if (closed) return Promise.resolve(stopped());
    try {
      const normalized = { ...input, relay: normalizeRelay(input.relay) };
      return trace.run('relay.query', { relay: normalized.relay, scope: 'scope' in input ? String(input.scope).split(':')[0] : 'unknown', 'events.limit': input.maxEvents, 'page.size': input.pageSize, 'pages.limit': input.maxPages, 'timeout.ms': input.timeoutMs, history: input.filter.ids ? 'ids' : input.filter.since === undefined ? 'initial' : 'incremental' }, () => cancellation.run(() => query.query(normalized), stopped)).then(result => {
        report({ type: 'query', relay: normalized.relay, history: input.filter.ids ? 'ids' : input.filter.since === undefined ? 'initial' : 'incremental', outcome: result.ok ? result.value.complete ? 'complete' : 'incomplete' : 'failed' });
        return result;
      });
    }
    catch (error) { return Promise.resolve({ ok: false, error: { code: 'relay-failure', message: String(error) } }); }
  } }); }
  finally { closed = true; cancellation.stop(); options.signal?.removeEventListener('abort', interrupted); await pool.close(); }
}
