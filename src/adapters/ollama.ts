import type { Embedder, ModelIdentityReader } from '../application/embedding.js';
import { validVectors } from '../core/embedding.js';
import type { FeedError, Result } from '../core/types.js';

export interface OllamaOptions { endpoint: string; provider: string; fetch?: typeof fetch; timeoutMs?: number }
export interface OllamaAdapter { embedder: Embedder; modelIdentityReader: ModelIdentityReader }
const failed = (message: string): Result<never, FeedError> => ({ ok: false, error: { code: 'embedding-failure', message } });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function createOllamaAdapter(options: OllamaOptions): OllamaAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint.replace(/\/+$/, '');
  async function json(path: string, body?: unknown): Promise<Result<unknown, FeedError>> {
    if (options.provider !== 'ollama') return failed(`Provider ${options.provider} has no configured embedding adapter. Configure provider=ollama or inject an Embedder.`);
    try {
      const response = await request(endpoint + path, { method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60000) });
      const value: unknown = await response.json();
      if (!response.ok || (record(value) && typeof value.error === 'string')) return failed(`Ollama ${endpoint}${path} failed (${response.status}): ${record(value) ? String(value.error ?? 'invalid response') : 'invalid response'}. Start Ollama and install the configured embedding model with ollama pull <model>.`);
      return { ok: true, value };
    } catch (error) { return failed(`Cannot obtain embeddings from Ollama at ${endpoint}: ${error instanceof Error ? error.message : String(error)}. Start Ollama, check endpoint, and run ollama pull <model>.`); }
  }
  return {
    embedder: { async embed(input) {
      const result = await json('/api/embed', { ...input, truncate: false });
      if (!result.ok) return result;
      const value = result.value;
      if (!record(value) || !Array.isArray(value.embeddings) || !validVectors(value.embeddings, input.input.length, input.dimensions)) return failed(`Ollama model ${input.model} returned invalid embeddings; expected ${input.input.length} finite nonzero vectors with dimensions=${input.dimensions}. Check the model and configured dimensions.`);
      return { ok: true, value: value.embeddings };
    } },
    modelIdentityReader: { async resolve(config) {
      const result = await json('/api/tags');
      if (!result.ok) return result;
      const value = result.value;
      const name = config.model.includes(':') ? config.model : config.model + ':latest';
      const model = record(value) && Array.isArray(value.models) ? value.models.find((model: unknown) => record(model) && (model.name === name || model.name === config.model || model.model === name)) : undefined;
      if (!record(model) || typeof model.digest !== 'string' || !model.digest) return failed(`Ollama model ${config.model} is not installed at ${endpoint} or has no immutable digest. Run ollama pull ${config.model}, then retry indexing.`);
      if (config.modelVersion !== 'default' && config.modelVersion !== model.digest) return failed(`Configured modelVersion ${config.modelVersion} does not match installed Ollama digest ${model.digest} for ${config.model}. Pin the installed digest or install the expected model.`);
      return { ok: true, value: model.digest };
    } },
  };
}
