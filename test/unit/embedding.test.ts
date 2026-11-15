import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkNoteContent, embeddingCacheKey } from '../../src/core/embedding.js';
import { embedCachedNotes } from '../../src/application/embedding.js';
import { defaultConfiguration } from '../../src/application/config.js';
import { note } from '../fixtures.js';
import { readFeed } from '../../src/index.js';
import { key, now, snapshot } from '../fixtures.js';

test('note chunking preserves actual content with overlap, a cap, and explicit empty input', () => {
  const config = { chunkTokens: 5, chunkOverlap: 2, maxChunks: 3 };
  assert.deepEqual(chunkNoteContent('abcdefghijklmno', config), ['abcde', 'defgh', 'ghijk']);
  assert.deepEqual(chunkNoteContent('hi', config), ['hi']);
  assert.deepEqual(chunkNoteContent('', config), ['']);
  assert.deepEqual(chunkNoteContent('a🙂bé', { ...config, chunkOverlap: 0 }), ['a🙂', 'bé']);
});

test('cached note indexing batches prefixed content and reuses vectors across note IDs and viewers', async () => {
  const config = { ...defaultConfiguration, modelVersion: 'digest-v1', dimensions: 2, chunkTokens: 5, chunkOverlap: 2, maxChunks: 3, batchSize: 2 };
  const inputs: string[][] = [], saved: import('../../src/core/types.js').ChunkEmbedding[] = [], progress: string[] = [];
  const ports = {
    embedder: { embed: async (input: { input: string[] }) => { inputs.push(input.input); return { ok: true as const, value: input.input.map(() => [1, 0]) }; } },
    embeddingWriter: { put: async (values: typeof saved) => { saved.push(...values); return { ok: true as const, value: values.length }; } },
    progress: { report: (value: { code: string }) => { progress.push(value.code); } },
  };
  const first = await embedCachedNotes({ notes: [{ ...note(1), content: 'abcdefghijk' }], embeddings: [], config }, ports);
  assert.ok(first.ok);
  assert.deepEqual(inputs, [['clustering: abcde', 'clustering: defgh'], ['clustering: ghijk']]);
  assert.deepEqual(first.value[0].vectors, [[1, 0], [1, 0], [1, 0]]);
  const second = await embedCachedNotes({ notes: [{ ...note(2), content: 'abcdefghijk' }], embeddings: saved, config }, { ...ports, embedder: { embed: async () => assert.fail('compatible shared content must be reused') } });
  assert.ok(second.ok);
  assert.equal(second.value[0].noteId, note(2).id);
  assert.ok(progress.includes('embedding-cache-hit'));
});

test('model and processing changes recompute vectors, while invalid or unavailable models fail actionably', async () => {
  const config = { ...defaultConfiguration, modelVersion: 'digest-v1', dimensions: 2 };
  const notes = [note(1)];
  const embeddingWriter = { put: async () => ({ ok: true as const, value: 1 }) }, progress = { report() {} };
  const first = await embedCachedNotes({ notes, embeddings: [], config }, { embeddingWriter, progress, embedder: { embed: async () => ({ ok: true, value: [[1, 0]] }) } });
  assert.ok(first.ok);
  for (const changed of [{ modelVersion: 'digest-v2' }, { processingVersion: 'chunks-v2' }, { provider: 'other' }, { chunkOverlap: 63 }]) {
    const result = await embedCachedNotes({ notes, embeddings: first.value, config: { ...config, ...changed } }, { embeddingWriter, progress,
      embedder: { embed: async () => ({ ok: false, error: { code: 'embedding-failure', message: 'Start the configured local model server.' } }) } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /Start/);
  }
  for (const value of [[], [[1]], [[0, 0]], [[NaN, 1]], [[Infinity, 1]], [[1, 0], [1, 0]]]) {
    const result = await embedCachedNotes({ notes, embeddings: [], config }, { progress,
      embeddingWriter: { put: async () => assert.fail('invalid vectors must never be persisted') },
      embedder: { embed: async () => ({ ok: true, value }) } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /dimensions|dimensional/);
  }
});

test('a cached persistence failure is returned before starting inference for a missing vector', async () => {
  const config = { ...defaultConfiguration, model: 'test', modelVersion: 'fixture-v1', dimensions: 2 };
  const result = await embedCachedNotes({ notes: [note(1), note(2)], embeddings: snapshot().embeddings.slice(0, 1), config }, {
    embeddingWriter: { put: async () => ({ ok: false, error: { code: 'cache-failure', message: 'Cache is unwritable.' } }) },
    embedder: { embed: async () => assert.fail('cached persistence must succeed before new model work starts') }, progress: { report() {} },
  });
  assert.deepEqual(result, { ok: false, error: { code: 'cache-failure', message: 'Cache is unwritable.' } });
});

test('direct cached-note embedding requires an immutable model version and rejects an oversized context budget', async () => {
  for (const config of [defaultConfiguration, { ...defaultConfiguration, model: 'nomic-embed-text', modelVersion: 'digest', chunkTokens: 2040 }]) {
    const result = await embedCachedNotes({ notes: [note(1)], embeddings: [], config }, {
      embedder: { embed: async () => assert.fail('invalid configuration must not contact a model') },
      embeddingWriter: { put: async () => assert.fail('invalid configuration must not write vectors') }, progress: { report() {} },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /modelVersion|2048/);
  }
});

test('cached semantic feeds remain readable without model ports and reject incompatible processing or content', async () => {
  const frozen = snapshot();
  const ports = { snapshotReader: { get: async () => ({ ok: true as const, value: frozen }) }, clock: { now: () => now } };
  const config = { ...defaultConfiguration, model: 'test', dimensions: 2 };
  assert.ok((await readFeed({ viewer: key(10), config }, ports)).ok);
  for (const changed of [{ chunkTokens: 501 }, { modelVersion: 'new-digest' }, { processingVersion: 'new-processing' }, { provider: 'another' }]) {
    const result = await readFeed({ viewer: key(10), config: { ...config, ...changed } }, ports);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'missing-embeddings');
  }
  frozen.events[0].content = 'changed immutable note';
  assert.equal((await readFeed({ viewer: key(10), config }, ports)).ok, false);
});

test('offline feeds reject mixed immutable model versions after an interrupted embedding upgrade', async () => {
  const frozen = snapshot();
  const config = { ...defaultConfiguration, model: 'test', dimensions: 2 };
  frozen.embeddings[0] = { ...frozen.embeddings[0], modelVersion: 'digest-v2',
    cacheKey: embeddingCacheKey(frozen.events[0].content, { ...config, modelVersion: 'digest-v2' }) };
  const result = await readFeed({ viewer: key(10), config }, {
    snapshotReader: { get: async () => ({ ok: true, value: frozen }) }, clock: { now: () => now },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'missing-embeddings');
    assert.match(result.error.message, /model version|model identity/i);
    assert.match(result.error.message, /index/);
  }
});
