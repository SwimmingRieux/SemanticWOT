import { untraced, type TraceRunner } from '../application/tracing.js';
import { Relay } from 'nostr-tools/relay';
import type { Subscription } from 'nostr-tools/abstract-relay';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import WebSocket from 'ws';
import type { RelayPageError, RelayPageReader, RelayLimits } from './relay.js';
import type { RelayRequest } from '../application/indexing.js';
import type { NostrEvent, Result } from '../core/types.js';
import type { RelayObservation } from './relay-observation.js';
import { createRelayCancellation } from './relay-cancellation.js';
import { closeSubscription } from './relay-sdk.js';

type PageResult = Result<NostrEvent[], RelayPageError>;
interface Entry {
  relay: Relay; connecting: Promise<void>; socket?: WebSocket;
  url: string; active: number; used: number; nextId: number;
  pending: Set<() => void>; queue: ((admitted: boolean) => void)[]; inUse: number; capacity: number; retired: boolean;
}
// Five ASCII characters match the fresh SDK sub:1 wire overhead. Never recycle
// an ID on a live connection: late peer messages cannot close a successor page.
const subscriptionIdLimit = 36 ** 5;
interface Reservation { entry: Entry; subscriptionId: string }
const failed = (message: string): PageResult => ({ ok: false, error: { code: 'relay-failure', message } });
/** Workflow-owned SDK transport. Application callers only borrow the page reader. */
export function createRelayPool(limits: RelayLimits, maxConnections = 20, report: (observation: RelayObservation) => void = () => {}, trace: TraceRunner = untraced) {
  const entries = new Map<string, Entry>();
  const sockets = new Set<WebSocket>();
  const waiting = new Set<() => void>();
  let stopped = false, serial = 0, closing: Promise<void> | undefined;
  const cancellation = createRelayCancellation();
  const notify = () => { for (const wake of waiting) wake(); waiting.clear(); };
  function retire(entry: Entry) {
    if (entry.retired) return;
    entry.retired = true;
    if (entries.get(entry.url) === entry) entries.delete(entry.url);
    for (const queued of entry.queue.splice(0)) queued(false);
    for (const fail of [...entry.pending]) fail();
    report({ type: 'connection-retired', relay: entry.url, ownedSockets: sockets.size });
    notify();
  }
  async function reserve(input: RelayRequest, capacity: number): Promise<Reservation> {
    while (true) {
      if (stopped) throw new Error('Relay workflow has ended.');
      const existing = entries.get(input.relay);
      if (existing) {
        if (existing.nextId === subscriptionIdLimit) {
          if (existing.active) await new Promise<void>(resolve => waiting.add(resolve));
          else {
            retire(existing); existing.relay.close();
            const socket = existing.socket;
            if (socket && socket.readyState !== WebSocket.CLOSED) {
              const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
              socket.terminate(); await closed;
            }
          }
          continue;
        }
        existing.active++; existing.used = ++serial;
        report({ type: 'connection-reuse', relay: input.relay, ownedSockets: sockets.size });
        return { entry: existing, subscriptionId: (existing.nextId++).toString(36).padStart(5, '0') };
      }
      if (entries.size >= maxConnections || sockets.size >= maxConnections) {
        const idle = [...entries.values()].filter(entry => entry.active === 0).sort((a, b) => a.used - b.used)[0];
        if (idle) { retire(idle); idle.relay.close(); idle.socket?.terminate(); }
        if (entries.size >= maxConnections || sockets.size >= maxConnections) await new Promise<void>(resolve => waiting.add(resolve));
        continue;
      }
      let socket: WebSocket | undefined;
      function ownedSocket(url: string) {
        const owned = new WebSocket(url); socket = owned;
        owned.on('error', () => {}); sockets.add(owned);
        report({ type: 'socket-owned', relay: input.relay, ownedSockets: sockets.size });
        owned.once('close', () => { sockets.delete(owned); report({ type: 'socket-released', relay: input.relay, ownedSockets: sockets.size }); notify(); });
        return owned;
      }
      const sdkOptions = { websocketImplementation: ownedSocket as unknown as typeof globalThis.WebSocket, enablePing: false, enableReconnect: false };
      const relay = new Relay(input.relay, sdkOptions);
      const started = performance.now();
      const connecting = relay.connect({ timeout: input.timeoutMs });
      const entry: Entry = { url: input.relay, active: 1, nextId: 1, used: ++serial, relay, connecting, socket, pending: new Set(), queue: [], inUse: 0, capacity, retired: false };
      entries.set(input.relay, entry);
      relay.onclose = () => retire(entry);
      entry.connecting = connecting.then(() => { report({ type: 'connection', relay: input.relay, connectionMs: performance.now() - started, ok: true }); }).catch(error => { report({ type: 'connection', relay: input.relay, connectionMs: performance.now() - started, ok: false }); retire(entry); relay.close(); socket?.terminate(); throw error; });
      return { entry, subscriptionId: '00000' };
    }
  }
  function admit(entry: Entry) {
    while (!entry.retired && entry.queue.length && entry.inUse < entry.capacity) {
      entry.inUse++; entry.queue.shift()!(true);
    }
    report({ type: 'subscriptions', relay: entry.url, active: entry.inUse, queued: entry.queue.length });
  }
  const pageReader: RelayPageReader = { async read(input) {
    if (stopped) return failed('Relay workflow has ended.');
    let entry: Entry | undefined, connected = false, admitted = false;
    try {
      const observed = await cancellation.run<Awaited<ReturnType<RelayLimits['get']>>>(() => limits.get(input.relay, input.timeoutMs), () => ({}));
      if (stopped) return failed('Relay workflow has ended.');
      const capacity = observed.maxSubscriptions ?? Infinity;
      if (capacity === 0) return failed(`Relay ${input.relay} advertises zero subscription capacity.`);
      const reservation = await trace.run('relay.reserve', { relay: input.relay }, () => reserve(input, capacity));
      entry = reservation.entry;
      await trace.run('relay.connection.wait', { relay: input.relay }, () => cancellation.run(() => entry!.connecting, () => undefined)); connected = true;
      const current = entry;
      if (current.retired) return failed(`Connection closed before EOSE from ${input.relay}.`);
      const queuedAt = performance.now();
      admitted = await trace.run('relay.admission', { relay: input.relay, capacity: Number.isFinite(capacity) ? capacity : -1 }, () => new Promise<boolean>(resolve => { current.queue.push(resolve); admit(current); }));
      report({ type: 'admission', relay: input.relay, queuedMs: performance.now() - queuedAt, active: current.inUse, queued: current.queue.length, admitted });
      if (!admitted || current.retired || stopped) return failed(`Connection closed before EOSE from ${input.relay}.`);
      return await trace.run('relay.page', { relay: input.relay, 'page.size': input.pageSize }, () => new Promise<PageResult>(resolve => {
        let settled = false, subscription: Subscription | undefined;
        const events: NostrEvent[] = [];
        const started = performance.now();
        const finish = (result: PageResult, closedBy: 'reader' | 'sdk' = 'reader') => {
          if (settled) return;
          settled = true; clearTimeout(timer); current.pending.delete(disconnected);
          if (subscription) { const cleanup = closeSubscription(subscription, closedBy); if (!cleanup.ok) { result = cleanup; retire(current); current.relay.close(); current.socket?.terminate(); } }
          report({ type: 'page', relay: input.relay, responseMs: performance.now() - started, ok: result.ok, subscriptions: current.relay.openSubs.size, ongoingOperations: current.relay.ongoingOperations });
          resolve(result);
        };
        const disconnected = () => finish(failed(`Connection closed before EOSE from ${input.relay}.`));
        const timer = setTimeout(() => finish(failed(`Timed out before EOSE from ${input.relay}.`)), input.timeoutMs);
        current.pending.add(disconnected);
        try {
          subscription = current.relay.subscribe([{ ...input.filter, limit: input.pageSize }], {
            id: reservation.subscriptionId, eoseTimeout: input.timeoutMs * 2,
            onevent(event) { if (matchFilter(input.filter as Filter, event) && events.length < input.pageSize) events.push(event); },
            oneose() { finish({ ok: true, value: events }); },
            onclose(reason) { finish(failed(`Subscription closed before EOSE: ${reason}`), 'sdk'); },
          });
        } catch (error) { finish(failed(`Relay subscription failed: ${String(error)}`)); }
      }));
    } catch (error) { return { ok: false, error: { code: 'relay-failure', ...(!connected ? { connectionFailure: true as const } : {}), message: `Relay ${input.relay}: ${String(error)}` } }; }
    finally { if (entry) { if (admitted) { entry.inUse--; admit(entry); } entry.active--; entry.used = ++serial; notify(); } }
  } };
  return { pageReader, close() {
    if (closing) return closing;
    stopped = true; cancellation.stop();
    const owned = [...sockets], retained = [...entries.values()];
    const closed = owned.map(socket => socket.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', () => resolve())));
    for (const entry of retained) retire(entry);
    // Keep SDK error handlers installed until pending handshakes reject, clearing
    // their SDK connection timers. relay.close() would remove those handlers.
    for (const socket of owned) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    notify();
    closing = (async () => {
      await Promise.allSettled(retained.map(entry => entry.connecting));
      for (const entry of retained) entry.relay.close();
      await Promise.all(closed);
    })();
    return closing;
  } };
}
