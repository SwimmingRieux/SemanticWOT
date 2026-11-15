import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalParameters, resolveConfiguration } from '../../src/application/config.js';

test('configuration resolves flags before WOT environment, file and defaults', () => {
  const result = resolveConfiguration({
    file: { limit: 3, dimensions: 2, model: 'frozen', seedHalfLifeDays: 7 },
    environment: { WOT_LIMIT: '4', WOT_DIMENSIONS: '8', HOME: '/ignored' },
    flags: { limit: '5' },
  });
  assert.ok(result.ok);
  assert.equal(result.value.limit, 5);
  assert.equal(result.value.dimensions, 8);
  assert.equal(result.value.model, 'frozen');
  assert.equal(result.value.seedHalfLifeDays, 7);
  assert.equal(result.value.alpha, 0.15);
  assert.equal(result.value.lambda, 0.5);
});

test('relay concurrency defaults to eight and validates file, environment and flag overrides', () => {
  const defaults = resolveConfiguration({});
  assert.ok(defaults.ok);
  assert.equal(defaults.value.relayConcurrency, 8);
  const changed = resolveConfiguration({ file: { relayConcurrency: 2 }, environment: { WOT_RELAY_CONCURRENCY: '3' }, flags: { relayConcurrency: '4' } });
  assert.ok(changed.ok);
  assert.equal(changed.value.relayConcurrency, 4);
  for (const relayConcurrency of [0, -1, 1.5, Infinity, '2']) assert.equal(resolveConfiguration({ file: { relayConcurrency } }).ok, false);
});

test('canonical ranking parameters ignore key order and presentation but retain every behavioral identity', () => {
  const a = resolveConfiguration({ file: { model: 'frozen', dimensions: 2, lambda: 0.5 } });
  const b = resolveConfiguration({ file: { compact: true, cachePath: 'elsewhere', lambda: 0.5, dimensions: 2, model: 'frozen' } });
  assert.ok(a.ok); assert.ok(b.ok);
  assert.equal(canonicalParameters(a.value), canonicalParameters(b.value));
  for (const [key, value] of Object.entries({
    lambda: 0, alpha: 0.2, limit: 1, model: 'other', modelVersion: 'revision-2', provider: 'other',
    maxRelays: 3, processingVersion: 'revision-2', dimensions: 4, chunkTokens: 256, chunkOverlap: 32,
    maxChunks: 2, similarityPower: 2, maxCoZappers: 10, endpoint: 'http://localhost:1234',
  })) {
    const changed = resolveConfiguration({ file: { model: 'frozen', dimensions: 2, [key]: value } });
    assert.ok(changed.ok, key);
    assert.notEqual(canonicalParameters(a.value), canonicalParameters(changed.value), key);
  }
});

test('configuration rejects unknown keys, wrong types and invalid bounds with actionable key names', () => {
  for (const [key, value] of Object.entries({
    dimensions: 0, limit: -1, seedHalfLifeDays: 0, noteHalfLifeDays: Infinity,
    alpha: 0, epsilon: 1, lambda: 1.1, maxCoZappers: 0, batchSize: 0,
    collectionTtlSeconds: -1, rankingTtlSeconds: 0, cacheMaxBytes: 1.5,
    provider: '', modelVersion: '', endpoint: 'ftp://localhost', relays: ['https://example.com'],
    compact: 'yes', chunkTokens: 1, imaginary: 42,
  })) {
    const result = resolveConfiguration({ file: { [key]: value } });
    assert.equal(result.ok, false, key);
    if (!result.ok) assert.match(result.error.message, new RegExp(key === 'chunkTokens' ? 'chunk' : key));
  }
  for (const environment of [{ WOT_TYPO: '1' }, { WOT_LIMIT: '' }, { WOT_COMPACT: 'yes' }, { WOT_DIMENSIONS: 'NaN' }]) {
    assert.equal(resolveConfiguration({ environment }).ok, false);
  }
  assert.equal(resolveConfiguration({ file: { dimensions: '2' } }).ok, false);
  for (const lambda of [0, 1]) assert.equal(resolveConfiguration({ file: { lambda, alpha: 1, limit: 0 } }).ok, true);
});

test('maxRelays defaults to one and accepts validated file, environment and flag overrides', () => {
  const defaults = resolveConfiguration({});
  assert.ok(defaults.ok);
  assert.equal(defaults.value.maxRelays, 1);
  for (const input of [
    { file: { maxRelays: 2 } },
    { file: { maxRelays: 3 }, environment: { WOT_MAX_RELAYS: '2' } },
    { file: { maxRelays: 3 }, environment: { WOT_MAX_RELAYS: '4' }, flags: { maxRelays: '2' } },
  ]) {
    const checked = resolveConfiguration(input);
    assert.ok(checked.ok);
    assert.equal(checked.value.maxRelays, 2);
  }
  for (const maxRelays of [0, -1, 1.5, Infinity, NaN, '2', Number.MAX_SAFE_INTEGER + 1]) {
    const checked = resolveConfiguration({ file: { maxRelays } });
    assert.ok(!checked.ok);
    assert.match(checked.error.message, /maxRelays/);
  }
  for (const value of ['0', '-1', '1.5', 'NaN', '']) {
    assert.equal(resolveConfiguration({ environment: { WOT_MAX_RELAYS: value } }).ok, false);
    assert.equal(resolveConfiguration({ flags: { maxRelays: value } }).ok, false);
  }
});

test('provider defaults depend on explicit endpoint provenance and survive serialization', () => {
  for (const input of [{}, { file: { endpoint: 'http://localhost:11434' } }, { environment: { WOT_ENDPOINT: 'http://localhost:11435' } }]) {
    const result = resolveConfiguration(input); assert.ok(result.ok);
    const local = Object.keys(input).length > 0;
    assert.equal(result.value.provider, local ? 'ollama' : 'openai');
    assert.equal(result.value.model, local ? 'nomic-embed-text' : 'text-embedding-3-small');
    assert.equal(result.value.dimensions, local ? 768 : 1536);
    assert.deepEqual(resolveConfiguration({ file: JSON.parse(JSON.stringify(result.value)) }), result);
  }
});

test('provider settings validate supplied values and keep explicit model, dimensions and precedence', () => {
  const result = resolveConfiguration({ file: { endpoint: 'http://file:11434', model: 'custom', dimensions: 42, batchSize: 3 }, environment: { WOT_ENDPOINT: 'http://env:11434', WOT_BATCH_SIZE: '4', OPENAI_API_KEY: 'dummy-key' }, flags: { endpoint: 'http://flag:11434', dimensions: '8' } });
  assert.ok(result.ok);
  assert.equal(result.value.provider, 'ollama'); assert.equal(result.value.endpoint, 'http://flag:11434');
  assert.equal(result.value.model, 'custom'); assert.equal(result.value.dimensions, 8); assert.equal(result.value.batchSize, 4);
  assert.ok(!canonicalParameters(result.value).includes('dummy-key'));
  for (const file of [{ endpoint: '' }, { endpoint: '  ' }, { endpoint: 'ftp://bad' }, { openaiEndpoint: '' }, { openaiEndpoint: 'https://user:password@host' }, { provider: 'openai', endpoint: 'http://localhost:11434' }, { apiKey: 'dummy-key' }]) assert.equal(resolveConfiguration({ file }).ok, false, JSON.stringify(file));
});

test('invalid supplied endpoints never fall back across layers or resolved provenance', () => {
  for (const endpoint of ['', ' ', 'ftp://invalid', 'https://user:password@host']) {
    for (const input of [
      { file: { endpoint }, environment: { WOT_ENDPOINT: 'http://valid:11434' } },
      { environment: { WOT_ENDPOINT: endpoint }, flags: { endpoint: 'http://valid:11434' } },
      { flags: { endpoint } }, { file: { endpoint, ollamaConfigured: false } },
    ]) { const result = resolveConfiguration(input); assert.equal(result.ok, false); if (!result.ok) assert.match(result.error.message, /endpoint/); }
  }
  for (const input of [
    { file: { endpoint: 'http://custom:11434', ollamaConfigured: false } },
    { file: { ollamaConfigured: true } },
    { file: { endpoint: 'http://custom:11434', ollamaConfigured: true, provider: 'openai' } },
    { environment: { WOT_OLLAMA_CONFIGURED: 'false' } },
  ]) assert.equal(resolveConfiguration(input).ok, false);
});

test('provider endpoints reject embedded query credentials and contradictory provider identity', () => {
  for (const file of [{ openaiEndpoint: 'https://example.test/v1?api_key=dummy-secret' }, { endpoint: 'http://example.test/#dummy-secret' }, { endpoint: 'http://example.test:11434', provider: 'custom' }]) assert.equal(resolveConfiguration({ file }).ok, false);
});
