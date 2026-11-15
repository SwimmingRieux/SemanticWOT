import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { evaluateSnapshot, checkEvaluation, serializeEvaluation, defaultRankingConfig, type FeedError, type NostrEvent, type ChunkEmbedding, type RankingConfig, type Result, type Snapshot } from '../index.js';
import { loadConfiguration } from './config.js';

export interface FrozenEvaluationBundle { version: 1; evaluationTime: number; parameters: RankingConfig; snapshot: Snapshot }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function event(value: unknown): value is NostrEvent {
  return record(value) && id(value.id) && id(value.pubkey) && integer(value.created_at) && integer(value.kind) && typeof value.content === 'string' &&
    Array.isArray(value.tags) && value.tags.every(tag => Array.isArray(tag) && tag.every(part => typeof part === 'string'));
}
function embedding(value: unknown): value is ChunkEmbedding {
  return record(value) && id(value.noteId) && typeof value.model === 'string' && Array.isArray(value.vectors) &&
    value.vectors.every(vector => Array.isArray(vector) && vector.every(number => typeof number === 'number' && Number.isFinite(number)));
}
/** Format validation is at the JSON boundary; ranking validation stays in the shared configuration path. */
export function parseEvaluationBundle(value: unknown): Result<FrozenEvaluationBundle, FeedError> {
  if (!record(value) || value.version !== 1 || !integer(value.evaluationTime) || !record(value.parameters) ||
      Object.keys(defaultRankingConfig).some(key => !Object.hasOwn(value.parameters as object, key)) || !record(value.snapshot) ||
      !integer(value.snapshot.indexedAt) || !Array.isArray(value.snapshot.events) || !value.snapshot.events.every(event) ||
      !Array.isArray(value.snapshot.embeddings) || !value.snapshot.embeddings.every(embedding)) {
    return { ok: false, error: { code: 'invalid-input', message: 'Invalid frozen snapshot: require version 1, evaluationTime, complete ranking parameters and snapshot {events, embeddings, indexedAt}. See docs/evaluation.md.' } };
  }
  return { ok: true, value: value as unknown as FrozenEvaluationBundle };
}
async function readJson(path: string): Promise<Result<unknown, FeedError>> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { return { ok: false, error: { code: 'cache-failure', message: `Cannot read ${path}: ${(error as Error).message}` } }; }
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (error) { return { ok: false, error: { code: 'invalid-input', message: `Invalid JSON in ${path}: ${(error as Error).message}` } }; }
}
/** Composition root for frozen evaluation: file input and output stay outside the application. */
export async function runEvaluationCli(values: Record<string, unknown>, flags: Record<string, unknown>): Promise<number> {
  if (typeof values.snapshot !== 'string' || typeof (values.users ?? values.viewers) !== 'string' ||
      (values.users !== undefined && values.viewers !== undefined) ||
      (values.baseline !== undefined && values.baseline !== 'zap' && values.baseline !== 'chrono') ||
      (values.expected !== undefined && !values.check)) {
    process.stderr.write('Usage: wot eval --snapshot bundle.json --users users.json [--check --expected directory] [--baseline zap|chrono]\n'); return 2;
  }
  const loaded = await readJson(values.snapshot);
  if (!loaded.ok) { process.stderr.write(`${loaded.error.message}\n`); return loaded.error.code === 'invalid-input' ? 2 : 1; }
  const bundle = parseEvaluationBundle(loaded.value);
  if (!bundle.ok) { process.stderr.write(`${bundle.error.message}\n`); return 2; }
  const users = await readJson(String(values.users ?? values.viewers));
  if (!users.ok) { process.stderr.write(`${users.error.message}\n`); return users.error.code === 'invalid-input' ? 2 : 1; }
  if (!Array.isArray(users.value) || !users.value.length || users.value.some(user => typeof user !== 'string')) {
    process.stderr.write('Users must be a nonempty JSON array of npub or hex public keys.\n'); return 2;
  }
  const config = await loadConfiguration({ cwd: process.cwd(), home: homedir(), xdgConfigHome: process.env.XDG_CONFIG_HOME,
    configPath: values.config === undefined ? undefined : String(values.config), environment: process.env, flags, base: { ...bundle.value.parameters } });
  if (!config.ok) { process.stderr.write(`${config.error.message}\n`); return 2; }
  if (config.value.refresh) { process.stderr.write('Frozen evaluation cannot refresh. Remove --refresh or enable --no-refresh.\n'); return 2; }
  const started = performance.now();
  const result = await evaluateSnapshot({ snapshot: bundle.value.snapshot, evaluationTime: bundle.value.evaluationTime,
    viewers: users.value, config: config.value, baseline: values.baseline as 'zap' | 'chrono' | undefined });
  const runtimeMs = performance.now() - started;
  process.stderr.write(`${JSON.stringify({ runtimeMs })}\n`);
  if (!result.ok) { process.stderr.write(`${result.error.message}\n`); return result.error.code === 'invalid-input' ? 2 : 1; }
  for (const viewer of result.value.viewers) for (const diagnostic of viewer.feed.diagnostics) process.stderr.write(`${viewer.viewer} ${diagnostic.code}: ${diagnostic.message}\n`);
  process.stdout.write(serializeEvaluation(result.value, config.value.compact));
  if (!values.check) return 0;
  const directory = values.expected === undefined ? join(dirname(values.snapshot), 'expected') : String(values.expected);
  const expectations: Record<string, unknown> = {};
  for (const viewer of result.value.viewers) {
    const path = join(directory, `${viewer.viewer}.json`);
    const expected = await readJson(path);
    if (expected.ok) expectations[viewer.viewer] = expected.value;
    else process.stderr.write(`${expected.error.message}\n`);
  }
  const check = checkEvaluation(result.value, expectations);
  for (const mismatch of check.mismatches) process.stderr.write(`Expectation mismatch for ${mismatch.viewer} at ${mismatch.path}\nExpected: ${mismatch.expected}\nActual: ${mismatch.actual}\n`);
  if (check.ok) process.stderr.write(`Expectations match for ${result.value.viewers.length} viewer(s).\n`);
  return check.ok ? 0 : 1;
}
