import { compareIds, type Edge, type Graph, type NostrEvent, type RankingConfig, type Zap } from './types.js';
import { noteSimilarity } from './similarity.js';
export interface GraphInput { notes: NostrEvent[]; zaps: Zap[]; vectors: Record<string, number[][]>; config: RankingConfig }
export interface CoZapInput { noteIds: string[]; zaps: Zap[]; maxEdges: number }
export function buildCoZapPairs(input: CoZapInput): { pairs: Omit<Edge, 'similarity'>[]; truncated: boolean } {
  const nodes = [...input.noteIds].sort(compareIds);
  const allowed = new Set(nodes);
  const curators = new Map<string, Map<string, bigint>>();
  for (const zap of input.zaps) {
    if (!allowed.has(zap.target)) continue;
    const amounts = curators.get(zap.sender) ?? new Map<string, bigint>();
    amounts.set(zap.target, (amounts.get(zap.target) ?? 0n) + zap.amountMsat); curators.set(zap.sender, amounts);
  }
  let truncated = false;
  const pairs = new Map<string, { a: string; b: string; strength: bigint }>();
  // Keep a deterministic bounded set of canonical pairs; existing pairs still receive all evidence.
  for (const sender of [...curators.keys()].sort(compareIds)) {
    const amounts = curators.get(sender)!;
    const ids = [...amounts.keys()].sort(compareIds);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j], id = `${a}:${b}`;
      if (!pairs.has(id) && pairs.size >= input.maxEdges) { truncated = true; continue; }
      const contribution = amounts.get(a)! < amounts.get(b)! ? amounts.get(a)! : amounts.get(b)!;
      pairs.set(id, { a, b, strength: (pairs.get(id)?.strength ?? 0n) + contribution });
    }
  }
  return { pairs: [...pairs.values()].sort((a, b) => compareIds(a.a, b.a) || compareIds(a.b, b.b)), truncated };
}
export function buildGraph(input: GraphInput): Graph {
  const nodes = input.notes.map(n => n.id).sort(compareIds).slice(0, input.config.maxCandidates);
  const { pairs, truncated } = buildCoZapPairs({ noteIds: nodes, zaps: input.zaps, maxEdges: input.config.maxEdges });
  const edges: Edge[] = pairs.map(pair => ({ ...pair, similarity: noteSimilarity(input.vectors[pair.a], input.vectors[pair.b], input.config.similarityPower) }));
  return { nodes, edges, truncated };
}
export interface SeedInput { viewer: string; zaps: Zap[]; noteIds: string[]; now: number; halfLifeDays: number }
export function deriveSeeds(input: SeedInput): Record<string, number> {
  const allowed = new Set(input.noteIds), scores = new Map<string, number>();
  for (const zap of input.zaps) if (zap.sender === input.viewer && allowed.has(zap.target)) {
    const value = Math.log1p(Number(zap.amountMsat) / 1000) * 2 ** (-Math.max(0, input.now - zap.createdAt) / (input.halfLifeDays * 86400));
    scores.set(zap.target, (scores.get(zap.target) ?? 0) + value);
  }
  const sum = [...scores.values()].reduce((a, b) => a + b, 0);
  return Object.fromEntries([...scores.entries()].sort(([a], [b]) => compareIds(a, b)).filter(([, v]) => v > 0).map(([id, value]) => [id, value / sum]));
}
