import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { createTraceRunner } from '../../src/adapters/tracing.js';
import { trace, SpanStatusCode } from '@opentelemetry/api';

test('async trace context preserves concurrent parentage, Result failures, and exceptions without payloads', async () => {
  const exporter = new InMemorySpanExporter();
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  sdk.start();
  const runner = createTraceRunner(trace.getTracer('test'));
  try {
    const failure = { ok: false, error: { code: 'relay-failure', message: 'Timed out SECRET' } };
    const error = new Error('SECRET');
    await runner.run('root', {}, async () => {
      await Promise.all([
        runner.run('failed', { relay: 'wss://user:SECRET@example.com/?token=SECRET' }, async () => failure),
        runner.run('page', {}, async () => ({ ok: true, value: { events: [1, 2], pages: 1, complete: false, reason: 'Event cap reached.' } })),
        assert.rejects(runner.run('throw', {}, async () => { throw error; }), value => value === error),
      ]);
    });
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 4);
    const root = spans.find(s => s.name === 'root')!;
    for (const child of spans.filter(s => s !== root)) {
      assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId);
      assert.equal(child.spanContext().traceId, root.spanContext().traceId);
    }
    const failed = spans.find(s => s.name === 'failed')!;
    assert.equal(failed.status.code, SpanStatusCode.ERROR);
    assert.equal(failed.attributes['failure.kind'], 'timeout');
    assert.equal(failed.attributes.relay, 'wss://example.com/');
    const page = spans.find(s => s.name === 'page')!;
    assert.equal(page.attributes['events.count'], 2);
    assert.equal(page.attributes['completion.reason'], 'cap');
    assert.ok(!JSON.stringify(spans.map(s => ({ attributes: s.attributes, status: s.status, events: s.events }))).includes('SECRET'));
  } finally { await sdk.shutdown(); }
});
