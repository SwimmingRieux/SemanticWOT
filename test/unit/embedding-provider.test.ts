import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingAdapter } from '../../src/adapters/embedding.js';
import { embedCachedNotes } from '../../src/application/embedding.js';
import { note } from '../fixtures.js';
import { resolveConfiguration } from '../../src/application/config.js';

test('composition selects only the configured provider and requires credentials only at the embedding seam', async () => {
  const remote = resolveConfiguration({}); assert.ok(remote.ok);
  const selected = createEmbeddingAdapter({ config: remote.value, fetch: async () => assert.fail('identity resolution must not call a remote API') }); assert.ok(selected.ok);
  const identity = await selected.value.modelIdentityReader.resolve(remote.value);
  assert.equal(identity.ok, false);
  if (!identity.ok) assert.match(identity.error.message, /OPENAI_API_KEY/);
  const local = resolveConfiguration({ file: { endpoint: 'http://local.test:11434' } }); assert.ok(local.ok);
  const urls: string[] = [];
  const adapter = createEmbeddingAdapter({ config: local.value, apiKey: 'dummy-unused-key', fetch: async url => { urls.push(String(url)); return new Response('{}', { status: 500 }); } }); assert.ok(adapter.ok);
  assert.equal((await adapter.value.embedder.embed({ model: local.value.model, input: ['note'], dimensions: 2 })).ok, false);
  assert.deepEqual(urls, ['http://local.test:11434/api/embed']);
  assert.equal(createEmbeddingAdapter({ config: remote.value, apiKey: '  ' }).ok, false);
});

test('an offline provider identity is preserved while incomplete Ollama composition fails clearly', () => {
  const cached = resolveConfiguration({ file: { provider: 'ollama', model: 'test', dimensions: 2 } }); assert.ok(cached.ok);
  const adapter = createEmbeddingAdapter({ config: cached.value }); assert.equal(adapter.ok, false);
  if (!adapter.ok) assert.match(adapter.error.message, /explicitly configured endpoint/);
});

test('changing provider with the same model label and version replaces incompatible vectors', async () => {
  const remote = resolveConfiguration({ file: { model: 'same-label', modelVersion: 'revision-1', dimensions: 2 } }); assert.ok(remote.ok);
  const local = resolveConfiguration({ file: { endpoint: 'http://local.test:11434', model: 'same-label', modelVersion: 'revision-1', dimensions: 2 } }); assert.ok(local.ok);
  const embeddingWriter = { put: async () => ({ ok: true as const, value: 1 }) }, progress = { report() {} };
  const first = await embedCachedNotes({ notes: [note(1)], embeddings: [], config: remote.value }, { embeddingWriter, progress, embedder: { embed: async () => ({ ok: true, value: [[1, 0]] }) } }); assert.ok(first.ok);
  const second = await embedCachedNotes({ notes: [note(1)], embeddings: first.value, config: local.value }, { embeddingWriter, progress, embedder: { embed: async () => ({ ok: true, value: [[0, 1]] }) } }); assert.ok(second.ok);
  assert.deepEqual(second.value[0].vectors, [[0, 1]]);
  assert.notEqual(first.value[0].cacheKey, second.value[0].cacheKey);
});
