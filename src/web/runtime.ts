import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbeddingAdapter, createEmbeddingHook, indexAndReadFeed, parseReceipt, verifyIndexedEvent, type Configuration, type IndexError, type Result } from '../index.js';
import { parametersHash } from '../adapters/config.js';
import { openSqliteCache } from '../adapters/sqlite.js';
import { withRelayQuery } from '../adapters/relay.js';
import { startTelemetry, traceCache, traceEmbeddingAdapter } from '../adapters/tracing.js';
import type { Clock } from '../application/feed.js';
import { createFeedJobs } from './jobs.js';
import { openWebState } from './storage.js';
import type { WebRuntime } from './types.js';

export interface WebRuntimeOptions { config: Configuration; apiKey?: string; clock?: Clock; telemetryEnvironment?: Record<string, string | undefined>; statePath?: string }
export type WebRuntimeResult = Result<WebRuntime, IndexError>;
/** The shipped composition: real SQLite, managed relay transport, and selected HTTP embedding adapter. */
export async function createWebRuntime(options: WebRuntimeOptions): Promise<WebRuntimeResult> {
  const statePath = options.statePath ?? join(dirname(options.config.cachePath), 'web-state.sqlite');
  try {
    await mkdir(dirname(options.config.cachePath), { recursive: true });
    await mkdir(dirname(statePath), { recursive: true });
  } catch {
    return { ok: false, error: { code: 'cache-failure', message: 'Cannot create the data directory. Check the configured data directory.' } };
  }
  const telemetry = startTelemetry(options.telemetryEnvironment ?? {}), trace = telemetry.runner;
  const opened = openSqliteCache({ path: options.config.cachePath });
  if (!opened.ok) {
    await telemetry.shutdown();
    return { ok: false, error: { code: opened.error.code, message: 'Cannot open the application cache. Check the configured data directory.' } };
  }
  const state = openWebState(statePath);
  if (!state.ok) {
    try { opened.value.close(); } finally { await telemetry.shutdown(); }
    return state;
  }
  const cache = traceCache(opened.value, trace);
  const clock = options.clock ?? { now: () => Math.floor(Date.now() / 1000) };
  const controller = new AbortController();
  const jobs = createFeedJobs({ clock, nextId: randomUUID, initial: state.value.initial, writer: state.value.writer, workflow: { async run(viewer, report) {
    const adapter = createEmbeddingAdapter({ config: options.config, apiKey: options.apiKey,
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }) });
    if (!adapter.ok) return { ok: false, error: { code: 'invalid-input', message: adapter.error.message } };
    const result = await withRelayQuery({ trace, signal: controller.signal }, relayQuery => indexAndReadFeed({ viewer, config: options.config }, {
      snapshotReader: cache.feedSnapshotReader, rankingReader: cache.rankingReader, rankingWriter: cache.rankingWriter,
      parameterHasher: { hash: parametersHash }, clock,
      indexPorts: { trace, relayQuery, receiptParser: { parse: parseReceipt }, eventValidator: { validate: verifyIndexedEvent },
        eventWriter: cache.eventWriter, indexRecordWriter: cache.indexRecordWriter, indexedAtWriter: cache.indexedAtWriter,
        indexStateReader: cache.indexStateReader, indexCompletionWriter: cache.indexCompletionWriter, clock, progress: { report },
        embeddingHook: createEmbeddingHook({ ...traceEmbeddingAdapter(adapter.value, trace), embeddingReader: cache.embeddingReader, embeddingWriter: cache.embeddingWriter, progress: { report() {} } }),
      },
    }));
    if (result.ok) return result;
    // Transport bodies can contain arbitrary secrets. Public failures use a stable, actionable vocabulary.
    const messages = {
      'relay-failure': 'Relays could not provide outgoing zaps. Check relay connectivity and retry.',
      'embedding-failure': options.config.provider === 'ollama' ? 'Ollama embeddings failed. Check the endpoint and installed model (ollama pull <model>), then retry.' : 'OpenAI embeddings failed. Check the server API key, model, dimensions, network and quota, then retry.',
      'invalid-input': 'Processing configuration is invalid. Check the server settings and retry.',
      'missing-cache': 'The cache is unavailable. Check the server data directory and retry.',
      'missing-embeddings': 'Compatible embeddings are unavailable. Check the configured provider and retry.',
      'cache-failure': 'The cache could not be written. Check the server data directory and retry.',
    };
    return { ok: false, error: { code: result.error.code, message: messages[result.error.code] } };
  } } });
  return { ok: true, value: { submit: jobs.submit, read: jobs.read, async close() { const closing = jobs.close(); controller.abort(); await closing; state.value.close(); cache.close(); await telemetry.shutdown(); } } };
}
