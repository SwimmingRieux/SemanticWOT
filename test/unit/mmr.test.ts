import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteSimilarity, selectMmr, type FeedItem, type MmrInput } from '../../src/index.js';
import { key } from '../fixtures.js';
const candidate = (id: number, rawRelevance: number) => ({ id: key(id), pubkey: key(100 + id), content: `note ${id}`, createdAt: 0, graphScore: rawRelevance, rawRelevance });
test('MMR calibrates tiny raw relevance against the pool maximum before trading relevance for repetition', () => {
  const items = selectMmr({ candidates: [candidate(1, .01), candidate(2, .0098), candidate(3, .006)],
    vectors: { [key(1)]: [[1, 0]], [key(2)]: [[1, 0]], [key(3)]: [[0, 1]] },
    lambda: .8, candidatePool: 200, limit: 20, similarityPower: 4 });
  assert.deepEqual(items.map(i => i.id), [key(1), key(2), key(3)]);
  assert.equal(items[0].rawRelevance, .01);
  assert.equal(items[0].mmrScore, .8);
  assert.ok(Math.abs(items[1].mmrScore - .584) < 1e-12);
});
test('the relevance pool is bounded before selection, with raw relevance and event ID deciding ties', () => {
  const input = { candidates: [candidate(3, .9), candidate(2, .9), candidate(1, 1), candidate(4, .1)],
    vectors: { [key(1)]: [[1, 0]], [key(2)]: [[1, 0]], [key(3)]: [[0, 1]], [key(4)]: [[0, 1]] },
    lambda: 0, candidatePool: 2, limit: 20, similarityPower: 4 };
  assert.deepEqual(selectMmr(input).map(i => i.id), [key(1), key(2)]);
  assert.deepEqual(selectMmr({ ...input, limit: 1 }).map(i => i.id), [key(1)]);
  assert.deepEqual(selectMmr({ ...input, limit: 0 }), []);
  assert.deepEqual(selectMmr({ ...input, candidates: [] }), []);
});
test('calibration neither stretches the pool minimum to zero nor rescales after a selection', () => {
  const items = selectMmr({ candidates: [candidate(1, 10), candidate(2, 9), candidate(3, 8)],
    vectors: { [key(1)]: [[1, 0, 0]], [key(2)]: [[.5, Math.sqrt(.75), 0]], [key(3)]: [[0, 0, 1]] },
    lambda: .8, candidatePool: 200, limit: 20, similarityPower: 4 });
  assert.deepEqual(items.map(i => i.id), [key(1), key(3), key(2)]);
  assert.ok(Math.abs(items[1].mmrScore - .64) < 1e-12);
  assert.ok(Math.abs(items[2].mmrScore - .62) < 1e-12);
});
test('repetition is the maximum similarity to any selected note, with negative scores still eligible', () => {
  const items = selectMmr({ candidates: [candidate(1, 1), candidate(2, .9), candidate(3, .8), candidate(4, .2)],
    vectors: { [key(1)]: [[1, 0, 0]], [key(2)]: [[0, 1, 0]], [key(3)]: [[1, 0, 0]], [key(4)]: [[0, 0, 1]] },
    lambda: .5, candidatePool: 200, limit: 20, similarityPower: 4 });
  assert.deepEqual(items.map(i => i.id), [key(1), key(2), key(4), key(3)]);
  assert.ok(Math.abs(items[3].mmrScore + .1) < 1e-12);
});
test('lambda zero keeps the first relevance pick, then breaks repetition ties by raw relevance and event ID', () => {
  const items = selectMmr({ candidates: [candidate(3, .8), candidate(4, .9), candidate(2, .8), candidate(1, 1)],
    vectors: Object.fromEntries([1, 2, 3, 4].map(n => [key(n), [[1, 0]]])),
    lambda: 0, candidatePool: 200, limit: 20, similarityPower: 4 });
  assert.deepEqual(items.map(i => i.id), [key(1), key(4), key(2), key(3)]);
  assert.deepEqual(items.map(i => i.mmrScore), [0, -1, -1, -1]);
});
test('lambda endpoints choose relevance only or least repetition after the same first pick', () => {
  const input = { candidates: [candidate(2, .9), candidate(3, .1), candidate(1, 1)],
    vectors: { [key(1)]: [[1, 0]], [key(2)]: [[1, 0]], [key(3)]: [[0, 1]] },
    lambda: 1, candidatePool: 200, limit: 20, similarityPower: 4 };
  const relevance = selectMmr(input);
  assert.deepEqual(relevance.map(i => i.id), [key(1), key(2), key(3)]);
  assert.deepEqual(relevance.map(i => i.mmrScore), [1, .9, .1]);
  assert.deepEqual(selectMmr({ ...input, lambda: 0 }).map(i => i.id), [key(1), key(3), key(2)]);
});
test('zero-score pools use zero calibrated relevance and deterministic event IDs without rejecting repetitions', () => {
  const input = { candidates: [candidate(3, 0), candidate(2, 0), candidate(1, 0)],
    vectors: { [key(1)]: [[1, 0]], [key(2)]: [[1, 0]], [key(3)]: [[0, 1]] },
    lambda: .5, candidatePool: 200, limit: 20, similarityPower: 4 };
  const items = selectMmr(input);
  assert.deepEqual(items.map(i => i.id), [key(1), key(3), key(2)]);
  assert.deepEqual(items.map(i => i.mmrScore), [0, 0, -.5]);
  assert.deepEqual(selectMmr({ ...input, lambda: 1 }).map(i => i.id), [key(1), key(2), key(3)]);
});

// Deliberately recompute the accepted formula against the whole selected set.
// This reference shares only the unchanged public note-similarity primitive.
function bruteForceMmr(input: MmrInput): FeedItem[] {
  const byRelevance = (a: MmrInput['candidates'][number], b: MmrInput['candidates'][number]) =>
    b.rawRelevance - a.rawRelevance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const pool = [...input.candidates].sort(byRelevance).slice(0, input.candidatePool);
  const scale = Math.max(0, ...pool.map(item => item.rawRelevance));
  const selected: FeedItem[] = [];
  while (selected.length < Math.min(input.limit, pool.length)) {
    const available = pool.filter(item => !selected.some(pick => pick.id === item.id));
    const scored = available.map(item => {
      const similarities = selected.map(pick => noteSimilarity(input.vectors[item.id], input.vectors[pick.id], input.similarityPower));
      return { ...item, mmrScore: input.lambda * (scale ? item.rawRelevance / scale : 0) -
        (1 - input.lambda) * Math.max(0, ...similarities) };
    });
    scored.sort((a, b) => b.mmrScore - a.mmrScore || byRelevance(a, b));
    selected.push(scored[0]);
  }
  return selected;
}

test('MMR matches the brute-force accepted formula for multi-chunk pools, ties, zeros and balance endpoints', () => {
  const vectors = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [key(i + 1),
    Array.from({ length: 1 + i % 8 }, (_, chunk) =>
      Array.from({ length: 5 }, (_, axis) => ((i * 13 + chunk * 7 + axis * 3) % 11) - 5))]));
  for (const zeroScores of [false, true]) for (const lambda of [0, .2, .5, 1]) {
    for (const candidatePool of [0, 1, 11, 30]) for (const limit of [0, 1, 7, 24]) {
      const input = { candidates: Array.from({ length: 24 }, (_, i) => candidate(24 - i, zeroScores ? 0 : Math.floor(i / 3) * .00001)),
        vectors, lambda, candidatePool, limit, similarityPower: 4 };
      const original = structuredClone(input);
      assert.deepEqual(selectMmr(input), bruteForceMmr(input), JSON.stringify({ zeroScores, lambda, candidatePool, limit }));
      assert.deepEqual(input, original, 'selection must leave caller-owned candidates and vectors unchanged');
    }
  }
});
