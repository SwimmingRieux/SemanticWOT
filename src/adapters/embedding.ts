import type { Embedder, ModelIdentityReader } from '../application/embedding.js';
import type { Configuration, ConfigurationError } from '../application/config.js';
import type { Result } from '../core/types.js';
import { createOllamaAdapter } from './ollama.js';
import { createOpenAIAdapter } from './openai.js';

export interface EmbeddingAdapter { embedder: Embedder; modelIdentityReader: ModelIdentityReader }
export interface EmbeddingAdapterOptions { config: Configuration; apiKey?: string; fetch?: typeof fetch; timeoutMs?: number }
/** Credentials enter only composition, never serializable ranking configuration. */
export function createEmbeddingAdapter(options: EmbeddingAdapterOptions): Result<EmbeddingAdapter, ConfigurationError> {
  const { config } = options;
  if (config.provider === 'ollama' && !config.ollamaConfigured) return { ok: false, error: { code: 'invalid-config', message: 'Ollama requires an explicitly configured endpoint. Set endpoint or WOT_ENDPOINT before indexing.' } };
  if (config.provider === 'ollama') return { ok: true, value: createOllamaAdapter({ ...options, endpoint: config.endpoint, provider: 'ollama' }) };
  if (config.provider !== 'openai') return { ok: false, error: { code: 'invalid-config', message: 'No built-in embedding adapter for this provider. Inject an Embedder and ModelIdentityReader for a custom provider.' } };
  if (options.apiKey !== undefined && (!options.apiKey.trim() || /\s/.test(options.apiKey))) return { ok: false, error: { code: 'invalid-config', message: 'OPENAI_API_KEY must be a nonempty credential without whitespace.' } };
  return { ok: true, value: createOpenAIAdapter({ ...options, endpoint: config.openaiEndpoint, apiKey: options.apiKey ?? '' }) };
}
