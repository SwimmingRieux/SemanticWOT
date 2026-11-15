import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteSimilarity } from '../../src/core/similarity.js';
test('chunk similarity is symmetric, bounded, and ignores negative cosine evidence', () => {
  const a = [[1, 0], [0, 1]], b = [[1, 0]];
  assert.ok(Math.abs(noteSimilarity(a, b) - 0.9204482076268572) < 1e-12);
  assert.equal(noteSimilarity(a, b), noteSimilarity(b, a));
  assert.equal(noteSimilarity([[1, 0]], [[-1, 0]]), 0);
  assert.equal(noteSimilarity([[0, 0]], [[1, 0]]), 0);
});
