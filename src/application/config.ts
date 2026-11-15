import { defaultRankingConfig, type RankingConfig, type Result } from '../core/types.js';

/** Resolved values only: no process environment, paths or TOML parser enter the core. */
export interface Configuration extends RankingConfig {
  lambda: number;
  provider: string; modelVersion: string; processingVersion: string; endpoint: string; openaiEndpoint: string; ollamaConfigured: boolean; batchSize: number;
  relays: readonly string[]; maxRelays: number; relayTimeoutMs: number; relayPageSize: number; maxRelayPages: number; relayConcurrency: number;
  maxCoZappers: number; maxZapsPerCoZapper: number; maxSeedZaps: number;
  collectionTtlSeconds: number; rankingTtlSeconds: number; refreshOverlapSeconds: number;
  cacheMaxBytes: number; cachePath: string; compact: boolean; json: boolean;
  offline: boolean; refresh: boolean;
}
export interface ConfigurationError { code: 'invalid-config'; message: string }
export interface ConfigurationInput {
  file?: Record<string, unknown>;
  environment?: Record<string, string | undefined>;
  flags?: Record<string, unknown>;
}
export const defaultConfiguration: Readonly<Configuration> = Object.freeze({
  ...defaultRankingConfig, lambda: 0.5,
  provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536, modelVersion: 'default', processingVersion: 'chunks-v1', endpoint: 'http://127.0.0.1:11434', openaiEndpoint: 'https://api.openai.com/v1', ollamaConfigured: false, batchSize: 32,
  relays: Object.freeze(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nostr.wine', 'wss://relay.snort.social']),
  maxRelays: 1, relayTimeoutMs: 10000, relayPageSize: 500, maxRelayPages: 100, relayConcurrency: 8,
  maxCoZappers: 50, maxZapsPerCoZapper: 200, maxSeedZaps: 10000,
  collectionTtlSeconds: 300, rankingTtlSeconds: 300, refreshOverlapSeconds: 300,
  cacheMaxBytes: 2_000_000_000, cachePath: 'wot.sqlite', compact: false, json: true,
  offline: false, refresh: false,
});
export function configurationEnvironmentName(key: string): string {
  return 'WOT_' + key.replace(/[A-Z]/g, letter => '_' + letter).toUpperCase();
}
export function configurationFlagName(key: string): string {
  return key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
}
const invalid = (message: string): Result<never, ConfigurationError> => ({ ok: false, error: { code: 'invalid-config', message } });
const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const fractions = new Set(['alpha', 'epsilon', 'lambda']);
const positiveReals = new Set(['seedHalfLifeDays', 'noteHalfLifeDays', 'similarityPower']);
const nonnegativeIntegers = new Set(['limit', 'chunkOverlap', 'refreshOverlapSeconds']);
function validUrl(value: string, protocols: string[]): boolean {
  try { const url = new URL(value); return protocols.includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
function resolveEntry(key: string, value: unknown, textual: boolean): Result<unknown, ConfigurationError> {
  const fallback = defaultConfiguration[key as keyof Configuration];
  if (textual && typeof value === 'string') {
    if (typeof fallback === 'number') value = decimal.test(value) ? Number(value) : NaN;
    else if (typeof fallback === 'boolean') value = value === 'true' ? true : value === 'false' ? false : value;
    else if (Array.isArray(fallback)) value = value.split(',').map(item => item.trim());
  }
  if (typeof fallback === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return invalid(`${key} must be a finite number.`);
    if (fractions.has(key)) {
      const valid = key === 'lambda' ? value >= 0 && value <= 1 : key === 'alpha' ? value > 0 && value <= 1 : value > 0 && value < 1;
      if (!valid) return invalid(`${key} must be ${key === 'lambda' ? 'in [0,1]' : key === 'alpha' ? 'in (0,1]' : 'in (0,1)'}.`);
    } else if (positiveReals.has(key)) {
      if (value <= 0) return invalid(`${key} must be positive.`);
    } else if (!Number.isSafeInteger(value) || value < (nonnegativeIntegers.has(key) ? 0 : 1)) {
      return invalid(`${key} must be a ${nonnegativeIntegers.has(key) ? 'nonnegative' : 'positive'} safe integer.`);
    }
  } else if (typeof fallback === 'boolean') {
    if (typeof value !== 'boolean') return invalid(`${key} must be true or false.`);
  } else if (Array.isArray(fallback)) {
    if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !validUrl(item, ['ws:', 'wss:']))) return invalid(`${key} must be a nonempty array of ws:// or wss:// relay URLs.`);
    value = [...value];
  } else {
    if (typeof value !== 'string' || !value.trim()) return invalid(`${key} must be a nonempty string.`);
    if (key === 'endpoint' || key === 'openaiEndpoint') {
      if (!validUrl(value, ['http:', 'https:']) || new URL(value).search || new URL(value).hash || value !== value.trim()) return invalid(`${key} must be an http:// or https:// base URL without credentials, query or fragment.`);
    }
  }
  return { ok: true, value };
}
export function resolveConfiguration(input: ConfigurationInput): Result<Configuration, ConfigurationError> {
  const env: Record<string, unknown> = {};
  const knownEnv = new Set(Object.keys(defaultConfiguration).map(configurationEnvironmentName));
  for (const [key, value] of Object.entries(input.environment ?? {})) {
    if (key.startsWith('WOT_') && key !== 'WOT_CONFIG' && value !== undefined && !knownEnv.has(key)) return invalid(`Unknown environment configuration key: ${key}.`);
  }
  for (const key of Object.keys(defaultConfiguration)) {
    const value = input.environment?.[configurationEnvironmentName(key)];
    if (value !== undefined) env[key] = value;
  }
  const supplied = new Set<string>();
  let ollamaConfigured = false;
  const values: Record<string, unknown> = { ...defaultConfiguration, relays: [...defaultConfiguration.relays] };
  for (const [layer, textual] of [[input.file ?? {}, false], [env, true], [input.flags ?? {}, true]] as const) {
    if (Object.hasOwn(layer, 'ollamaConfigured') && (textual || !Object.hasOwn(layer, 'endpoint') || (layer.ollamaConfigured === false && layer.endpoint !== defaultConfiguration.endpoint))) return invalid('ollamaConfigured is resolved endpoint provenance and contradicts the supplied endpoint. Configure endpoint directly.');
    if (Object.hasOwn(layer, 'endpoint')) ollamaConfigured = layer.ollamaConfigured !== false;
    for (const [key, value] of Object.entries(layer)) {
      supplied.add(key);
      if (!Object.hasOwn(defaultConfiguration, key)) return invalid(`Unknown configuration key: ${key}.`);
      const checked = resolveEntry(key, value, textual);
      if (!checked.ok) return checked;
      values[key] = checked.value;
    }
  }
  // Carry provenance as plain data so repeated library resolution and JSON round trips
  // never reinterpret a built-in endpoint as an explicit operator choice.
  values.ollamaConfigured = ollamaConfigured;
  const provider = ollamaConfigured ? 'ollama' : 'openai';
  if (supplied.has('provider') && ollamaConfigured && values.provider !== 'ollama') return invalid('provider contradicts the explicitly configured Ollama endpoint. Remove provider or the endpoint.');
  if (!supplied.has('provider')) values.provider = provider;
  if (!supplied.has('model')) values.model = provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small';
  if (!supplied.has('dimensions')) values.dimensions = provider === 'ollama' ? 768 : 1536;
  const config = values as unknown as Configuration;
  if (config.chunkOverlap >= config.chunkTokens) return invalid('chunkOverlap must be smaller than chunkTokens.');
  if (config.offline && config.refresh) return invalid('offline and refresh cannot be enabled together.');
  return { ok: true, value: config };
}
/** The hash payload is versioned; property order and input formatting cannot affect it. */
export function canonicalParameters(config: Configuration): string {
  const presentation = new Set(['cachePath', 'compact', 'json', 'offline', 'refresh']);
  const parameters = Object.fromEntries(Object.entries(config).filter(([key]) => !presentation.has(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ version: 'semantic-wot-parameters-v1', parameters });
}
