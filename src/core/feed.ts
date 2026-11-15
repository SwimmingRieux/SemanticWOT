import { buildGraph, deriveSeeds } from './graph.js';
import { solveWalk } from './walk.js';
import { compareIds, type Diagnostic, type FeedError, type FeedItem, type FeedOutput, type NostrEvent, type RankingConfig, type RelevanceItem, type Result, type Snapshot, type Zap } from './types.js';
import { noteSimilarity } from './similarity.js';
import { chunkNoteContent, embeddingCacheKey, validVectors } from './embedding.js';
export interface RankInput { notes: NostrEvent[]; scores: Record<string, number>; now: number; halfLifeDays: number; candidatePool: number; limit: number }
export function rankRelevance(input: RankInput): RelevanceItem[] {
  return input.notes.map(n => ({ id: n.id, pubkey: n.pubkey, content: n.content, createdAt: n.created_at, graphScore: input.scores[n.id] ?? 0,
    rawRelevance: (input.scores[n.id] ?? 0) * 2 ** (-Math.max(0, input.now - n.created_at) / (input.halfLifeDays * 86400)) }))
    .sort((a, b) => b.rawRelevance - a.rawRelevance || compareIds(a.id, b.id)).slice(0, input.candidatePool).slice(0, input.limit);
}
export interface MmrInput {
  candidates: RelevanceItem[]; vectors: Record<string, number[][]>;
  lambda: number; candidatePool: number; limit: number; similarityPower: number;
}
export function selectMmr(input: MmrInput): FeedItem[] {
  const remaining = [...input.candidates].sort((a, b) => b.rawRelevance - a.rawRelevance || compareIds(a.id, b.id)).slice(0, input.candidatePool)
    .map(candidate => ({ candidate, repetition: 0 }));
  const maximum = remaining[0]?.candidate.rawRelevance ?? 0;
  const selected: FeedItem[] = [];
  while (remaining.length && selected.length < input.limit) {
    const score = (item: typeof remaining[number]) => input.lambda * (maximum ? item.candidate.rawRelevance / maximum : 0) -
      (1 - input.lambda) * item.repetition;
    let best = 0, bestScore = score(remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const value = score(remaining[i]);
      if (value > bestScore) { best = i; bestScore = value; }
    }
    const picked = remaining.splice(best, 1)[0].candidate;
    selected.push({ ...picked, mmrScore: bestScore });
    // Each pair contributes once; the maximum over all selected notes is unchanged.
    if (selected.length < input.limit) for (const item of remaining) {
      item.repetition = Math.max(item.repetition, noteSimilarity(input.vectors[item.candidate.id], input.vectors[picked.id], input.similarityPower));
    }
  }
  return selected;
}
export interface CandidateInput { viewer: string; snapshot: Snapshot; zaps: Zap[]; now: number; config: RankingConfig }
/** Shared admission boundary for production ranking and snapshot baselines. */
export function eligibleCandidates(input: CandidateInput) {
  const { viewer, snapshot, now, config } = input;
  const allNotes = snapshot.events.filter(e => e.kind === 1);
  const allSeeds = deriveSeeds({ viewer, zaps: input.zaps, noteIds: allNotes.map(n => n.id), now, halfLifeDays: config.seedHalfLifeDays });
  const notes = allNotes.sort((a, b) => (allSeeds[b.id] ?? 0) - (allSeeds[a.id] ?? 0) || compareIds(a.id, b.id)).slice(0, config.maxCandidates).sort((a, b) => compareIds(a.id, b.id));
  const seeds = deriveSeeds({ viewer, zaps: input.zaps, noteIds: notes.map(n => n.id), now, halfLifeDays: config.seedHalfLifeDays });
  return { notes, seeds, totalNotes: allNotes.length };
}
export interface BuildFeedInput { viewer: string; snapshot: Snapshot; zaps: Zap[]; diagnostics: Diagnostic[]; now: number; config: RankingConfig }
export interface PreparedFeed { output: Omit<FeedOutput, 'items'>; candidates: RelevanceItem[]; vectors: Record<string, number[][]> }
/** Graph construction and walk are independent of the MMR diversity setting. */
export function prepareFeed(input: BuildFeedInput): Result<PreparedFeed, FeedError> {
  const { viewer, snapshot, now, config } = input;
  const { notes, seeds, totalNotes } = eligibleCandidates(input);
  const diagnostics = [...input.diagnostics];
  if (totalNotes > notes.length) diagnostics.push({ code: 'candidate-cap', message: `Candidate notes were truncated to ${config.maxCandidates}; seeds take priority, then ascending event ID.` });
  if (!Object.keys(seeds).length) {
    diagnostics.push({ code: 'no-seeds', message: 'No usable viewer-sent note zaps were found in the cache.' });
    return { ok: true, value: { candidates: [], vectors: {}, output: { viewer, generatedAt: now, indexedAt: snapshot.indexedAt, selection: 'mmr', diagnostics,
      counts: { seeds: 0, notes: notes.length, edges: 0, receipts: input.zaps.length, embeddings: 0 },
      walk: solveWalk({ nodes: [], edges: [], seeds: {}, ...config }) } } };
  }
  const vectors: Record<string, number[][]> = {};
  const modelVersions = new Set<string>();
  for (const note of notes) {
    const embedding = snapshot.embeddings.find(embedding => embedding.noteId === note.id && embedding.model === config.model &&
      Boolean(embedding.modelVersion) && embedding.cacheKey === embeddingCacheKey(note.content, { ...config,
        provider: config.provider ?? 'ollama', processingVersion: config.processingVersion ?? 'chunks-v1',
        modelVersion: !config.modelVersion || config.modelVersion === 'default' ? embedding.modelVersion! : config.modelVersion }));
    if (embedding) { vectors[note.id] = embedding.vectors; modelVersions.add(embedding.modelVersion!); }
  }
  if (modelVersions.size > 1) return { ok: false, error: { code: 'missing-embeddings', message: `Cached embeddings use more than one model identity for ${config.model}. Run wot index with one configured embedding model to finish rebuilding compatible vectors.` } };
  for (const note of notes) if (!vectors[note.id] || !validVectors(vectors[note.id], chunkNoteContent(note.content, config).length, config.dimensions)) {
    return { ok: false, error: { code: 'missing-embeddings', message: `Missing or incompatible cached embeddings for note ${note.id} and model ${config.model}. Run wot index with the configured embedding model.` } };
  }
  const graph = buildGraph({ notes, zaps: input.zaps, vectors, config });
  if (graph.truncated) diagnostics.push({ code: 'edge-cap', message: `Co-zap edges were truncated to ${config.maxEdges}; numerical residual bounds apply only to this fixed graph.` });
  const walk = solveWalk({ ...graph, seeds, ...config });
  if (walk.reason === 'safety-cap') diagnostics.push({ code: 'walk-safety-cap', message: `Walk stopped at the per-node push cap with residual ${walk.residual}.` });
  const candidates = rankRelevance({ notes, scores: walk.scores, now, halfLifeDays: config.noteHalfLifeDays, candidatePool: config.candidatePool, limit: config.candidatePool });
  return { ok: true, value: { candidates, vectors, output: { viewer, generatedAt: now, indexedAt: snapshot.indexedAt, selection: 'mmr', diagnostics,
    counts: { seeds: Object.keys(seeds).length, notes: notes.length, edges: graph.edges.length, receipts: input.zaps.length, embeddings: notes.length }, walk } } };
}

export function selectPreparedFeed(prepared: PreparedFeed, config: RankingConfig): FeedOutput {
  return { ...prepared.output, items: selectMmr({ candidates: prepared.candidates, vectors: prepared.vectors, ...config }) };
}
export function buildFeed(input: BuildFeedInput): Result<FeedOutput, FeedError> {
  const prepared = prepareFeed(input);
  return prepared.ok ? { ok: true, value: selectPreparedFeed(prepared.value, input.config) } : prepared;
}
