import { trace, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { untraced, type TraceRunner } from '../application/tracing.js';
import type { openSqliteCache } from './sqlite.js';
import type { EmbeddingAdapter } from './embedding.js';

/** Records typed Result failures as well as exceptions, without capturing content or keys. */
export function createTraceRunner(tracer: Tracer): TraceRunner {
  return { run(name, attributes, operation) {
    const safeAttributes = { ...attributes };
    if (typeof safeAttributes.relay === 'string') {
      try { const url = new URL(safeAttributes.relay); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; safeAttributes.relay = url.toString(); } catch { safeAttributes.relay = 'invalid'; }
    }
    return tracer.startActiveSpan(name, { attributes: safeAttributes }, async span => {
      try {
        const result = await operation();
        if (result && typeof result === 'object' && 'ok' in result) {
          span.setAttribute('result.ok', Boolean(result.ok));
          if (!result.ok) {
            // Messages may contain receipt payloads or URL credentials. Export only error codes.
            const code = 'error' in result && result.error && typeof result.error === 'object' && 'code' in result.error ? String(result.error.code) : 'failure';
            span.setStatus({ code: SpanStatusCode.ERROR, message: code });
            const message = 'error' in result && result.error && typeof result.error === 'object' && 'message' in result.error ? String(result.error.message) : '';
            span.setAttribute('failure.kind', /cooldown/i.test(message) ? 'cooldown' : /timed? out|timeout/i.test(message) ? 'timeout' : /closed/i.test(message) ? 'closed' : 'other');
          } else if ('value' in result) {
            const value = result.value;
            if (Array.isArray(value)) span.setAttribute('result.count', value.length);
            else if (typeof value === 'number') span.setAttribute('result.count', value);
            else if (value && typeof value === 'object') {
              if ('events' in value && Array.isArray(value.events)) span.setAttribute('events.count', value.events.length);
              if ('pages' in value && typeof value.pages === 'number') span.setAttribute('pages.count', value.pages);
              if ('complete' in value) span.setAttribute('coverage.complete', Boolean(value.complete));
              if ('reason' in value && typeof value.reason === 'string') {
                const reason = value.reason;
                span.setAttribute('completion.reason', /timed? out|timeout/i.test(reason) ? 'timeout' : /cap reached/i.test(reason) ? 'cap' : /boundary/i.test(reason) ? 'boundary' : 'other');
              }
            }
          }
        }
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'exception' });
        // Preserve the original exception in the caller, never export its payload.
        throw error;
      } finally { span.end(); }
    });
  } };
}

/** Opt in explicitly. SDK lifecycle belongs to the executable, never the library. */
export function startTelemetry(environment: NodeJS.ProcessEnv) {
  if (environment.SEMANTICWOT_TRACE !== '1') return { runner: untraced, shutdown: async () => {} };
  const sdk = new NodeSDK({
    autoDetectResources: false, serviceName: 'semantic-wot', sampler: new AlwaysOnSampler(),
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({
      url: environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://127.0.0.1:4318/v1/traces',
      timeoutMillis: 5000,
    }), maxQueueSize: 32768, maxExportBatchSize: 512, scheduledDelayMillis: 1000 })],
  });
  sdk.start();
  return { runner: createTraceRunner(trace.getTracer('semantic-wot')), shutdown: () => sdk.shutdown() };
}

type OpenedCache = Extract<ReturnType<typeof openSqliteCache>, { ok: true }>['value'];
export function traceCache(cache: OpenedCache, runner: TraceRunner): OpenedCache {
  return { ...cache,
    feedSnapshotReader: { get: (...args: Parameters<OpenedCache['feedSnapshotReader']['get']>) => runner.run('sqlite.feedSnapshotReader', {}, () => cache.feedSnapshotReader.get(...args)) },
    snapshotReader: { get: (...args: Parameters<OpenedCache['snapshotReader']['get']>) => runner.run('sqlite.snapshotReader', {}, () => cache.snapshotReader.get(...args)) },
    rankingReader: { get: (...args: Parameters<OpenedCache['rankingReader']['get']>) => runner.run('sqlite.rankingReader', {}, () => cache.rankingReader.get(...args)) },
    embeddingReader: { get: (...args: Parameters<OpenedCache['embeddingReader']['get']>) => runner.run('sqlite.embeddingReader', {}, () => cache.embeddingReader.get(...args)) },
    indexStateReader: { get: (...args: Parameters<OpenedCache['indexStateReader']['get']>) => runner.run('sqlite.indexStateReader', {}, () => cache.indexStateReader.get(...args)) },
    eventWriter: { put: (input) => runner.run('sqlite.eventWriter', { 'input.count': Array.isArray(input) ? input.length : 1 }, () => cache.eventWriter.put(input)) },
    indexRecordWriter: { put: (input) => runner.run('sqlite.indexRecordWriter', { 'input.count': Array.isArray(input) ? input.length : 1 }, () => cache.indexRecordWriter.put(input)) },
    indexedAtWriter: { put: (input) => runner.run('sqlite.indexedAtWriter', { 'input.count': Array.isArray(input) ? input.length : 1 }, () => cache.indexedAtWriter.put(input)) },
    indexCompletionWriter: { put: (input) => runner.run('sqlite.indexCompletionWriter', { 'input.count': Array.isArray(input) ? input.length : 1 }, () => cache.indexCompletionWriter.put(input)) },
    rankingWriter: { put: (input) => runner.run('sqlite.rankingWriter', { 'input.count': Array.isArray(input) ? input.length : 1 }, () => cache.rankingWriter.put(input)) },
    embeddingWriter: { put: (input) => runner.run('sqlite.embeddingWriter', { 'input.count': Array.isArray(input) ? input.length : 1 }, () => cache.embeddingWriter.put(input)) },
  };
}
export function traceEmbeddingAdapter(adapter: EmbeddingAdapter, runner: TraceRunner): EmbeddingAdapter {
  return {
    modelIdentityReader: { resolve: input => runner.run('embedding.model.resolve', {}, () => adapter.modelIdentityReader.resolve(input)) },
    embedder: { embed: input => runner.run('embedding.inference', { 'chunks.count': input.input.length }, () => adapter.embedder.embed(input)) },
  };
}

export const activeTraceId = () => trace.getActiveSpan()?.spanContext().traceId;

/** Backward-compatible name for existing Ollama callers. */
export const traceOllama = traceEmbeddingAdapter;
