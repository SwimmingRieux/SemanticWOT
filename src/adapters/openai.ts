import type { Embedder, ModelIdentityReader } from '../application/embedding.js';
import { validVectors } from '../core/embedding.js';
import type { FeedError, Result } from '../core/types.js';

export interface OpenAIOptions { endpoint: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number }
export interface OpenAIAdapter { embedder: Embedder; modelIdentityReader: ModelIdentityReader }
const failed = (message: string): Result<never, FeedError> => ({ ok: false, error: { code: 'embedding-failure', message } });
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Remote labels are mutable. The identity is a cache namespace, never a weights digest. */
export function createOpenAIAdapter(options: OpenAIOptions): OpenAIAdapter {
  const request = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint.replace(/\/+$/, '');
  return {
    modelIdentityReader: { async resolve(config) {
      if (!options.apiKey.trim()) return failed('OpenAI requires OPENAI_API_KEY. Configure it on the server before indexing.');
      return { ok: true, value: config.modelVersion === 'default' ? `openai-label:${config.model}` : config.modelVersion };
    } },
    embedder: { async embed(input) {
      if (!options.apiKey.trim()) return failed('OpenAI requires OPENAI_API_KEY. Configure it on the server before indexing.');
      try {
        const response = await request(endpoint + '/embeddings', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify({ ...input, encoding_format: 'float' }), signal: AbortSignal.timeout(options.timeoutMs ?? 60000) });
        // Never echo a remote error body or transport exception: either can contain credentials.
        if (!response.ok) return failed(`OpenAI embeddings failed (HTTP ${response.status}). ${response.status === 401 || response.status === 403 ? 'Check OPENAI_API_KEY and model access.' : response.status === 429 ? 'Check API quota and rate limits, then retry.' : response.status === 404 ? 'Check openaiEndpoint and the configured model.' : 'Check the service and configured model, then retry.'}`);
        const value: unknown = await response.json();
        if (!record(value) || value.model !== input.model || !Array.isArray(value.data) || value.data.length !== input.input.length) return failed('OpenAI returned an invalid embedding response or an unexpected model. Check the configured model and dimensions.');
        const vectors: number[][] = [];
        for (const item of value.data) {
          if (!record(item) || typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0 || item.index >= input.input.length || vectors[item.index] !== undefined || !Array.isArray(item.embedding)) return failed('OpenAI returned invalid or duplicate embedding indexes. Retry with the configured model.');
          vectors[item.index] = item.embedding;
        }
        if (!validVectors(vectors, input.input.length, input.dimensions)) return failed(`OpenAI returned invalid vectors; expected ${input.input.length} finite nonzero vectors with dimensions=${input.dimensions}. Check the configured model and dimensions.`);
        return { ok: true, value: vectors };
      } catch { return failed('Cannot obtain embeddings from OpenAI. Check openaiEndpoint, network access and service availability, then retry.'); }
    } },
  };
}
