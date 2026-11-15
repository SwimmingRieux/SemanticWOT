import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { resolveConfiguration } from '../../../src/index.js';
import type { WebRuntimeOptions, WebRuntimeResult } from '../../../src/web/runtime.js';
import type { WebRuntime } from '../../../src/web/types.js';
import { localRelay } from './relay.js';
import { receipt, now } from '../../fixtures.js';

export function requireWebRuntime(result: WebRuntimeResult): WebRuntime {
  assert.ok(result.ok, result.ok ? 'Expected startup to succeed.' : result.error.message);
  return result.value;
}

/** Public-ready deterministic Nostr inventory: genuine signatures and embedded zap requests. */
export function signedWebInventory(timestamp = now) {
  const viewerSecret = new Uint8Array(32).fill(1), curatorSecret = new Uint8Array(32).fill(2), authorSecret = new Uint8Array(32).fill(3);
  const viewer = getPublicKey(viewerSecret), author = getPublicKey(authorSecret);
  const seed = finalizeEvent({ kind: 1, created_at: timestamp - 100, content: 'A seed note about open networks.', tags: [] }, authorSecret);
  const recommended = finalizeEvent({ kind: 1, created_at: timestamp - 50, content: 'A recommended note about open networks.', tags: [] }, authorSecret);
  function zap(id: number, secret: Uint8Array, target: string) {
    const request = finalizeEvent({ kind: 9734, created_at: timestamp - 20 + id, content: '', tags: [['e', target], ['p', author], ['amount', '1000000']] }, secret);
    const unsigned = receipt(id, 1, 1); unsigned.created_at = request.created_at;
    unsigned.tags = unsigned.tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(request)] : tag[0] === 'P' ? ['P', request.pubkey] : tag[0] === 'e' ? ['e', target] : tag);
    // Distinct checksummed invoices preserve distinct payments even for the same target.
    unsigned.tags.find(tag => tag[0] === 'bolt11')![1] = receipt(id, 1, 1, 1000000 + id).tags.find(tag => tag[0] === 'bolt11')![1];
    request.tags.find(tag => tag[0] === 'amount')![1] = String(1000000 + id);
    unsigned.tags.find(tag => tag[0] === 'description')![1] = JSON.stringify(finalizeEvent({ kind: 9734, created_at: request.created_at, content: '', tags: request.tags }, secret));
    unsigned.tags.push(['p', author]);
    return finalizeEvent(unsigned, authorSecret);
  }
  return { viewer, recommended, events: [seed, recommended, zap(1, viewerSecret, seed.id), zap(2, curatorSecret, seed.id), zap(3, curatorSecret, recommended.id)] };
}

export type WebServiceMode = 'feed' | 'empty' | 'embedding-error' | 'relay-error' | 'sparse';
export async function controlledServices(provider: 'ollama' | 'openai', mode: WebServiceMode = 'feed', inputs: { timestamp?: number; bindHost?: string; advertisedHost?: string } = {}) {
  const inventory = signedWebInventory(inputs.timestamp);
  const bindHost = inputs.bindHost ?? '127.0.0.1', advertisedHost = inputs.advertisedHost ?? '127.0.0.1';
  let release: (() => void) | undefined;
  const embeddingPaths: string[] = [];
  const embeddingRequests: { path: string; authorization?: string; body: Record<string, any> }[] = [];
  let reached: (() => void) | undefined;
  const embeddingStarted = new Promise<void>(resolve => { reached = resolve; });
  const embeddingGate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const embedding = createServer(async (req, res) => {
    embeddingPaths.push(req.url ?? '');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/api/tags') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'fixture:latest', digest: 'fixture-digest-v1' }] })); return; }
    embeddingRequests.push({ path: req.url ?? '', authorization: req.headers.authorization, body });
    reached?.(); if (held) await embeddingGate;
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'embedding-error') { res.statusCode = 503; res.end(JSON.stringify({ error: 'dummy-browser-secret should never reach browser' })); return; }
    const vectors = (body.input as string[]).map(() => [1, 0]);
    res.end(JSON.stringify(provider === 'ollama' ? { embeddings: vectors } : { model: body.model, data: vectors.map((embedding, index) => ({ index, embedding })).reverse() }));
  });
  await new Promise<void>(resolve => embedding.listen(0, bindHost, resolve));
  const address = embedding.address(); assert.ok(address && typeof address !== 'string');
  let relayGate: Promise<void> | undefined, releaseRelay: (() => void) | undefined, relayReached: (() => void) | undefined;
  const relay = await localRelay(async (client, id, filter) => {
    if (relayGate) { relayReached?.(); await relayGate; }
    if (client.readyState !== 1) return;
    if (mode === 'relay-error') { client.send(JSON.stringify(['CLOSED', id, 'fixture offline'])); return; }
    const events = mode === 'empty' ? [] : mode === 'sparse' ? inventory.events.filter(event => event.kind === 9735) : inventory.events;
    for (const event of events.filter(event => matchFilter(filter, event)).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, filter.limit ?? Infinity)) client.send(JSON.stringify(['EVENT', id, event]));
    client.send(JSON.stringify(['EOSE', id]));
  }, {}, { bindHost, advertisedHost });
  const directory = await mkdtemp(join(tmpdir(), 'wot-browser-'));
  const endpoint = `http://${advertisedHost}:${address.port}`;
  const checked = resolveConfiguration({ file: { ...(provider === 'ollama' ? { endpoint } : { openaiEndpoint: endpoint + '/v1' }), model: 'fixture', dimensions: 2, relays: [relay.relay], maxSeedZaps: 20, maxCoZappers: 20, maxZapsPerCoZapper: 20, relayTimeoutMs: 500, cachePath: join(directory, 'wot.sqlite') } });
  assert.ok(checked.ok);
  const options: WebRuntimeOptions = { config: checked.value, apiKey: 'dummy-browser-secret', clock: { now: () => inputs.timestamp ?? now } };
  return { options, viewer: inventory.viewer, inventory, relay, embeddingRequests, embeddingPaths, directory,
    setMode(next: WebServiceMode) { mode = next; },
    holdRelays() {
      relayGate = new Promise<void>(resolve => { releaseRelay = resolve; });
      return new Promise<void>(resolve => { relayReached = resolve; });
    },
    releaseRelays() { releaseRelay?.(); relayGate = undefined; },
    holdEmbeddings() { held = true; }, embeddingStarted, releaseEmbeddings() { release?.(); },
    async close() { releaseRelay?.(); release?.(); await relay.close(); embedding.closeAllConnections(); await new Promise<void>(resolve => embedding.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
