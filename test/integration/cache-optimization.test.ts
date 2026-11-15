import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { readFeed, serializeFeed } from '../../src/index.js';
import { key, now, snapshot } from '../fixtures.js';

test('feed snapshots preserve the feed and freshness while full snapshots retain audit history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-feed-projection-'));
  try {
    const opened = openSqliteCache({ path: join(dir, 'cache.sqlite') }); assert.ok(opened.ok);
    const cache = opened.value;
    try {
      const frozen = snapshot();
      assert.ok((await cache.eventWriter.put(frozen.events)).ok);
      assert.ok((await cache.embeddingWriter.put(frozen.embeddings)).ok);
      const audit = { relay: 'wss://one.test', scope: 'target:fixture', observedAt: now, complete: true };
      assert.ok((await cache.indexRecordWriter.put([audit])).ok);
      assert.ok((await cache.indexCompletionWriter.put({ viewer: key(10), indexedAt: now, coverage: [] })).ok);
      const input = { viewer: key(10), config: { model: 'test', dimensions: 2 } };
      const full = await cache.snapshotReader.get(key(10)); assert.ok(full.ok);
      assert.deepEqual(full.value.indexRecords, [audit]);
      const projected = await cache.feedSnapshotReader.get(key(10)); assert.ok(projected.ok);
      const { indexRecords: _audit, ...expected } = full.value;
      assert.deepEqual(projected.value, expected);
      const ports = { clock: { now: () => now } };
      const original = await readFeed(input, { ...ports, snapshotReader: cache.snapshotReader }); assert.ok(original.ok);
      const optimized = await readFeed(input, { ...ports, snapshotReader: cache.feedSnapshotReader }); assert.ok(optimized.ok);
      assert.equal(serializeFeed(optimized.value), serializeFeed(original.value));
      assert.deepEqual(await cache.feedSnapshotReader.get(key(999)), await cache.snapshotReader.get(key(999)));
      const retained = await cache.snapshotReader.get(key(10)); assert.ok(retained.ok);
      assert.deepEqual(retained.value.indexRecords, [audit]);
    } finally { cache.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reusing immutable embedding payloads succeeds without payload updates and retains LRU order across reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-immutable-reuse-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const vectors = snapshot().embeddings;
    assert.ok((await opened.value.embeddingWriter.put(vectors)).ok);
    const stats = await opened.value.statsReader.get(); assert.ok(stats.ok);
    const guard = new Database(path);
    guard.exec(`CREATE TRIGGER immutable_vectors BEFORE UPDATE OF vectors_json, cache_key, model_version ON embeddings
      BEGIN SELECT RAISE(ABORT, 'Immutable embedding payload must not be rewritten.'); END`);
    guard.close();
    try {
      assert.deepEqual(await opened.value.embeddingWriter.put([vectors[0]]), { ok: true, value: 1 });
    } finally { opened.value.close(); }
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    try {
      const pruned = await reopened.value.cachePruner.prune({ maxBytes: stats.value.immutableBytes * 2 / 3 }); assert.ok(pruned.ok);
      assert.deepEqual(pruned.value.evicted, { events: 0, embeddings: 1 });
      const retained = await reopened.value.embeddingReader.get(); assert.ok(retained.ok);
      assert.deepEqual(retained.value, [vectors[0], vectors[2]]);
    } finally { reopened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed mixed embedding batches roll back reuse touches as well as new payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-reuse-rollback-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const vectors = snapshot().embeddings;
    assert.ok((await opened.value.embeddingWriter.put(vectors)).ok);
    const stats = await opened.value.statsReader.get(); assert.ok(stats.ok);
    const guard = new Database(path);
    guard.exec(`CREATE TRIGGER reject_payload BEFORE INSERT ON embeddings WHEN NEW.cache_key = 'reject'
      BEGIN SELECT RAISE(ABORT, 'Rejected fixture payload.'); END`);
    guard.close();
    try {
      const failed = await opened.value.embeddingWriter.put([vectors[0], { ...vectors[0], noteId: key(4), cacheKey: 'reject' }]);
      assert.ok(!failed.ok);
      assert.equal(failed.error.code, 'cache-failure');
    } finally { opened.value.close(); }
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    try {
      const pruned = await reopened.value.cachePruner.prune({ maxBytes: stats.value.immutableBytes * 2 / 3 }); assert.ok(pruned.ok);
      const retained = await reopened.value.embeddingReader.get(); assert.ok(retained.ok);
      assert.deepEqual(retained.value, vectors.slice(1));
    } finally { reopened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feed projection preserves legacy freshness, read-only access and required-data failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-projection-errors-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const cache = opened.value;
    try {
      assert.deepEqual(await cache.feedSnapshotReader.get(key(10)), await cache.snapshotReader.get(key(10)));
      assert.ok((await cache.eventWriter.put(snapshot().events)).ok);
      assert.ok((await cache.embeddingWriter.put(snapshot().embeddings)).ok);
      assert.ok((await cache.indexedAtWriter.put(now)).ok);
    } finally { cache.close(); }
    const readonly = openSqliteCache({ path, readonly: true }); assert.ok(readonly.ok);
    try {
      const projected = await readonly.value.feedSnapshotReader.get(key(10)); assert.ok(projected.ok);
      assert.equal(projected.value.indexedAt, now);
      const full = await readonly.value.snapshotReader.get(key(10)); assert.ok(full.ok);
      const { indexRecords: _audit, ...expected } = full.value;
      assert.deepEqual(projected.value, expected);
      const failed = await readonly.value.embeddingWriter.put([snapshot().embeddings[0]]);
      assert.ok(!failed.ok);
      assert.equal(failed.error.code, 'cache-failure');
    } finally { readonly.value.close(); }
    const malformed = new Database(path);
    malformed.prepare('UPDATE embeddings SET vectors_json = ? WHERE note_id = ?').run('{', key(1));
    malformed.close();
    const broken = openSqliteCache({ path }); assert.ok(broken.ok);
    try {
      const projected = await broken.value.feedSnapshotReader.get(key(10));
      const full = await broken.value.snapshotReader.get(key(10));
      assert.deepEqual(projected, full);
      assert.ok(!projected.ok);
      assert.equal(projected.error.code, 'cache-failure');
    } finally { broken.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('changing only vector values persists the replacement and invalidates rankings once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-vector-replacement-'));
  try {
    const opened = openSqliteCache({ path: join(dir, 'cache.sqlite') }); assert.ok(opened.ok);
    const cache = opened.value;
    try {
      const frozen = snapshot();
      assert.ok((await cache.eventWriter.put(frozen.events)).ok);
      assert.ok((await cache.embeddingWriter.put(frozen.embeddings)).ok);
      assert.ok((await cache.indexedAtWriter.put(now)).ok);
      const before = await cache.snapshotReader.get(key(10)); assert.ok(before.ok);
      const feed = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, { snapshotReader: cache.feedSnapshotReader, clock: { now: () => now } }); assert.ok(feed.ok);
      const { items: _items, ...output } = feed.value;
      const ranking = { viewer: key(10), paramsHash: 'fixture', graphParamsHash: 'fixture', graphVersion: before.value.graphVersion!, prepared: { output, candidates: [], vectors: {} } };
      assert.deepEqual(await cache.rankingWriter.put(ranking), { ok: true, value: 1 });
      assert.deepEqual(await cache.rankingReader.get(ranking), { ok: true, value: ranking });
      const replacement = { ...frozen.embeddings[0], vectors: [[0, 1]] };
      assert.deepEqual(await cache.embeddingWriter.put([replacement]), { ok: true, value: 1 });
      const vectors = await cache.embeddingReader.get(); assert.ok(vectors.ok);
      assert.deepEqual(vectors.value, [replacement, ...frozen.embeddings.slice(1)]);
      const changed = await cache.feedSnapshotReader.get(key(10)); assert.ok(changed.ok);
      assert.notEqual(changed.value.graphVersion, before.value.graphVersion);
      assert.deepEqual(await cache.rankingReader.get(ranking), { ok: true, value: undefined });
      assert.deepEqual(await cache.embeddingWriter.put([replacement]), { ok: true, value: 1 });
      const repeated = await cache.feedSnapshotReader.get(key(10)); assert.ok(repeated.ok);
      assert.equal(repeated.value.graphVersion, changed.value.graphVersion);
    } finally { cache.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
