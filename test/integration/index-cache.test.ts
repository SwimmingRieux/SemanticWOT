import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { key } from '../fixtures.js';

test('SQLite preserves interpreted receipt evidence and provenance and reads embeddings before first index marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wot-index-'));
  try {
    const opened = openSqliteCache({ path: join(directory, 'cache.sqlite') }); assert.ok(opened.ok);
    const cache = opened.value;
    assert.deepEqual(await cache.embeddingReader.get(), { ok: true, value: [] });
    const record = { eventId: key(1), relay: 'wss://one.test', scope: `outgoing:${key(10)}`, observedAt: 10, complete: false, zap: { id: key(1), kind: 9735 as const, sender: key(10), target: key(2), amountMsat: '100000000000000001', createdAt: 9 } };
    assert.ok((await cache.indexRecordWriter.put([record])).ok);
    await cache.embeddingWriter.put([{ noteId: key(2), model: 'test', vectors: [[1, 0]], cacheKey: 'hash', modelVersion: 'digest' }]);
    const embeddings = await cache.embeddingReader.get(); assert.ok(embeddings.ok);
    assert.equal(embeddings.value[0].cacheKey, 'hash');
    await cache.indexedAtWriter.put(10);
    const snapshot = await cache.snapshotReader.get(key(10)); assert.ok(snapshot.ok);
    assert.equal(snapshot.value.indexRecords?.[0].zap?.amountMsat, '100000000000000001');
    cache.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
