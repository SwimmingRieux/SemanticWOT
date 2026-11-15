import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { key, now, snapshot } from '../fixtures.js';

test('SQLite completion retains independent scope cursors and per-viewer freshness across reopen, then pruning clears both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-refresh-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const cache = opened.value;
    await cache.eventWriter.put(snapshot().events);
    await cache.embeddingWriter.put(snapshot().embeddings);
    await cache.indexedAtWriter.put(now - 100);
    assert.ok((await cache.indexCompletionWriter.put({ viewer: key(10), indexedAt: now, coverage: [{ relay: 'wss://one.test', scope: `outgoing:${key(10)}`, through: now }] })).ok);
    assert.equal((await cache.snapshotReader.get(key(11))).ok, false);
    await cache.indexCompletionWriter.put({ viewer: key(11), indexedAt: now + 600, coverage: [{ relay: 'wss://one.test', scope: `target:${key(2)}`, through: now + 600 }] });
    cache.close();
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    const alice = await reopened.value.snapshotReader.get(key(10)); assert.ok(alice.ok);
    assert.equal(alice.value.indexedAt, now);
    const rejected = await reopened.value.indexCompletionWriter.put({ viewer: key(10), indexedAt: now + 999, coverage: [
      { relay: 'wss://one.test', scope: `outgoing:${key(10)}`, through: now + 999 },
      { relay: 'wss://one.test', scope: 'bad', through: NaN },
    ] });
    assert.equal(rejected.ok, false);
    const afterFailure = await reopened.value.snapshotReader.get(key(10)); assert.ok(afterFailure.ok);
    assert.equal(afterFailure.value.indexedAt, now);
    const state = await reopened.value.indexStateReader.get(); assert.ok(state.ok);
    assert.equal(state.value.coverage.length, 2);
    assert.equal(state.value.coverage.find(item => item.scope === `outgoing:${key(10)}`)?.through, now);
    const pruned = await reopened.value.cachePruner.prune({ maxBytes: 0 }); assert.ok(pruned.ok);
    const cleared = await reopened.value.indexStateReader.get(); assert.ok(cleared.ok);
    assert.deepEqual(cleared.value.coverage, []);
    assert.equal((await reopened.value.snapshotReader.get(key(10))).ok, false);
    reopened.value.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('SQLite retains prepared rankings, preserves versions for immutable reuse, and clears rankings for graph/model/prune changes', async () => {
  const { readFeed, indexAndReadFeed, parseReceipt } = await import('../../src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'wot-ranking-'));
  try {
    const opened = openSqliteCache({ path: join(dir, 'cache.sqlite') }); assert.ok(opened.ok);
    const cache = opened.value;
    await cache.embeddingWriter.put(snapshot().embeddings);
    const source = snapshot().events;
    const config = { relays: ['wss://one.test'], model: 'test', dimensions: 2 };
    let time = now;
    const ports = { snapshotReader: cache.snapshotReader, rankingReader: cache.rankingReader, rankingWriter: cache.rankingWriter, clock: { now: () => time }, indexPorts: {
      ...cache, clock: { now: () => time }, receiptParser: { parse: parseReceipt }, eventValidator: { validate: () => ({ ok: true as const, value: true }) },
      relayQuery: { query: async () => ({ ok: true as const, value: { events: source, complete: true, pages: 1 } }) },
      embeddingHook: { prepare: async () => ({ ok: true as const, value: [] }) },
    } };
    const first = await indexAndReadFeed({ viewer: key(10), config }, ports); assert.ok(first.ok);
    const stats = await cache.statsReader.get(); assert.ok(stats.ok);
    assert.equal(stats.value.tables.rankings.rows, 1);
    const before = await cache.snapshotReader.get(key(10)); assert.ok(before.ok);
    await cache.eventWriter.put(before.value.events);
    await cache.embeddingWriter.put(snapshot().embeddings);
    const reused = await cache.snapshotReader.get(key(10)); assert.ok(reused.ok);
    assert.equal(before.value.graphVersion, reused.value.graphVersion);
    time = now + 100;
    const cached = await readFeed({ viewer: key(10), config: { ...config, lambda: 1, offline: true } }, ports); assert.ok(cached.ok);
    assert.equal(cached.value.generatedAt, now);
    const different = snapshot().embeddings[0];
    await cache.embeddingWriter.put([{ ...different, modelVersion: 'new-model' }]);
    const changed = await cache.snapshotReader.get(key(10)); assert.ok(changed.ok);
    assert.notEqual(changed.value.graphVersion, before.value.graphVersion);
    const invalidated = await cache.statsReader.get(); assert.ok(invalidated.ok);
    assert.equal(invalidated.value.tables.rankings.rows, 0);
    const noVectors = await readFeed({ viewer: key(10), config }, ports);
    assert.equal(noVectors.ok, false);
    await cache.embeddingWriter.put(snapshot().embeddings);
    assert.ok((await indexAndReadFeed({ viewer: key(10), config }, ports)).ok);
    await cache.cachePruner.prune({ maxBytes: 0 });
    const pruned = await cache.statsReader.get(); assert.ok(pruned.ok);
    assert.equal(pruned.value.tables.rankings.rows, 0);
    cache.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
