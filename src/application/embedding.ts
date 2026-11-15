import { chunkNoteContent, embeddingCacheKey, noteInputPrefix, validVectors } from '../core/embedding.js';
import { compareIds, type ChunkEmbedding, type Diagnostic, type FeedError, type NostrEvent, type Result } from '../core/types.js';
import { resolveConfiguration, type Configuration } from './config.js';
import type { EmbeddingReader, EmbeddingWriter } from './cache.js';

export interface EmbeddingRequest { model: string; input: string[]; dimensions: number }
export interface Embedder { embed(input: EmbeddingRequest): Promise<Result<number[][], FeedError>> }
export interface Progress { report(diagnostic: Diagnostic): void }
export interface ModelIdentityReader { resolve(config: Configuration): Promise<Result<string, FeedError>> }
export interface EmbedCachedNotesInput { notes: NostrEvent[]; embeddings: ChunkEmbedding[]; config: Configuration }
export interface EmbeddingPorts { embedder: Embedder; embeddingWriter: EmbeddingWriter; progress: Progress }
const failure = (message: string): Result<never, FeedError> => ({ ok: false, error: { code: 'embedding-failure', message } });

/** Library indexing path: no viewer or relay is needed to prepare cached note vectors. */
export async function embedCachedNotes(input: EmbedCachedNotesInput, ports: EmbeddingPorts): Promise<Result<ChunkEmbedding[], FeedError>> {
  const { config } = input;
  const checked = resolveConfiguration({ file: { ...config } });
  if (!checked.ok) return failure(checked.error.message);
  if (config.modelVersion === 'default') return failure('Resolve a modelVersion (Ollama digest or remote model label/version) before embedding cached notes, or use createEmbeddingHook.');
  if (config.model.startsWith('nomic-embed-text') && config.chunkTokens + noteInputPrefix.length + 5 > 2048) return failure('nomic-embed-text chunks plus the clustering prefix and special-token allowance must fit the 2048-token context. Lower chunkTokens.');
  const compatible = new Map(input.embeddings.filter(value => value.cacheKey).map(value => [value.cacheKey!, value]));
  const output: ChunkEmbedding[] = [];
  let reused: ChunkEmbedding[] = [];
  async function persistReused(): Promise<Result<number, FeedError>> {
    if (!reused.length) return { ok: true, value: 0 };
    const batch = reused;
    reused = [];
    return ports.embeddingWriter.put(batch);
  }
  for (const note of [...input.notes].filter(note => note.kind === 1).sort((a, b) => compareIds(a.id, b.id))) {
    const cacheKey = embeddingCacheKey(note.content, config), chunks = chunkNoteContent(note.content, config);
    let cached = compatible.get(cacheKey);
    if (cached && !validVectors(cached.vectors, chunks.length, config.dimensions)) cached = undefined;
    let vectors: number[][];
    if (cached) {
      vectors = cached.vectors;
      ports.progress.report({ code: 'embedding-cache-hit', message: `Reused ${chunks.length} chunks for note ${note.id}.`, eventId: note.id });
    } else {
      // Keep reuse/LRU ordering, and surface cache errors before starting new work.
      const written = await persistReused();
      if (!written.ok) return written;
      vectors = [];
      for (let offset = 0; offset < chunks.length; offset += config.batchSize) {
        const batch = chunks.slice(offset, offset + config.batchSize).map(chunk => noteInputPrefix + chunk);
        const result = await ports.embedder.embed({ model: config.model, dimensions: config.dimensions, input: batch });
        if (!result.ok) return result;
        if (!validVectors(result.value, batch.length, config.dimensions)) return failure(`Embedding model ${config.model} returned invalid vectors: expected ${batch.length} nonzero finite ${config.dimensions}-dimensional vectors. Check the configured model and dimensions.`);
        vectors.push(...result.value);
        ports.progress.report({ code: 'embedding-batch', message: `Embedded ${vectors.length}/${chunks.length} chunks for note ${note.id}.`, eventId: note.id });
      }
    }
    const value = { noteId: note.id, model: config.model, modelVersion: config.modelVersion, cacheKey, vectors };
    if (cached) reused.push(value);
    else {
      // Newly computed work remains durable before the next model request.
      const written = await ports.embeddingWriter.put([value]);
      if (!written.ok) return written;
    }
    compatible.set(cacheKey, value);
    output.push(value);
  }
  const written = await persistReused();
  if (!written.ok) return written;
  return { ok: true, value: output };
}

export function createEmbeddingHook(ports: EmbeddingPorts & { embeddingReader: EmbeddingReader; modelIdentityReader: ModelIdentityReader }) {
  return { async prepare(input: { notes: NostrEvent[]; config: Configuration }): Promise<Result<ChunkEmbedding[], FeedError>> {
    if (!input.notes.length) return { ok: true, value: [] };
    const identity = await ports.modelIdentityReader.resolve(input.config);
    if (!identity.ok) return identity;
    const cached = await ports.embeddingReader.get();
    if (!cached.ok) return cached;
    return embedCachedNotes({ ...input, config: { ...input.config, modelVersion: identity.value }, embeddings: cached.value }, ports);
  } };
}
