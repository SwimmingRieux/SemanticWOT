import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSnapshot, serializeEvaluation, checkEvaluation } from '../../src/index.js';
import { key, now, snapshot } from '../fixtures.js';

test('snapshot evaluation uses the production feed path and returns deterministic feeds plus honest snapshot counts', async () => {
  const input = { viewers: [key(10), key(999)], snapshot: snapshot(), evaluationTime: now, config: { model: 'test', dimensions: 2 } };
  const first = await evaluateSnapshot(input), second = await evaluateSnapshot(input);
  assert.ok(first.ok && second.ok);
  assert.equal(serializeEvaluation(first.value), serializeEvaluation(second.value));
  const viewer = first.value.viewers[0];
  assert.deepEqual(viewer.feed.items.map(item => item.id), [key(2), key(1), key(3)]);
  assert.deepEqual(viewer.counts, { seeds: 1, coZappers: 1, candidates: 3, edges: 2, embeddings: 3, pushes: viewer.feed.walk.pushes });
  assert.deepEqual(viewer.collection, { status: 'unavailable', reason: 'Frozen snapshot; relay coverage and discovery rates were not measured.' });
  assert.equal(first.value.viewers[1].feed.diagnostics.at(-1)?.code, 'no-seeds');
  assert.deepEqual(first.value.viewers[1].feed.items, []);
  assert.ok(!serializeEvaluation(first.value).includes('runtime'));
});

test('zap and chronological baselines use the same admitted candidates, deduplicate receipts and break ties by event ID', async () => {
  const frozen = snapshot();
  frozen.events = [...frozen.events, frozen.events[3]];
  const common = { viewers: [key(30)], snapshot: frozen, evaluationTime: now, config: { model: 'test', dimensions: 2, maxCandidates: 2 } };
  const zap = await evaluateSnapshot({ ...common, baseline: 'zap' });
  const chrono = await evaluateSnapshot({ ...common, baseline: 'chrono' });
  assert.ok(zap.ok && chrono.ok);
  // Viewer 30's two seeds win admission over the lower-ID nonseed.
  assert.deepEqual(zap.value.viewers[0].baseline?.items.map(item => item.id), [key(2), key(3)]);
  assert.deepEqual(zap.value.viewers[0].baseline?.items.map(item => item.zapAmountMsat), ['2000000', '1000000']);
  assert.deepEqual(chrono.value.viewers[0].baseline?.items.map(item => item.id), [key(2), key(3)]);
  assert.equal(chrono.value.viewers[0].counts.candidates, 2);
});

test('distinct receipt IDs for one payment leave evaluation baselines and admitted candidates unchanged', async () => {
  const frozen = snapshot();
  const input = { viewers: [key(10)], snapshot: frozen, evaluationTime: now, config: { model: 'test', dimensions: 2 }, baseline: 'zap' as const };
  const original = await evaluateSnapshot(input);
  const copied = await evaluateSnapshot({ ...input, snapshot: { ...frozen, events: [...frozen.events, { ...frozen.events[3], id: key(900) }] } });
  assert.ok(original.ok && copied.ok);
  assert.deepEqual(copied.value.viewers[0].baseline, original.value.viewers[0].baseline);
  assert.deepEqual(copied.value.viewers[0].counts, original.value.viewers[0].counts);
  assert.equal(copied.value.viewers[0].feed.counts.receipts, original.value.viewers[0].feed.counts.receipts);
  assert.ok(copied.value.viewers[0].feed.diagnostics.some(item => item.code === 'duplicate-payment'));
});

test('stored expectations report the viewer and first differing field without replacing expected feeds', async () => {
  const result = await evaluateSnapshot({ viewers: [key(10), key(999)], snapshot: snapshot(), evaluationTime: now, config: { model: 'test', dimensions: 2 } });
  assert.ok(result.ok);
  const expected = structuredClone(result.value.viewers[0].feed);
  const saved = JSON.stringify(expected);
  const missing = checkEvaluation(result.value, { [key(10)]: expected });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.mismatches.map(item => [item.viewer, item.path]), [[key(999), '$']]);
  expected.items[0].content = 'an intentional outdated golden';
  const mismatch = checkEvaluation(result.value, { [key(10)]: expected, [key(999)]: result.value.viewers[1].feed });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.mismatches[0].path, '$.items[0].content');
  assert.equal(mismatch.mismatches[0].viewer, key(10));
  assert.match(mismatch.mismatches[0].expected, /outdated/);
  assert.equal(expected.items[0].content, 'an intentional outdated golden');
  assert.notEqual(JSON.stringify(expected), saved);
  const matching = Object.fromEntries(result.value.viewers.map(item => [item.viewer, item.feed]));
  assert.deepEqual(checkEvaluation(result.value, matching), { ok: true, mismatches: [] });
});

test('evaluation exposes weak bridge attenuation rather than normalizing a sole weak exit to full strength', async () => {
  const frozen = snapshot();
  frozen.events = frozen.events.filter(event => ![key(3), key(204), key(205)].includes(event.id));
  frozen.embeddings = frozen.embeddings.slice(0, 2);
  frozen.embeddings[1].vectors = [[.1, Math.sqrt(.99)]];
  const result = await evaluateSnapshot({ viewers: [key(10)], snapshot: frozen, evaluationTime: now, config: { model: 'test', dimensions: 2 } });
  assert.ok(result.ok);
  const items = result.value.viewers[0].feed.items;
  assert.equal(items[0].id, key(1));
  assert.ok(items.find(item => item.id === key(2))!.graphScore < .1);
  assert.equal(result.value.viewers[0].counts.edges, 1);
});

test('evaluation retains the MMR repeated-topic counterexample and reports nonconverged solver results', async () => {
  const frozen = snapshot();
  frozen.embeddings[2].vectors = [[.2, Math.sqrt(.96)]];
  const common = { viewers: [key(10)], snapshot: frozen, evaluationTime: now };
  const relevant = await evaluateSnapshot({ ...common, config: { model: 'test', dimensions: 2, lambda: 1 } });
  const diverse = await evaluateSnapshot({ ...common, config: { model: 'test', dimensions: 2 } });
  const capped = await evaluateSnapshot({ ...common, config: { model: 'test', dimensions: 2, maxPushesPerNode: 1, epsilon: 1e-12 } });
  assert.ok(relevant.ok && diverse.ok && capped.ok);
  assert.deepEqual(relevant.value.viewers[0].feed.items.map(item => item.id), [key(1), key(2), key(3)]);
  assert.deepEqual(diverse.value.viewers[0].feed.items.map(item => item.id), [key(1), key(3), key(2)]);
  assert.equal(capped.value.viewers[0].feed.walk.reason, 'safety-cap');
  assert.ok(capped.value.viewers[0].feed.walk.residual > 1e-12);
  assert.ok(capped.value.viewers[0].feed.diagnostics.some(item => item.code === 'walk-safety-cap'));
  assert.equal(capped.value.viewers[0].counts.pushes, capped.value.viewers[0].feed.walk.pushes);
});
