import type { ChunkEmbedding, FeedError, NostrEvent, Result } from '../core/types.js';
export interface EventWriter { put(events: NostrEvent[]): Promise<Result<number, FeedError>> }
export interface EventReader { get(ids: readonly string[]): Promise<Result<NostrEvent[], FeedError>> }
export interface EmbeddingWriter { put(embeddings: ChunkEmbedding[]): Promise<Result<number, FeedError>> }
export interface EmbeddingReader { get(): Promise<Result<ChunkEmbedding[], FeedError>> }
export interface IndexedAtWriter { put(timestamp: number): Promise<Result<number, FeedError>> }
export interface CacheTableUsage { rows: number; bytes: number }
export interface CacheStats {
  tables: Record<string, CacheTableUsage>;
  totalBytes: number;
  immutableBytes: number;
  databaseBytes: number;
  allocatedBytes: number;
}
export interface CacheStatsReader { get(): Promise<Result<CacheStats, FeedError>> }
export interface CachePruneInput { maxBytes?: number }
export interface CachePruneOutput { maxBytes: number; before: CacheStats; after: CacheStats; evicted: { events: number; embeddings: number }; invalidated: boolean }
export interface CachePruner { prune(input: CachePruneInput): Promise<Result<CachePruneOutput, FeedError>> }
