import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeedJobs } from '../../src/web/jobs.js';
import type { FeedJob } from '../../src/web/types.js';
import { key } from '../fixtures.js';

test('a restarted job becomes interrupted and can be explicitly retried', async () => {
  const previous: FeedJob = { id: 'before-restart', viewer: key(1), status: 'running', startedAt: 10 };
  const runtime = createFeedJobs({ clock: { now: () => 20 }, nextId: () => 'retry',
    initial: [{ job: previous }], writer: { write: () => ({ ok: true, value: undefined }) },
    workflow: { run: async () => ({ ok: false, error: { code: 'relay-failure', message: 'offline' } }) } });
  assert.equal(runtime.read(key(1)).job?.status, 'interrupted');
  assert.equal(runtime.read(key(1)).job?.finishedAt, 20);
  assert.equal(runtime.submit(key(1)).job?.id, 'retry');
  await runtime.close();
});

test('one backend job survives observers leaving and reconnecting at current progress', async () => {
  let finish!: (value: import('../../src/index.js').Result<import('../../src/index.js').IndexWorkflowOutput, import('../../src/index.js').IndexError>) => void;
  const result = new Promise<import('../../src/index.js').Result<import('../../src/index.js').IndexWorkflowOutput, import('../../src/index.js').IndexError>>(resolve => { finish = resolve; });
  let starts = 0;
  const runtime = createFeedJobs({ clock: { now: () => 30 }, nextId: () => 'only-job', writer: { write: () => ({ ok: true, value: undefined }) },
    workflow: { run: (_viewer, report) => { starts++; report({ phase: 'embeddings', completed: 2, total: 7 }); return result; } } });
  const accepted = runtime.submit(key(1));
  assert.equal(accepted.disposition, 'accepted');
  assert.equal(runtime.submit(key(1)).disposition, 'existing');
  assert.equal(runtime.submit(key(2)).disposition, 'busy');
  assert.equal(starts, 1);
  assert.deepEqual(runtime.read(key(1)).job?.progress, { phase: 'embeddings', completed: 2, total: 7 });
  finish({ ok: false, error: { code: 'relay-failure', message: 'offline' } });
  await result; await Promise.resolve();
  assert.equal(runtime.read(key(1)).job?.status, 'failed');
  assert.equal(runtime.submit(key(2)).disposition, 'accepted');
  await result; await Promise.resolve(); await runtime.close();
});

async function successfulOutput() {
  const { readFeed } = await import('../../src/index.js');
  const { snapshot, now } = await import('../fixtures.js');
  const feed = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, {
    snapshotReader: { get: async () => ({ ok: true, value: snapshot() }) }, clock: { now: () => now },
  });
  assert.ok(feed.ok);
  return { feed: feed.value, collection: { viewer: key(10), indexedAt: now, receipts: 1,
    seeds: { referenced: 1, found: 1, missing: 0 }, seedDiscoveryRate: 1, coZappers: { discovered: 1, selected: 1 },
    candidates: { referenced: 3, found: 3, missing: 0 }, edges: { retained: 2, truncated: false },
    limits: { maxCoZappers: 20, maxZapsPerCoZapper: 20, maxCandidates: 100, maxEdges: 100 }, relays: [], diagnostics: [] } };
}

test('interrupted shutdown preserves the saved feed and ignores late completion', async () => {
  const output = await successfulOutput();
  const previous = { feed: output.feed, completedAt: 10, warnings: [] };
  const persisted: import('../../src/web/types.js').StoredFeedState[] = [];
  let finish!: (value: import('../../src/index.js').Result<typeof output, import('../../src/index.js').IndexError>) => void;
  const result = new Promise<import('../../src/index.js').Result<typeof output, import('../../src/index.js').IndexError>>(resolve => { finish = resolve; });
  const runtime = createFeedJobs({ clock: { now: () => 40 }, nextId: () => 'refresh',
    initial: [{ job: { id: 'completed', viewer: key(10), startedAt: 5, finishedAt: 10, status: 'completed' }, saved: previous }],
    writer: { write(state) { persisted.push(structuredClone(state)); return { ok: true, value: undefined }; } }, workflow: { run: () => result } });
  assert.equal(runtime.submit(key(10)).disposition, 'saved');
  assert.equal(runtime.submit(key(10), true).disposition, 'accepted');
  assert.deepEqual(runtime.read(key(10)).saved, previous);
  const closing = runtime.close();
  assert.equal(runtime.read(key(10)).job?.status, 'interrupted');
  finish({ ok: true, value: output }); await closing;
  assert.deepEqual(runtime.read(key(10)).saved, previous);
  assert.equal(persisted.at(-1)?.job.status, 'interrupted');
  assert.ok(persisted.every(state => state.saved === undefined));
});

test('only a completed workflow replaces a saved feed, including successful empty output', async () => {
  const output = await successfulOutput();
  const previous = { feed: output.feed, completedAt: 10, warnings: [] };
  type Outcome = import('../../src/index.js').Result<typeof output, import('../../src/index.js').IndexError>;
  let outcome: Promise<Outcome> = Promise.resolve({ ok: false, error: { code: 'embedding-failure', message: 'unavailable' } });
  const writes: import('../../src/web/types.js').StoredFeedState[] = [];
  const runtime = createFeedJobs({ clock: { now: () => 60 }, nextId: () => 'refresh',
    initial: [{ job: { id: 'previous', viewer: key(10), startedAt: 5, status: 'completed' }, saved: previous }],
    writer: { write(state) { writes.push(structuredClone(state)); return { ok: true, value: undefined }; } }, workflow: { run: () => outcome } });
  runtime.submit(key(10), true); await outcome;
  assert.equal(runtime.read(key(10)).job?.status, 'failed'); assert.deepEqual(runtime.read(key(10)).saved, previous);
  assert.ok(writes.every(state => state.saved === undefined));
  outcome = Promise.resolve({ ok: true, value: { feed: { ...output.feed, items: [] }, collection: { ...output.collection, seeds: { referenced: 0, found: 0, missing: 0 } } } });
  runtime.submit(key(10), true); await outcome;
  assert.equal(runtime.read(key(10)).job?.status, 'completed');
  assert.equal(runtime.read(key(10)).saved?.emptyReason, 'no-seeds');
  assert.equal(runtime.read(key(10)).saved?.completedAt, 60);
  assert.equal(writes.at(-1)?.job.status, 'completed'); assert.deepEqual(writes.at(-1)?.saved?.feed.items, []);
  await runtime.close();
});

test('a result storage failure leaves the previous feed intact and reports a retryable failure', async () => {
  const output = await successfulOutput();
  const previous = { feed: output.feed, completedAt: 10, warnings: [] };
  const outcome = Promise.resolve({ ok: true as const, value: output });
  const runtime = createFeedJobs({ clock: { now: () => 60 }, nextId: () => 'cannot-save',
    initial: [{ job: { id: 'previous', viewer: key(10), startedAt: 5, status: 'completed' }, saved: previous }],
    writer: { write(state) { return state.saved ? { ok: false, error: { code: 'cache-failure', message: 'disk full' } } : { ok: true, value: undefined }; } },
    workflow: { run: () => outcome } });
  runtime.submit(key(10), true); await outcome;
  assert.equal(runtime.read(key(10)).job?.status, 'failed');
  assert.equal(runtime.read(key(10)).job?.error?.code, 'cache-failure');
  assert.deepEqual(runtime.read(key(10)).saved, previous);
  await runtime.close();
});

test('an unwritable initial job does not start external work', async () => {
  const runtime = createFeedJobs({ clock: { now: () => 60 }, nextId: () => 'cannot-start',
    writer: { write: () => ({ ok: false, error: { code: 'cache-failure', message: 'disk full' } }) },
    workflow: { run: () => { assert.fail('cannot start work without a durable job'); } } });
  const state = runtime.submit(key(10));
  assert.equal(state.job?.status, 'failed'); assert.equal(state.job?.error?.code, 'cache-failure');
  await runtime.close();
});
