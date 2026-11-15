import type { RankingConfig } from './types.js';

export type ChunkConfiguration = Pick<RankingConfig, 'chunkTokens' | 'chunkOverlap' | 'maxChunks'>;
export interface EmbeddingConfiguration extends ChunkConfiguration {
  model: string; dimensions: number; provider: string; modelVersion: string; processingVersion: string;
}
export const noteInputPrefix = 'clustering: ';
/** Canonical collision-free identity; content itself avoids an ambient hash capability. */
export function embeddingCacheKey(content: string, config: EmbeddingConfiguration): string {
  return JSON.stringify(['semantic-wot-embedding-v1', content, config.provider, config.model, config.modelVersion, config.dimensions,
    config.processingVersion, 'utf8-bytes-v1', noteInputPrefix, config.chunkTokens, config.chunkOverlap, config.maxChunks]);
}
export function validVectors(vectors: number[][], count: number, dimensions: number): boolean {
  return vectors.length === count && vectors.every(vector => Array.isArray(vector) && vector.length === dimensions &&
    vector.every(value => typeof value === 'number' && Number.isFinite(value)) && vector.some(value => value !== 0));
}
const byteLength = (character: string): number => {
  const code = character.codePointAt(0)!;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
};
/** Conservative UTF-8 byte tokens; boundaries always preserve Unicode scalars. */
export function chunkNoteContent(content: string, config: ChunkConfiguration): string[] {
  if (!content) return [''];
  const characters = Array.from(content), chunks: string[] = [];
  let start = 0;
  while (start < characters.length && chunks.length < config.maxChunks) {
    let end = start, bytes = 0;
    while (end < characters.length && bytes + byteLength(characters[end]) <= config.chunkTokens) bytes += byteLength(characters[end++]);
    // A scalar wider than the requested budget remains intact.
    if (end === start) end++;
    chunks.push(characters.slice(start, end).join(''));
    if (end === characters.length) break;
    let next = end, overlap = 0;
    while (next > start + 1 && overlap + byteLength(characters[next - 1]) <= config.chunkOverlap) overlap += byteLength(characters[--next]);
    start = next;
  }
  return chunks;
}
