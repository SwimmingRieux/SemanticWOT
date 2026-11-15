import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelayQuery } from '../../src/adapters/relay.js';
import { note } from '../fixtures.js';

test('pagination drains inclusive timestamp boundaries and reports capped buckets as incomplete', async () => {
  const a = note(1), b = note(2); b.created_at = a.created_at - 1;
  const seen: number[] = [];
  const query = createRelayQuery({ pageReader: { async read(input) {
    seen.push(input.filter.until ?? 0);
    const events = input.filter.until === undefined ? [a] : input.filter.until === a.created_at ? [a, b] : input.filter.until === b.created_at ? [b] : [];
    return { ok: true, value: events };
  } } });
  const result = await query.query({ relay: 'wss://one.test', filter: { kinds: [1] }, timeoutMs: 100, pageSize: 2, maxPages: 6, maxEvents: 20 });
  assert.ok(result.ok);
  assert.deepEqual(result.value.events.map(e => e.id), [a.id, b.id]);
  assert.equal(seen[1], a.created_at);
  assert.equal(result.value.complete, false);
  assert.match(result.value.reason ?? '', /boundary/);
});

test('adapter distinguishes an EOSE empty result from transport failure and preserves partial pages', async () => {
  for (const fail of [false, true]) {
    const query = createRelayQuery({ pageReader: { read: async () => fail ? { ok: false, error: { code: 'relay-failure', message: 'timeout before EOSE' } } : { ok: true, value: [] } } });
    const result = await query.query({ relay: 'wss://one.test', filter: {}, timeoutMs: 100, pageSize: 2, maxPages: 3, maxEvents: 20 });
    assert.equal(result.ok, !fail);
    if (result.ok) assert.equal(result.value.complete, true);
  }
});
