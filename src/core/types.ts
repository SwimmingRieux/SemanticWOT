export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export interface NostrEvent { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig?: string }
export interface Diagnostic { code: string; message: string; eventId?: string }
export interface Zap { paymentId?: string; kind: 9735; id: string; sender: string; target: string; amountMsat: bigint; createdAt: number }
export interface ChunkEmbedding { cacheKey?: string; modelVersion?: string; noteId: string; model: string; vectors: number[][] }
export interface Snapshot { graphVersion?: string; indexRecords?: IndexRecord[]; events: NostrEvent[]; embeddings: ChunkEmbedding[]; indexedAt: number }
export interface Edge { a: string; b: string; strength: bigint; similarity: number }
export interface Graph { nodes: string[]; edges: Edge[]; truncated: boolean }
export interface RankingConfig {
  provider?: string; modelVersion?: string; processingVersion?: string;
  alpha: number; epsilon: number; maxPushesPerNode: number;
  seedHalfLifeDays: number; noteHalfLifeDays: number; candidatePool: number; limit: number; lambda: number;
  maxCandidates: number; maxEdges: number; model: string; dimensions: number;
  chunkTokens: number; chunkOverlap: number; maxChunks: number; similarityPower: number;
}
export const defaultRankingConfig: Readonly<RankingConfig> = Object.freeze({
  alpha: 0.15, epsilon: 1e-4, maxPushesPerNode: 10000,
  seedHalfLifeDays: 30, noteHalfLifeDays: 180, candidatePool: 200, limit: 20, lambda: 0.5,
  maxCandidates: 5000, maxEdges: 20000, model: 'nomic-embed-text', dimensions: 768,
  chunkTokens: 500, chunkOverlap: 64, maxChunks: 8, similarityPower: 4,
});
export interface RelevanceItem { id: string; pubkey: string; content: string; createdAt: number; graphScore: number; rawRelevance: number }
export interface FeedItem extends RelevanceItem { mmrScore: number }
export interface WalkResult {
  scores: Record<string, number>; pushes: number; residual: number; accumulated: number;
  normalizedErrorBound: number; reason: 'converged' | 'safety-cap';
}
export interface FeedOutput {
  viewer: string; generatedAt: number; indexedAt: number; selection: 'mmr'; items: FeedItem[];
  diagnostics: Diagnostic[]; counts: { seeds: number; notes: number; edges: number; receipts: number; embeddings: number };
  walk: WalkResult;
}
export interface FeedError { code: 'relay-failure' | 'invalid-input' | 'missing-cache' | 'missing-embeddings' | 'cache-failure' | 'embedding-failure'; message: string }
export const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface IndexRecord { eventId?: string; relay: string; scope: string; observedAt: number; complete?: boolean; diagnostic?: Diagnostic; zap?: Omit<Zap, 'amountMsat'> & { amountMsat: string } }
