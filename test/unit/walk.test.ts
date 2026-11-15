import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveWalk, type WalkInput } from '../../src/core/walk.js';

test('a weak sole exit retains absolute semantic weakness in stationary visits', () => {
  const result = solveWalk({ nodes: ['a', 'b'], edges: [{ a: 'a', b: 'b', strength: 100n, similarity: 0.1 }], seeds: { a: 1 }, alpha: 0.15, epsilon: 1e-10, maxPushesPerNode: 10000 });
  assert.equal(result.reason, 'converged');
  assert.ok(Math.abs(result.scores.b - 0.0783410138248848) < 1e-8);
  assert.ok(result.residual < 1e-10);
});

// Independent full-K stationary iteration; deliberately does not use local push/deposits.
function dense(nodes: string[], edges: { a: string; b: string; strength: bigint; similarity: number }[], seeds: Record<string, number>, alpha: number) {
  const z = nodes.map(id => seeds[id] ?? 0), totals = nodes.map(id => edges.reduce((s, e) => s + (e.a === id || e.b === id ? Number(e.strength) : 0), 0));
  const matrix = nodes.map((from, i) => {
    const continuations = nodes.map(to => edges.reduce((s, e) => s + ((e.a === from && e.b === to) || (e.b === from && e.a === to) ? (1 - alpha) * Number(e.strength) / totals[i] * e.similarity : 0), 0));
    const restart = 1 - continuations.reduce((a, b) => a + b, 0);
    return continuations.map((v, j) => v + restart * z[j]);
  });
  let p = [...z];
  for (let t = 0; t < 1000; t++) {
    const next = nodes.map((_, j) => p.reduce((s, v, i) => s + v * matrix[i][j], 0));
    if (next.reduce((s, v, i) => s + Math.abs(v - p[i]), 0) < 1e-14) { p = next; break; }
    p = next;
  }
  return { p, matrix };
}
const scenarios: (Pick<WalkInput, 'nodes' | 'edges' | 'seeds'> & { name: string })[] = [
  { name: 'weak-only exit', nodes: ['a', 'b'], edges: [{ a: 'a', b: 'b', strength: 100n, similarity: .1 }], seeds: { a: 1 } },
  { name: 'weak topic bridge', nodes: ['a', 'b', 'c', 'd'], edges: [{ a: 'a', b: 'b', strength: 10n, similarity: 1 }, { a: 'b', b: 'c', strength: 10n, similarity: .01 }, { a: 'c', b: 'd', strength: 10n, similarity: 1 }], seeds: { a: 1 } },
  { name: 'multiple seeds and dangling note', nodes: ['a', 'b', 'c'], edges: [{ a: 'a', b: 'b', strength: 10n, similarity: .4 }], seeds: { a: .6, c: .4 } },
  { name: 'inaccessible component', nodes: ['a', 'b', 'c', 'd'], edges: [{ a: 'a', b: 'b', strength: 10n, similarity: .8 }, { a: 'c', b: 'd', strength: 100n, similarity: 1 }], seeds: { a: 1 } },
  { name: 'zero-edge graph', nodes: ['a', 'b'], edges: [], seeds: { a: .25, b: .75 } },
];
for (const scenario of scenarios) test(`local push agrees with stationary K for ${scenario.name}`, () => {
  const input = { ...scenario, alpha: .15, epsilon: 1e-9, maxPushesPerNode: 10000 };
  const result = solveWalk(input), reference = dense(input.nodes, input.edges, input.seeds, input.alpha);
  const p = input.nodes.map(id => result.scores[id]);
  const error = p.reduce((s, v, i) => s + Math.abs(v - reference.p[i]), 0);
  const stationaryError = p.reduce((s, v, j) => s + Math.abs(v - p.reduce((sum, value, i) => sum + value * reference.matrix[i][j], 0)), 0);
  assert.ok(error <= result.normalizedErrorBound + 1e-12);
  assert.ok(stationaryError < 1e-7);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.equal(result.reason, 'converged');
});
test('a safety cap reports nonconvergence with the remaining residual and an honest error bound', () => {
  const input = { nodes: ['a', 'b'], edges: [{ a: 'a', b: 'b', strength: 10n, similarity: 1 }], seeds: { a: 1 }, alpha: .15, epsilon: 1e-12, maxPushesPerNode: 1 };
  const result = solveWalk(input);
  assert.equal(result.reason, 'safety-cap');
  assert.ok(result.residual > .7);
  assert.ok(result.normalizedErrorBound > .1);
  assert.equal(result.pushes, 2);
});
