import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIAdapter } from '../../src/adapters/openai.js';
import { defaultConfiguration } from '../../src/application/config.js';

test('OpenAI maps authorization and batches and orders vectors by response index', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const adapter = createOpenAIAdapter({ endpoint: 'https://example.test/v1/', apiKey: 'dummy-key', fetch: async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ model: 'text-embedding-3-small', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
  } });
  assert.deepEqual(await adapter.modelIdentityReader.resolve(defaultConfiguration), { ok: true, value: 'openai-label:text-embedding-3-small' });
  assert.deepEqual(await adapter.embedder.embed({ model: 'text-embedding-3-small', dimensions: 2, input: ['clustering: first', 'clustering: second'] }), { ok: true, value: [[1, 0], [0, 1]] });
  assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://example.test/v1/embeddings');
  assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), 'Bearer dummy-key');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { model: 'text-embedding-3-small', dimensions: 2, input: ['clustering: first', 'clustering: second'], encoding_format: 'float' });
});

test('OpenAI rejects malformed vectors, response indexes and provider errors without disclosing secrets', async () => {
  const secret = 'dummy-private-key';
  const bodies = [ {}, { model: 'other', data: [{ index: 0, embedding: [1, 0] }] },
    ...[[], [0, 0], [1], [1, null], [1, 'bad']].map(embedding => ({ model: 'm', data: [{ index: 0, embedding }] })),
    { model: 'm', data: [{ index: -1, embedding: [1, 0] }] }, { model: 'm', data: [{ index: 1.5, embedding: [1, 0] }] },
    { model: 'm', data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] } ];
  for (const body of bodies) {
    const adapter = createOpenAIAdapter({ endpoint: 'https://example.test/v1', apiKey: secret, fetch: async () => new Response(JSON.stringify(body)) });
    const result = await adapter.embedder.embed({ model: 'm', dimensions: 2, input: ['note'] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'embedding-failure');
  }
  for (const status of [401, 403, 404, 429, 500]) {
    const adapter = createOpenAIAdapter({ endpoint: 'https://example.test/v1', apiKey: secret, fetch: async () => new Response(secret, { status }) });
    const result = await adapter.embedder.embed({ model: 'm', dimensions: 2, input: ['note'] });
    assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes(secret));
    if (!result.ok) assert.match(result.error.message, new RegExp(String(status)));
  }
  const adapter = createOpenAIAdapter({ endpoint: 'https://example.test/v1', apiKey: secret, fetch: async () => { throw new Error(secret); } });
  assert.ok(!JSON.stringify(await adapter.embedder.embed({ model: 'm', dimensions: 2, input: ['note'] })).includes(secret));
});

test('remote identity distinguishes mutable model labels and explicit operator revisions without network calls', async () => {
  const adapter = createOpenAIAdapter({ endpoint: 'https://example.test/v1', apiKey: 'dummy-key', fetch: async () => assert.fail('remote identity must not be presented as a downloaded digest') });
  assert.deepEqual(await adapter.modelIdentityReader.resolve({ ...defaultConfiguration, model: 'other' }), { ok: true, value: 'openai-label:other' });
  assert.deepEqual(await adapter.modelIdentityReader.resolve({ ...defaultConfiguration, modelVersion: 'operator-revision-2' }), { ok: true, value: 'operator-revision-2' });
});
