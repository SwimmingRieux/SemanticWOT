import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexViewer } from '../../src/index.js';
import { nip19 } from 'nostr-tools';
import { parseReceipt } from '../../src/adapters/nostr.js';
import { key, note, now, receipt, snapshot } from '../fixtures.js';
import { indexAndReadFeed, readFeed } from '../../src/index.js';
import type { NostrEvent, Snapshot } from '../../src/core/types.js';

test('indexing queries outgoing receipts, retrieves notes by ID and preserves relay-copy provenance for cached feed reads', async () => {
  const events: NostrEvent[] = [];
  const records: unknown[] = [];
  const cached: Snapshot = { events, embeddings: snapshot().embeddings, indexedAt: 0 };
  const result = await indexViewer({ viewer: nip19.npubEncode(key(10)), config: { model: 'test', dimensions: 2, relays: ['wss://one.test', 'wss://two.test'] } }, {
    relayQuery: { async query(input) {
      if (input.filter.kinds?.includes(9735)) {
        if (input.filter['#P']) assert.deepEqual(input.filter['#P'], [key(10)]);
        assert.equal('#p' in input.filter, false);
        return { ok: true, value: { events: [receipt(201, 10, 1)], complete: true, pages: 1 } };
      }
      assert.deepEqual(input.filter.ids, [key(1)]);
      return { ok: true, value: { events: [note(1)], complete: true, pages: 1 } };
    } },
    eventValidator: { validate: () => ({ ok: true, value: true }) }, receiptParser: { parse: parseReceipt },
    eventWriter: { async put(batch) { events.push(...batch); return { ok: true, value: batch.length }; } },
    indexRecordWriter: { async put(batch) { records.push(...batch); return { ok: true, value: batch.length }; } },
    indexedAtWriter: { async put(timestamp) { cached.indexedAt = timestamp; return { ok: true, value: timestamp }; } },
    clock: { now: () => now },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.seeds, { referenced: 1, found: 1, missing: 0 });
  assert.equal(result.value.receipts, 1);
  assert.equal(events.filter(e => e.kind === 9735).length, 1);
  assert.ok(JSON.stringify(records).includes('wss://one.test'));
  assert.ok(JSON.stringify(records).includes('wss://two.test'));
  const feed = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, { snapshotReader: { get: async () => ({ ok: true, value: cached }) }, clock: { now: () => now } });
  assert.ok(feed.ok);
  assert.equal(feed.value.counts.seeds, 1);
});

test('successful empty relays differ from all-relay failure, and partial failures preserve missing-content diagnostics', async () => {
  for (const mode of ['empty', 'failed', 'partial'] as const) {
    let marked = false;
    const result = await indexViewer({ viewer: key(10), config: { relays: ['wss://one.test', 'wss://two.test'] } }, {
      relayQuery: { async query(input) {
        if (mode === 'failed' || mode === 'partial' && input.relay.includes('two')) return { ok: false, error: { code: 'relay-failure', message: 'disconnected' } };
        return { ok: true, value: { events: mode === 'partial' && input.filter['#P'] ? [receipt(201, 10, 1)] : [], complete: true, pages: 1 } };
      } },
      eventValidator: { validate: () => ({ ok: true, value: true }) }, receiptParser: { parse: parseReceipt },
      eventWriter: { put: async batch => ({ ok: true, value: batch.length }) }, indexRecordWriter: { put: async batch => ({ ok: true, value: batch.length }) },
      indexedAtWriter: { async put(timestamp) { marked = true; return { ok: true, value: timestamp }; } }, clock: { now: () => now },
    });
    assert.equal(result.ok, mode !== 'failed');
    assert.equal(marked, mode !== 'failed');
    if (result.ok && mode === 'empty') assert.ok(result.value.diagnostics.some(d => d.code === 'no-seeds'));
    if (result.ok && mode === 'partial') { assert.equal(result.value.seeds.missing, 1); assert.ok(result.value.relays.some(r => r.status === 'failed')); }
  }
});

test('indexing a viewer without seeds succeeds from a populated shared cache while the model is unavailable', async () => {
  const cached: Snapshot = { events: [note(1)], embeddings: [], indexedAt: now };
  const result = await indexAndReadFeed({ viewer: key(999), config: { relays: ['wss://one.test'] } }, {
    snapshotReader: { get: async () => ({ ok: true, value: cached }) }, clock: { now: () => now },
    indexPorts: {
      indexStateReader: { get: async () => ({ ok: true, value: { events: cached.events, coverage: [] } }) },
      relayQuery: { query: async () => ({ ok: true, value: { events: [], complete: true, pages: 1 } }) },
      eventValidator: { validate: () => ({ ok: true, value: true }) }, receiptParser: { parse: parseReceipt },
      eventWriter: { async put(events) { cached.events = events; return { ok: true, value: events.length }; } },
      indexRecordWriter: { put: async records => ({ ok: true, value: records.length }) },
      indexedAtWriter: { put: async timestamp => ({ ok: true, value: timestamp }) }, clock: { now: () => now },
      embeddingHook: { prepare: async () => ({ ok: false, error: { code: 'embedding-failure', message: 'Model server is unavailable.' } }) },
    },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.value.collection.seeds, { referenced: 0, found: 0, missing: 0 });
  assert.deepEqual(result.value.feed.items, []);
  assert.ok(result.value.feed.diagnostics.some(item => item.code === 'no-seeds'));
});

test('receipt copies with different IDs cannot double a payment while distinct equal-amount invoices remain separate', async () => {
  const paid = receipt(201, 10, 1), copy = { ...paid, id: key(202) }, repeat = receipt(203, 10, 1);
  // Different invoice timestamp/body, same exact amount.
  const { bech32 } = await import('@scure/base');
  repeat.tags[2][1] = bech32.encode('lnbc10000000p', [1, ...new Array(110).fill(0)], false);
  const cached: Snapshot = { events: [], embeddings: snapshot().embeddings, indexedAt: now };
  const result = await indexViewer({ viewer: key(10), config: { model: 'test', dimensions: 2, relays: ['wss://one.test'] } }, {
    relayQuery: { query: async input => ({ ok: true, value: { events: input.filter['#P'] ? [paid, copy, repeat] : [note(1)], complete: true, pages: 1 } }) },
    eventValidator: { validate: () => ({ ok: true, value: true }) }, receiptParser: { parse: parseReceipt },
    eventWriter: { async put(batch) { cached.events = batch; return { ok: true, value: batch.length }; } }, indexRecordWriter: { put: async batch => ({ ok: true, value: batch.length }) }, indexedAtWriter: { put: async timestamp => ({ ok: true, value: timestamp }) }, clock: { now: () => now },
  });
  assert.ok(result.ok);
  assert.equal(result.value.receipts, 2);
  const feed = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, { snapshotReader: { get: async () => ({ ok: true, value: cached }) }, clock: { now: () => now } });
  assert.ok(feed.ok);
  assert.equal(feed.value.counts.receipts, 2);
});
