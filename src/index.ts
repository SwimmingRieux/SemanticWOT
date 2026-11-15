import { indexViewer as collectViewer, type IndexInput, type IndexPorts, type IndexOutput, type IndexError } from './application/indexing.js';
import { parsePublicKey, parseReceipt } from './adapters/nostr.js';
import { runIndexWorkflow, type IndexWorkflowOutput } from './application/refresh.js';
import { resolveConfiguration } from './application/config.js';
import { readCachedFeed, type FeedInput, type FeedPorts } from './application/feed.js';
import type { FeedError, FeedOutput, Result } from './core/types.js';
export * from './core/types.js';
export * from './core/similarity.js';
export * from './core/embedding.js';
export * from './core/walk.js';
export * from './core/graph.js';
export * from './core/feed.js';
export * from './application/feed.js';
export * from './application/config.js';
export { parsePublicKey, parseReceipt, verifyIndexedEvent } from './adapters/nostr.js';
export * from './application/cache.js';
export * from './application/embedding.js';
export * from './adapters/embedding.js';
export { createOpenAIAdapter } from './adapters/openai.js';
export { createOllamaAdapter } from './adapters/ollama.js';
/** Offline composition: the only effects are the supplied cache reader and clock. */
export async function readFeed(input: FeedInput, ports: FeedPorts): Promise<Result<FeedOutput, FeedError>> {
  const viewer = parsePublicKey(input.viewer);
  if (!viewer.ok) return viewer;
  const checked = resolveConfiguration({ file: input.config });
  if (!checked.ok) return { ok: false, error: { code: 'invalid-input', message: checked.error.message } };
  const normalized = { ...input, viewer: viewer.value };
  const supplied = { ...ports, receiptParser: { parse: parseReceipt } };
  if (checked.value.refresh) {
    const refreshed = await runIndexWorkflow(normalized, supplied);
    return refreshed.ok ? { ok: true, value: refreshed.value.feed } : refreshed;
  }
  return readCachedFeed(normalized, supplied);
}
export function serializeFeed(output: FeedOutput, compact = false): string { return JSON.stringify(output, null, compact ? undefined : 2) + '\n'; }

export * from './application/indexing.js';

/** Public-key normalization stays in the composition root, outside collection logic. */
export async function indexViewer(input: IndexInput, ports: IndexPorts): Promise<Result<IndexOutput, IndexError>> {
  const viewer = parsePublicKey(input.viewer);
  if (!viewer.ok) return viewer;
  return collectViewer({ ...input, viewer: viewer.value }, ports);
}

export * from './application/evaluation.js';
import { evaluateFrozenSnapshot, type EvaluationInput, type EvaluationOutput } from './application/evaluation.js';
/** Frozen evaluation uses the same receipt adapter and cached-feed pipeline as readFeed. */
export async function evaluateSnapshot(input: EvaluationInput): Promise<Result<EvaluationOutput, FeedError>> {
  const viewers: string[] = [];
  for (const value of input.viewers) {
    const parsed = parsePublicKey(value); if (!parsed.ok) return parsed;
    viewers.push(parsed.value);
  }
  return evaluateFrozenSnapshot({ ...input, viewers }, { receiptParser: { parse: parseReceipt } });
}

export * from './application/refresh.js';
export async function indexAndReadFeed(input: FeedInput, ports: FeedPorts): Promise<Result<IndexWorkflowOutput, IndexError>> {
  const viewer = parsePublicKey(input.viewer);
  if (!viewer.ok) return viewer;
  return runIndexWorkflow({ ...input, viewer: viewer.value }, { ...ports, receiptParser: { parse: parseReceipt } });
}
export * from './application/tracing.js';
