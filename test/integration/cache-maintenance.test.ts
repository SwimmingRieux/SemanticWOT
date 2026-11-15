import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { key, note, now, snapshot } from '../fixtures.js';
import { readFeed } from '../../src/index.js';
import { createEmbeddingHook } from '../../src/application/embedding.js';
import { defaultConfiguration } from '../../src/application/config.js';

test('cache stats account for UTF-8 payload per logical table and allocated SQLite storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-stats-'));
  try {
    const opened = openSqliteCache({ path: join(dir, 'cache.sqlite') }); assert.ok(opened.ok);
    try {
      await opened.value.embeddingWriter.put([{ noteId: 'é', model: 'm', vectors: [[1, 0]], cacheKey: 'key', modelVersion: 'v' }]);
      const result = await opened.value.statsReader.get(); assert.ok(result.ok);
      assert.deepEqual(result.value.tables.embeddings, { rows: 1, bytes: 14 });
      assert.deepEqual(result.value.tables.events, { rows: 0, bytes: 0 });
      assert.deepEqual(result.value.tables.metadata, { rows: 1, bytes: 13 });
      assert.equal(result.value.totalBytes, 27);
      assert.equal(result.value.immutableBytes, 14);
      assert.ok(result.value.databaseBytes >= 4096);
      assert.ok(result.value.allocatedBytes >= result.value.databaseBytes);
    } finally { opened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pruning least recently read events cascades vectors and makes the indexed snapshot a cache miss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-event-prune-'));
  try {
    const opened = openSqliteCache({ path: join(dir, 'cache.sqlite') }); assert.ok(opened.ok);
    try {
      const cache = opened.value;
      await cache.eventWriter.put([note(1)]);
      const one = await cache.statsReader.get(); assert.ok(one.ok);
      await cache.eventWriter.put([note(2)]);
      await cache.embeddingWriter.put([{ noteId: key(2), model: 'test', vectors: [[1, 0]] }]);
      await cache.indexedAtWriter.put(now);
      await cache.indexRecordWriter.put([{ eventId: key(2), relay: 'wss://fixture.test', scope: 'outgoing:viewer', observedAt: now },
        { relay: 'wss://fixture.test', scope: 'outgoing:viewer', observedAt: now, complete: true }]);
      const read = await cache.eventReader.get([key(1)]); assert.ok(read.ok);
      assert.deepEqual(read.value, [note(1)]);
      const pruned = await cache.cachePruner.prune({ maxBytes: one.value.immutableBytes }); assert.ok(pruned.ok);
      assert.deepEqual(pruned.value.evicted, { events: 1, embeddings: 1 });
      assert.equal(pruned.value.invalidated, true);
      assert.deepEqual(await cache.eventReader.get([key(1), key(2)]), { ok: true, value: [note(1)] });
      assert.deepEqual(await cache.embeddingReader.get(), { ok: true, value: [] });
      const missing = await cache.snapshotReader.get(key(10)); assert.ok(!missing.ok);
      assert.equal(missing.error.code, 'missing-cache');
      const stats = await cache.statsReader.get(); assert.ok(stats.ok);
      assert.deepEqual(stats.value.tables.index_records, { rows: 0, bytes: 0 });
      await cache.indexedAtWriter.put(now);
      const retained = await cache.snapshotReader.get(key(10)); assert.ok(retained.ok);
      assert.deepEqual(retained.value.indexRecords, []);
    } finally { opened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit prune uses persistent LRU for embeddings and honors the default or supplied budget', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-lru-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const a = { noteId: 'a', model: 'm', vectors: [[1, 0]], cacheKey: 'key', modelVersion: 'v' };
    const b = { ...a, noteId: 'b' };
    await opened.value.embeddingWriter.put([a, b]);
    await opened.value.embeddingWriter.put([a]);
    opened.value.close();
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    try {
      const noop = await reopened.value.cachePruner.prune({}); assert.ok(noop.ok);
      assert.equal(noop.value.maxBytes, 2_000_000_000);
      assert.deepEqual(noop.value.evicted, { events: 0, embeddings: 0 });
      const pruned = await reopened.value.cachePruner.prune({ maxBytes: 13 }); assert.ok(pruned.ok);
      assert.deepEqual(pruned.value.evicted, { events: 0, embeddings: 1 });
      assert.equal(pruned.value.after.immutableBytes, 13);
      const remaining = await reopened.value.embeddingReader.get(); assert.ok(remaining.ok);
      assert.deepEqual(remaining.value, [a]);
      assert.equal((await reopened.value.cachePruner.prune({ maxBytes: -1 })).ok, false);
    } finally { reopened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stats and prune CLI print JSON and only explicit prune evicts over-budget data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-maintenance-cli-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    await opened.value.eventWriter.put(snapshot().events);
    await opened.value.embeddingWriter.put(snapshot().embeddings);
    await opened.value.indexedAtWriter.put(now);
    opened.value.close();
    const stats = spawnSync(process.execPath, ['dist/cli.js', 'stats', '--cache', path, '--cache-max-bytes', '1', '--compact'], { encoding: 'utf8' });
    assert.ifError(stats.error); assert.equal(stats.status, 0, stats.stderr);
    assert.equal(JSON.parse(stats.stdout).tables.events.rows, 8);
    assert.equal(stats.stdout.trim().split('\n').length, 1);
    assert.equal(stats.stderr, '');
    const prune = spawnSync(process.execPath, ['dist/cli.js', 'prune', '--cache', path, '--cache-max-bytes', '1', '--compact'], { encoding: 'utf8' });
    assert.ifError(prune.error); assert.equal(prune.status, 0, prune.stderr);
    assert.equal(JSON.parse(prune.stdout).after.immutableBytes, 0);
    assert.equal(JSON.parse(prune.stdout).evicted.events, 8);
    const reopened = openSqliteCache({ path, readonly: true }); assert.ok(reopened.ok);
    try { const missing = await reopened.value.snapshotReader.get(key(10)); assert.ok(!missing.ok); assert.equal(missing.error.code, 'missing-cache'); }
    finally { reopened.value.close(); }
    const invalid = spawnSync(process.execPath, ['dist/cli.js', 'prune', '--cache', path, '--cache-max-bytes', '-1'], { encoding: 'utf8' });
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cache-only CLI feeds record usage without creating a missing cache or fetching inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-feed-lru-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    await opened.value.embeddingWriter.put(snapshot().embeddings);
    await opened.value.eventWriter.put(snapshot().events);
    await opened.value.indexedAtWriter.put(now);
    const before = await opened.value.statsReader.get(); assert.ok(before.ok);
    opened.value.close();
    const feed = spawnSync(process.execPath, ['dist/cli.js', 'feed', key(10), '--cache', path, '--model', 'test', '--dimensions', '2', '--offline', '--compact'], { encoding: 'utf8' });
    assert.ifError(feed.error); assert.equal(feed.status, 0, feed.stderr);
    assert.equal(JSON.parse(feed.stdout).items.length, 3);
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    try {
      const pruned = await reopened.value.cachePruner.prune({ maxBytes: before.value.immutableBytes - 1 }); assert.ok(pruned.ok);
      assert.deepEqual(pruned.value.evicted, { events: 1, embeddings: 1 });
    } finally { reopened.value.close(); }
    const missingPath = join(dir, 'missing.sqlite');
    const missing = spawnSync(process.execPath, ['dist/cli.js', 'feed', key(10), '--cache', missingPath, '--offline'], { encoding: 'utf8' });
    assert.ifError(missing.error); assert.equal(missing.status, 1);
    assert.equal(openSqliteCache({ path: missingPath, readonly: true }).ok, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('evicted or completely deleted caches rebuild from supplied sources and share compatible data across viewers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-rebuild-'));
  try {
    const path = join(dir, 'cache.sqlite'), frozen = snapshot();
    const config = { ...defaultConfiguration, model: 'test', dimensions: 2, modelVersion: 'fixture-v1' };
    for (const phase of ['initial', 'evicted', 'deleted']) {
      const opened = openSqliteCache({ path }); assert.ok(opened.ok);
      try {
        const cache = opened.value;
        if (phase !== 'initial') {
          assert.deepEqual(await cache.eventReader.get([key(1)]), { ok: true, value: [] });
          assert.deepEqual(await cache.embeddingReader.get(), { ok: true, value: [] });
        }
        await cache.eventWriter.put(frozen.events);
        const ports = { embeddingReader: cache.embeddingReader, embeddingWriter: cache.embeddingWriter,
          modelIdentityReader: { resolve: async () => ({ ok: true as const, value: 'fixture-v1' }) }, progress: { report() {} } };
        const notes = frozen.events.filter(event => event.kind === 1);
        const rebuilt = await createEmbeddingHook({ ...ports, embedder: { embed: async input => ({ ok: true, value: input.input.map(() => [1, 0]) }) } }).prepare({ notes, config });
        assert.ok(rebuilt.ok);
        const reused = await createEmbeddingHook({ ...ports, embedder: { embed: async () => assert.fail('compatible cached work is reused without model requests') } }).prepare({ notes, config });
        assert.ok(reused.ok);
        await cache.indexedAtWriter.put(now);
        for (const viewer of [key(10), key(20)]) {
          const feed = await readFeed({ viewer, config }, { snapshotReader: cache.snapshotReader, clock: { now: () => now } });
          assert.ok(feed.ok); assert.equal(feed.value.items.length, 3);
        }
        if (phase === 'initial') {
          const pruned = await cache.cachePruner.prune({ maxBytes: 0 }); assert.ok(pruned.ok);
          assert.equal(pruned.value.after.immutableBytes, 0);
        }
      } finally { opened.value.close(); }
      if (phase === 'evicted') await rm(path);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
