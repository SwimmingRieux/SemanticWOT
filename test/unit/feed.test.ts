import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFeed, serializeFeed } from '../../src/index.js';
import { key, now, snapshot } from '../fixtures.js';
test('the complete offline pubkey-to-JSON pipeline is deterministic and attributes wallet receipts to senders', async () => {
  const ports = { snapshotReader: { get: async () => ({ ok: true as const, value: snapshot() }) }, clock: { now: () => now } };
  const input = { viewer: key(10), config: { model: 'test', dimensions: 2 } };
  const a = await readFeed(input, ports), b = await readFeed(input, ports);
  assert.ok(a.ok && b.ok);
  assert.equal(serializeFeed(a.value), serializeFeed(b.value));
  assert.deepEqual(a.value.items.map(i => i.id), [key(2), key(1), key(3)]);
  assert.equal(a.value.counts.seeds, 1);
  assert.equal(a.value.counts.edges, 2);
  assert.equal(a.value.selection, 'mmr');
});
test('the complete offline pipeline reduces repetition by default without changing graph scores or raw relevance', async () => {
  const frozen = snapshot();
  frozen.embeddings[2].vectors = [[.2, Math.sqrt(.96)]];
  const ports = { snapshotReader: { get: async () => ({ ok: true as const, value: frozen }) }, clock: { now: () => now } };
  const relevance = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2, lambda: 1 } }, ports);
  const diverse = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, ports);
  assert.ok(relevance.ok && diverse.ok);
  assert.deepEqual(relevance.value.items.map(i => i.id), [key(1), key(2), key(3)]);
  assert.deepEqual(diverse.value.items.map(i => i.id), [key(1), key(3), key(2)]);
  assert.deepEqual(diverse.value.walk, relevance.value.walk);
  const raw = (items: typeof diverse.value.items) => Object.fromEntries(items.map(i => [i.id, i.rawRelevance]));
  assert.deepEqual(raw(diverse.value.items), raw(relevance.value.items));
  assert.ok(diverse.value.items.every(i => Number.isFinite(i.mmrScore)));
  assert.ok(!diverse.value.diagnostics.some(d => d.code === 'intermediate-selection'));
  const repeated = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, ports);
  assert.ok(repeated.ok);
  assert.equal(serializeFeed(diverse.value), serializeFeed(repeated.value));
});
test('relay copies do not change evidence, and event arrival order does not change feed bytes', async () => {
  const frozen = snapshot();
  const input = { viewer: key(10), config: { model: 'test', dimensions: 2 } };
  const first = await readFeed(input, { snapshotReader: { get: async () => ({ ok: true, value: frozen }) }, clock: { now: () => now } });
  const second = await readFeed(input, { snapshotReader: { get: async () => ({ ok: true, value: { ...frozen, events: [...frozen.events, ...frozen.events].reverse() } }) }, clock: { now: () => now } });
  assert.ok(first.ok && second.ok);
  assert.equal(serializeFeed(first.value), serializeFeed(second.value));
});
test('a viewer without usable seeds gets successful empty JSON and an explanation without requiring vectors', async () => {
  const result = await readFeed({ viewer: key(999) }, { snapshotReader: { get: async () => ({ ok: true, value: { ...snapshot(), embeddings: [] } }) }, clock: { now: () => now } });
  assert.ok(result.ok);
  assert.deepEqual(result.value.items, []);
  assert.equal(result.value.diagnostics.at(-1)?.code, 'no-seeds');
});
test('required vectors fail actionably instead of dropping semantic ranking', async () => {
  const result = await readFeed({ viewer: key(10), config: { model: 'other', dimensions: 2 } }, { snapshotReader: { get: async () => ({ ok: true, value: snapshot() }) }, clock: { now: () => now } });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error.code, 'missing-embeddings'); assert.match(result.error.message, /index/); }
});
test('invalid parameters are usage errors before any cache read', async () => {
  const result = await readFeed({ viewer: key(10), config: { alpha: 0 } }, { snapshotReader: { get: async () => { assert.fail('must not read cache'); } }, clock: { now: () => now } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'invalid-input');
});
test('lambda must be finite and within the inclusive zero-to-one interval before a cache read', async () => {
  for (const lambda of [-.1, 1.1, NaN, Infinity]) {
    const result = await readFeed({ viewer: key(10), config: { lambda } }, {
      snapshotReader: { get: async () => { assert.fail('invalid lambda must not read the cache'); } }, clock: { now: () => now },
    });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, 'invalid-input'); assert.match(result.error.message, /lambda/); }
  }
});
test('candidate truncation retains a usable seed before unrelated lower event IDs', async () => {
  const frozen = snapshot();
  // Viewer 30 seeded note 2; note 1 sorts earlier but must not erase their seed at the cap.
  const result = await readFeed({ viewer: key(30), config: { model: 'test', dimensions: 2, maxCandidates: 1 } }, { snapshotReader: { get: async () => ({ ok: true, value: frozen }) }, clock: { now: () => now } });
  assert.ok(result.ok);
  assert.deepEqual(result.value.items.map(i => i.id), [key(2)]);
  assert.ok(result.value.diagnostics.some(d => d.code === 'candidate-cap'));
});
test('graph truncation is reported separately from numerical convergence', async () => {
  const result = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2, maxEdges: 1 } }, { snapshotReader: { get: async () => ({ ok: true, value: snapshot() }) }, clock: { now: () => now } });
  assert.ok(result.ok);
  assert.equal(result.value.walk.reason, 'converged');
  assert.equal(result.value.counts.edges, 1);
  assert.ok(result.value.diagnostics.some(d => d.code === 'edge-cap'));
});
