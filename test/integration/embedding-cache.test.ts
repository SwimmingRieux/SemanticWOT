import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { createEmbeddingHook } from '../../src/application/embedding.js';
import { defaultConfiguration } from '../../src/application/config.js';
import { readFeed } from '../../src/index.js';
import { key, note, now, snapshot } from '../fixtures.js';

test('cached seed notes and a fixed graph can be embedded, reused, and ranked across viewers without a model server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-embedding-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const cache = opened.value, frozen = snapshot(), config = { ...defaultConfiguration, model: 'test', dimensions: 2 };
    await cache.eventWriter.put(frozen.events);
    const common = { embeddingReader: cache.embeddingReader, embeddingWriter: cache.embeddingWriter,
      modelIdentityReader: { resolve: async () => ({ ok: true as const, value: 'fixed-model-digest' }) }, progress: { report() {} } };
    const first = await createEmbeddingHook({ ...common, embedder: { embed: async input => ({ ok: true, value: input.input.map(() => [1, 0]) }) } })
      .prepare({ notes: frozen.events.filter(event => event.kind === 1), config });
    assert.ok(first.ok);
    const repeated = await createEmbeddingHook({ ...common, embedder: { embed: async () => assert.fail('repeated indexing must reuse compatible cached vectors') } })
      .prepare({ notes: frozen.events.filter(event => event.kind === 1), config });
    assert.ok(repeated.ok);
    await cache.indexedAtWriter.put(now);
    cache.close();
    const reopened = openSqliteCache({ path, readonly: true }); assert.ok(reopened.ok);
    try {
      for (const viewer of [key(10), key(20)]) {
        const feed = await readFeed({ viewer, config }, { snapshotReader: reopened.value.snapshotReader, clock: { now: () => now } });
        assert.ok(feed.ok);
        assert.equal(feed.value.items.length, 3);
      }
    } finally { reopened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cached aliases and newly computed vectors survive a later model failure and are reused after reopen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-embedding-resume-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const config = { ...defaultConfiguration, model: 'test', dimensions: 2, modelVersion: 'fixture-v1' };
    const notes = [note(1), { ...note(2), content: note(1).content }, note(3), note(4)];
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    try {
      const cache = opened.value;
      assert.ok((await cache.embeddingWriter.put(snapshot().embeddings.slice(0, 1))).ok);
      const failed = await createEmbeddingHook({ embeddingReader: cache.embeddingReader, embeddingWriter: cache.embeddingWriter,
        modelIdentityReader: { resolve: async () => ({ ok: true, value: 'fixture-v1' }) }, progress: { report() {} },
        embedder: { async embed(input) {
          if (input.input[0] === 'clustering: note 3') return { ok: true, value: [[0, 1]] };
          assert.deepEqual(input.input, ['clustering: note 4']);
          return { ok: false, error: { code: 'embedding-failure', message: 'Model stopped.' } };
        } },
      }).prepare({ notes, config });
      assert.deepEqual(failed, { ok: false, error: { code: 'embedding-failure', message: 'Model stopped.' } });
    } finally { opened.value.close(); }
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    try {
      const retained = await reopened.value.embeddingReader.get(); assert.ok(retained.ok);
      assert.deepEqual(retained.value.map(value => ({ noteId: value.noteId, vectors: value.vectors })), [
        { noteId: key(1), vectors: [[1, 0]] }, { noteId: key(2), vectors: [[1, 0]] }, { noteId: key(3), vectors: [[0, 1]] },
      ]);
      const resumed = await createEmbeddingHook({ embeddingReader: reopened.value.embeddingReader, embeddingWriter: reopened.value.embeddingWriter,
        modelIdentityReader: { resolve: async () => ({ ok: true, value: 'fixture-v1' }) }, progress: { report() {} },
        embedder: { async embed(input) { assert.deepEqual(input.input, ['clustering: note 4']); return { ok: true, value: [[0, 1]] }; } },
      }).prepare({ notes, config });
      assert.ok(resumed.ok);
      const complete = await reopened.value.embeddingReader.get(); assert.ok(complete.ok);
      assert.deepEqual(complete.value.map(value => value.noteId), [key(1), key(2), key(3), key(4)]);
    } finally { reopened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cached preparation refreshes LRU for the reused subset across reopen without losing vectors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-embedding-lru-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    let budget: number;
    try {
      const cache = opened.value;
      assert.ok((await cache.embeddingWriter.put(snapshot().embeddings)).ok);
      const stats = await cache.statsReader.get(); assert.ok(stats.ok);
      budget = stats.value.immutableBytes * 2 / 3;
      const reused = await createEmbeddingHook({ embeddingReader: cache.embeddingReader, embeddingWriter: cache.embeddingWriter,
        modelIdentityReader: { resolve: async () => ({ ok: true, value: 'fixture-v1' }) }, progress: { report() {} },
        embedder: { embed: async () => assert.fail('cached preparation must not invoke the model') },
      }).prepare({ notes: [note(2), note(1)], config: { ...defaultConfiguration, model: 'test', dimensions: 2 } });
      assert.ok(reused.ok);
    } finally { opened.value.close(); }
    const reopened = openSqliteCache({ path }); assert.ok(reopened.ok);
    try {
      const pruned = await reopened.value.cachePruner.prune({ maxBytes: budget }); assert.ok(pruned.ok);
      assert.deepEqual(pruned.value.evicted, { events: 0, embeddings: 1 });
      const retained = await reopened.value.embeddingReader.get(); assert.ok(retained.ok);
      assert.deepEqual(retained.value, snapshot().embeddings.slice(0, 2));
    } finally { reopened.value.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
