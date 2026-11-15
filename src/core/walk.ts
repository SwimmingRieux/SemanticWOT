import { compareIds, type Edge, type WalkResult } from './types.js';
export interface WalkInput { nodes: string[]; edges: Edge[]; seeds: Record<string, number>; alpha: number; epsilon: number; maxPushesPerNode: number }

/** Fixed-alpha deposits estimate discounted visits; normalization gives stationary visits of K. */
export function solveWalk(input: WalkInput): WalkResult {
  const nodes = [...input.nodes].sort(compareIds);
  const index = new Map(nodes.map((id, i) => [id, i]));
  const rows: { to: number; strength: number; similarity: number }[][] = nodes.map(() => []);
  for (const edge of input.edges) {
    const a = index.get(edge.a), b = index.get(edge.b);
    if (a === undefined || b === undefined || edge.strength <= 0n) continue;
    rows[a].push({ to: b, strength: Number(edge.strength), similarity: edge.similarity });
    rows[b].push({ to: a, strength: Number(edge.strength), similarity: edge.similarity });
  }
  const transitions = rows.map(row => {
    const sum = row.reduce((s, e) => s + e.strength, 0);
    return row.sort((a, b) => a.to - b.to).map(e => ({ to: e.to, value: (1 - input.alpha) * e.strength / sum * e.similarity }));
  });
  const totalSeed = nodes.reduce((sum, id) => sum + (input.seeds[id] ?? 0), 0);
  const residual = nodes.map(id => totalSeed ? (input.seeds[id] ?? 0) / totalSeed : 0);
  const b = nodes.map(() => 0), counts = nodes.map(() => 0);
  let pushes = 0, reason: WalkResult['reason'] = 'converged';
  let remaining = residual.reduce((a, v) => a + v, 0);
  while (remaining >= input.epsilon) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (residual[i] > 0 && counts[i] < input.maxPushesPerNode && (u < 0 || residual[i] > residual[u])) u = i;
    if (u < 0) { reason = 'safety-cap'; break; }
    const d = residual[u]; residual[u] = 0;
    b[u] += input.alpha * d; counts[u]++; pushes++;
    for (const t of transitions[u]) residual[t.to] += d * t.value;
    remaining = residual.reduce((a, v) => a + v, 0);
  }
  const accumulated = b.reduce((a, v) => a + v, 0);
  return { scores: Object.fromEntries(nodes.map((id, i) => [id, accumulated ? b[i] / accumulated : 0])), pushes, residual: remaining, accumulated,
    normalizedErrorBound: accumulated + remaining ? Math.min(2, 2 * remaining / (accumulated + remaining)) : 0, reason };
}
