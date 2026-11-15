import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaAdapter } from '../../src/adapters/ollama.js';
import { defaultConfiguration } from '../../src/application/config.js';

test('Ollama contract resolves installed model digest and posts modern nontruncating embedding batches', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const adapter = createOllamaAdapter({ endpoint: 'http://localhost:11434/', provider: 'ollama', fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(init?.method === 'POST' ? { model: 'nomic-embed-text', embeddings: [[1, 0], [0, 1]] } :
      { models: [{ name: 'nomic-embed-text:latest', digest: 'sha256:installed-v1' }] }), { status: 200 });
  } });
  const identity = await adapter.modelIdentityReader.resolve({ ...defaultConfiguration, model: 'nomic-embed-text' });
  assert.deepEqual(identity, { ok: true, value: 'sha256:installed-v1' });
  const embedded = await adapter.embedder.embed({ model: 'nomic-embed-text', input: ['clustering: first', 'clustering: second'], dimensions: 2 });
  assert.deepEqual(embedded, { ok: true, value: [[1, 0], [0, 1]] });
  assert.deepEqual(requests.map(request => request.url), ['http://localhost:11434/api/tags', 'http://localhost:11434/api/embed']);
  assert.deepEqual(JSON.parse(String(requests[1].init?.body)), { model: 'nomic-embed-text', input: ['clustering: first', 'clustering: second'], dimensions: 2, truncate: false });
});

test('Ollama failures explain missing models, digest mismatches, transport failures and invalid batches', async () => {
  for (const body of [{}, { embeddings: [[0, 0]] }, { embeddings: [[1]] }, { embeddings: [[1, null]] }, { embeddings: [[1, 0], [1, 0]] }, { error: 'model not found' }]) {
    const adapter = createOllamaAdapter({ endpoint: defaultConfiguration.endpoint, provider: 'ollama', fetch: async () => new Response(JSON.stringify(body)) });
    const result = await adapter.embedder.embed({ model: 'nomic-embed-text', dimensions: 2, input: ['clustering: note'] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /dimensions|pull/);
  }
  const adapter = createOllamaAdapter({ endpoint: defaultConfiguration.endpoint, provider: 'ollama', fetch: async () => new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest', digest: 'new-digest' }] })) });
  const mismatch = await adapter.modelIdentityReader.resolve({ ...defaultConfiguration, model: 'nomic-embed-text', modelVersion: 'old-digest' });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.match(mismatch.error.message, /does not match/);
  const missing = await adapter.modelIdentityReader.resolve({ ...defaultConfiguration, model: 'missing' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error.message, /ollama pull missing/);
  const offline = createOllamaAdapter({ endpoint: defaultConfiguration.endpoint, provider: 'ollama', fetch: async () => { throw new Error('connection refused'); } });
  const unavailable = await offline.embedder.embed({ model: 'nomic-embed-text', dimensions: 2, input: ['clustering: note'] });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.match(unavailable.error.message, /Start Ollama.*pull/);
});
