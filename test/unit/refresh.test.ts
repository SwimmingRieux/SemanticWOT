import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingHook, indexViewer, readFeed, parseReceipt } from '../../src/index.js';
import { key, note, now, receipt, snapshot } from '../fixtures.js';
import type { IndexPorts, RelayRequest } from '../../src/application/indexing.js';
import type { RankingRecord } from '../../src/application/feed.js';
import type { ChunkEmbedding, NostrEvent, Snapshot } from '../../src/core/types.js';

function harness(embeddingWriteBudget = Infinity) {
  let time = now, incomplete = false, failed = false, embeddingFailed = false;
  const source = [receipt(201, 10, 1), receipt(301, 11, 2), note(1), note(2)];
  const stored = new Map<string, NostrEvent>();
  const embeddings = new Map<string, ChunkEmbedding>(snapshot().embeddings.map(value => [`${value.noteId}:${value.model}`, value]));
  const coverage = new Map<string, { relay: string; scope: string; through: number }>();
  const viewers = new Map<string, number>();
  const requests: RelayRequest[] = [];
  const rankings: RankingRecord[] = [];
  const ports: IndexPorts = {
    clock: { now: () => time },
    relayQuery: { async query(request) {
      requests.push(request);
      if (failed) return { ok: false, error: { code: 'relay-failure', message: 'relay unavailable' } };
      const filter = request.filter;
      const events = source.filter(event => (!filter.kinds || filter.kinds.includes(event.kind)) &&
        (!filter.ids || filter.ids.includes(event.id)) && (!filter['#P'] || event.tags.some(tag => tag[0] === 'P' && filter['#P']!.includes(tag[1]))) &&
        (!filter['#e'] || event.tags.some(tag => tag[0] === 'e' && filter['#e']!.includes(tag[1]))) &&
        (filter.since === undefined || event.created_at >= filter.since) && (filter.until === undefined || event.created_at <= filter.until));
      return { ok: true, value: { events, pages: 1, complete: !incomplete } };
    } },
    eventValidator: { validate: () => ({ ok: true, value: true }) }, receiptParser: { parse: parseReceipt },
    eventWriter: { async put(events) { for (const event of events) stored.set(event.id, event); return { ok: true, value: events.length }; } },
    indexRecordWriter: { put: async records => ({ ok: true, value: records.length }) },
    indexedAtWriter: { put: async timestamp => ({ ok: true, value: timestamp }) },
    indexStateReader: { get: async () => ({ ok: true, value: { events: [...stored.values()], coverage: [...coverage.values()] } }) },
    indexCompletionWriter: { async put(input) { for (const item of input.coverage) coverage.set(`${item.relay}|${item.scope}`, item); viewers.set(input.viewer, input.indexedAt); return { ok: true, value: input.indexedAt }; } },
    embeddingHook: createEmbeddingHook({
      modelIdentityReader: { resolve: async config => embeddingFailed ? { ok: false, error: { code: 'embedding-failure', message: 'model unavailable' } } : { ok: true, value: config.model === 'test' ? 'fixture-v1' : 'changed-v1' } },
      embedder: { embed: async input => ({ ok: true, value: input.input.map(() => [1, 0]) }) },
      embeddingReader: { get: async () => ({ ok: true, value: [...embeddings.values()] }) },
      embeddingWriter: { async put(values) {
        if (embeddingWriteBudget-- <= 0) return { ok: false, error: { code: 'cache-failure', message: 'Embedding persistence transaction budget exhausted.' } };
        for (const value of values) embeddings.set(`${value.noteId}:${value.model}`, value);
        return { ok: true, value: values.length };
      } },
      progress: { report() {} },
    }),
  };
  const snapshotReader = { async get(viewer: string) {
    const indexedAt = viewers.get(viewer);
    if (indexedAt === undefined) return { ok: false as const, error: { code: 'missing-cache' as const, message: 'Run wot index for this viewer.' } };
    return { ok: true as const, value: { events: [...stored.values()], embeddings: [...embeddings.values()], indexedAt, graphVersion: JSON.stringify([[...stored.keys()].sort(), [...embeddings.values()]]) } satisfies Snapshot };
  } };
  const config = { relays: ['wss://ONE.test/'], model: 'test', dimensions: 2 };
  const rankingReader = { async get(input: { viewer: string; graphVersion: string; graphParamsHash: string; paramsHash: string }) {
    return { ok: true as const, value: rankings.find(record => record.viewer === input.viewer && record.graphVersion === input.graphVersion && record.graphParamsHash === input.graphParamsHash) };
  } };
  const rankingWriter = { async put(record: RankingRecord) { rankings.push(record); return { ok: true as const, value: 1 }; } };
  return { ports, snapshotReader, rankingReader, rankingWriter, rankings, config, requests, source, coverage, viewers,
    setTime(value: number) { time = value; }, setIncomplete(value: boolean) { incomplete = value; }, setFailed(value: boolean) { failed = value; }, setEmbeddingFailed(value: boolean) { embeddingFailed = value; } };
}

test('cached refresh preserves the feed within one embedding persistence transaction budget', async () => {
  const h = harness(1);
  h.source.push(receipt(202, 10, 2));
  const refreshed = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, {
    snapshotReader: h.snapshotReader, clock: h.ports.clock, indexPorts: h.ports,
  });
  assert.ok(refreshed.ok, refreshed.ok ? '' : refreshed.error.message);
  assert.deepEqual(refreshed.value.items.map(item => item.id).sort(), [key(1), key(2)]);
  assert.equal(refreshed.value.counts.embeddings, 2);
  assert.equal(h.viewers.get(key(10)), now);
});

test('a failed cached persistence batch preserves the previous feed, cursors and viewer freshness', async () => {
  const h = harness(1);
  h.source.push(receipt(202, 10, 2));
  const ports = { snapshotReader: h.snapshotReader, clock: h.ports.clock, indexPorts: h.ports };
  const initial = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, ports);
  assert.ok(initial.ok);
  const coverage = [...h.coverage.values()];
  h.setTime(now + 100);
  const failed = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, ports);
  assert.deepEqual(failed, { ok: false, error: { code: 'cache-failure', message: 'Embedding persistence transaction budget exhausted.' } });
  assert.equal(h.viewers.get(key(10)), now);
  assert.deepEqual([...h.coverage.values()], coverage);
  h.setTime(now);
  const offline = await readFeed({ viewer: key(10), config: { ...h.config, offline: true } }, ports);
  assert.deepEqual(offline, initial);
});

test('two viewers and individual note scopes keep independent initial history and incremental overlap', async () => {
  const h = harness();
  assert.ok((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok);
  h.setTime(now + 600);
  assert.ok((await indexViewer({ viewer: key(11), config: h.config }, h.ports)).ok);
  const bob = h.requests.find(request => request.filter['#P']?.includes(key(11)));
  assert.equal(bob?.filter.since, undefined);
  const bobTarget = h.requests.find(request => request.filter['#e']?.includes(key(2)));
  assert.equal(bobTarget?.filter.since, undefined);
  h.requests.length = 0;
  h.setTime(now + 900);
  assert.ok((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok);
  assert.equal(h.requests.find(request => request.filter['#P']?.includes(key(10)))?.filter.since, now - 300);
  assert.equal(h.requests.find(request => request.filter['#e']?.includes(key(1)))?.filter.since, now - 300);
  const feed = await readFeed({ viewer: key(10), config: h.config }, { snapshotReader: h.snapshotReader, clock: h.ports.clock });
  assert.ok(feed.ok);
  assert.equal(feed.value.counts.seeds, 1);
  assert.equal(feed.value.counts.receipts, 2);
  assert.equal(feed.value.indexedAt, now + 900);
});

test('interrupted and cap-truncated history cannot advance cursors, and embedding failure cannot publish completion', async () => {
  const h = harness();
  h.setIncomplete(true);
  assert.ok((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok);
  assert.equal(h.coverage.size, 0);
  h.setIncomplete(false);
  h.setTime(now + 100);
  assert.ok((await indexViewer({ viewer: key(10), config: { ...h.config, maxSeedZaps: 1 } }, h.ports)).ok);
  assert.equal(h.coverage.size, 0);
  h.requests.length = 0;
  h.setTime(now + 200);
  h.setEmbeddingFailed(true);
  const failed = await indexViewer({ viewer: key(10), config: h.config }, h.ports);
  assert.equal(failed.ok, false);
  assert.equal(h.requests[0].filter.since, undefined);
  assert.equal(h.coverage.size, 0);
  assert.equal(h.viewers.get(key(10)), now + 100);
  h.setEmbeddingFailed(false);
  assert.ok((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok);
  assert.equal(h.coverage.get(`wss://one.test|outgoing:${key(10)}`)?.through, now + 200);
  h.setTime(now + 300);
  h.setFailed(true);
  assert.equal((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok, false);
  assert.equal(h.viewers.get(key(10)), now + 200);
});

test('inclusive overlap retains late and same-second receipts without duplicating existing payments', async () => {
  const h = harness();
  assert.ok((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok);
  h.source.push(receipt(202, 10, 1, 2000000, 300), receipt(203, 10, 1, 3000000));
  h.setTime(now + 100);
  for (let i = 0; i < 2; i++) assert.ok((await indexViewer({ viewer: key(10), config: h.config }, h.ports)).ok);
  const feed = await readFeed({ viewer: key(10), config: h.config }, { snapshotReader: h.snapshotReader, clock: h.ports.clock });
  assert.ok(feed.ok);
  assert.equal(feed.value.counts.receipts, 3);
  assert.equal(feed.value.counts.seeds, 1);
});

test('feed refresh uses collection and required embeddings, while cached/offline reads and viewer misses use no externals', async () => {
  const h = harness();
  const ports = { snapshotReader: h.snapshotReader, clock: h.ports.clock, indexPorts: h.ports };
  const missing = await readFeed({ viewer: key(10), config: { ...h.config, offline: true } }, ports);
  assert.equal(missing.ok, false);
  assert.equal(h.requests.length, 0);
  const refreshed = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, ports);
  assert.ok(refreshed.ok);
  assert.equal(refreshed.value.counts.seeds, 1);
  h.requests.length = 0;
  h.setFailed(true);
  h.setEmbeddingFailed(true);
  const offline = await readFeed({ viewer: key(10), config: { ...h.config, offline: true } }, ports);
  assert.ok(offline.ok);
  assert.equal(h.requests.length, 0);
  assert.equal((await readFeed({ viewer: key(11), config: { ...h.config, offline: true } }, ports)).ok, false);
  const failure = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, ports);
  assert.equal(failure.ok, false);
  if (!failure.ok) assert.equal(failure.error.code, 'relay-failure');
  h.requests.length = 0;
  const invalid = await readFeed({ viewer: key(10), config: { ...h.config, offline: true, refresh: true } }, ports);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, 'invalid-input');
  assert.equal(h.requests.length, 0);
});


test('rankings reuse time-bounded graph preparation across lambda changes and invalidate after parameters or graph change', async () => {
  const h = harness();
  const ports = { snapshotReader: h.snapshotReader, clock: h.ports.clock, indexPorts: h.ports, rankingReader: h.rankingReader, rankingWriter: h.rankingWriter };
  const initial = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true, lambda: 1 } }, ports);
  assert.ok(initial.ok);
  assert.equal(h.rankings.length, 1);
  h.setTime(now + 100);
  h.setFailed(true); h.setEmbeddingFailed(true);
  const cached = await readFeed({ viewer: key(10), config: { ...h.config, offline: true, lambda: 0 } }, ports);
  assert.ok(cached.ok);
  assert.equal(cached.value.generatedAt, now);
  assert.deepEqual(cached.value.walk, initial.value.walk);
  assert.equal(h.rankings.length, 1);
  const params = await readFeed({ viewer: key(10), config: { ...h.config, alpha: 1 } }, ports);
  assert.ok(params.ok);
  assert.equal(params.value.generatedAt, now + 100);
  const incompatible = await readFeed({ viewer: key(10), config: { ...h.config, model: 'different' } }, ports);
  assert.equal(incompatible.ok, false);
  h.setTime(now + 301);
  const expired = await readFeed({ viewer: key(10), config: h.config }, ports);
  assert.ok(expired.ok);
  assert.equal(expired.value.generatedAt, now + 301);
  assert.ok(expired.value.diagnostics.some(item => item.code === 'stale-cache' && item.message.includes('301')));
  h.setFailed(false); h.setEmbeddingFailed(false);
  h.source.push(receipt(202, 10, 2, 2000000));
  const updated = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, ports);
  assert.ok(updated.ok);
  assert.equal(updated.value.counts.seeds, 2);
  assert.equal(h.rankings.length, 2);
});


test('refresh updates incompatible required model vectors, while cached reads cannot silently reuse the old ranking', async () => {
  const h = harness();
  const ports = { snapshotReader: h.snapshotReader, clock: h.ports.clock, indexPorts: h.ports, rankingReader: h.rankingReader, rankingWriter: h.rankingWriter };
  assert.ok((await readFeed({ viewer: key(10), config: { ...h.config, refresh: true } }, ports)).ok);
  h.setTime(now + 10);
  h.setEmbeddingFailed(true);
  const unavailable = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true, model: 'new' } }, ports);
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, 'embedding-failure');
  assert.equal(h.viewers.get(key(10)), now);
  h.setEmbeddingFailed(false);
  const changed = await readFeed({ viewer: key(10), config: { ...h.config, refresh: true, model: 'new' } }, ports);
  assert.ok(changed.ok);
  assert.equal(changed.value.generatedAt, now + 10);
  assert.equal(changed.value.counts.embeddings, 1);
  h.setFailed(true); h.setEmbeddingFailed(true);
  assert.ok((await readFeed({ viewer: key(10), config: { ...h.config, model: 'new', offline: true } }, ports)).ok);
});
