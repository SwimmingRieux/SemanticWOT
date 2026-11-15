import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as relayAdapter from '../../src/adapters/relay.js';
import type { RelayQuery } from '../../src/application/indexing.js';
import { localRelay, request } from './helpers/relay.js';

test('managed independent scopes reuse one normalized relay connection and release it on exit', async () => {
  const peer = await localRelay();
  try {
    await relayAdapter.withRelayQuery({}, async (query: RelayQuery) => {
      for (let scope = 1; scope <= 2; scope++) {
        const result = await query.query(request(peer.relay + (scope === 2 ? '/#fragment' : ''), scope));
        assert.ok(result.ok); assert.equal(result.value.complete, true);
      }
      assert.equal(peer.counts().handshakes, 1);
      assert.equal(peer.requests.length, 2);
      assert.notDeepEqual(peer.requests[0]['#e'], peer.requests[1]['#e']);
    });
  } finally { await peer.close(); }
});

test('advertised capacity queues independent scopes in FIFO order with a fresh response budget', async () => {
  const peer = await localRelay((client, id) => setTimeout(() => client.send(JSON.stringify(['EOSE', id])), 60), { max_subscriptions: 1, max_limit: 7 });
  try {
    const observations: relayAdapter.RelayObservation[] = [];
    await relayAdapter.withRelayQuery({ observer: { report: event => observations.push(event) } }, async query => {
      const results = await Promise.all([1, 2, 3, 4].map(scope => query.query({ ...request(peer.relay, scope), timeoutMs: 150 })));
      assert.ok(results.every(result => result.ok));
      assert.deepEqual(peer.requests.map(filter => filter['#e'][0]), [1, 2, 3, 4].map(n => n.toString(16).padStart(64, '0')));
      assert.ok(peer.requests.every(filter => filter.limit === 7));
      assert.deepEqual(peer.counts(), { handshakes: 1, metadata: 1 });
      assert.ok(observations.some(event => event.type === 'admission' && event.queuedMs > 150));
      assert.ok(observations.some(event => event.type === 'subscriptions' && event.active === 1 && event.queued === 3));
      const pages = observations.filter(event => event.type === 'page');
      assert.equal(pages.length, 4);
      assert.ok(pages.every(event => event.subscriptions === 0 && event.ongoingOperations === 0));
    });
  } finally { await peer.close(); }
});

test('pool evicts only idle LRU connections and counts sockets until they close', async () => {
  const peer = await localRelay();
  try {
    const observations: relayAdapter.RelayObservation[] = [];
    await relayAdapter.withRelayQuery({ maxConnections: 2, observer: { report: event => observations.push(event) } }, async query => {
      for (const path of ['/a', '/b', '/a', '/c', '/b']) assert.ok((await query.query(request(peer.relay + path))).ok);
      assert.equal(peer.counts().handshakes, 4);
      assert.ok(observations.every(event => !('ownedSockets' in event) || event.ownedSockets <= 2));
    });
  } finally { await peer.close(); }
});

test('interruption settles an active page, queued scopes and pool-capacity waits without replay', async () => {
  let seen!: () => void;
  const firstRequest = new Promise<void>(resolve => { seen = resolve; });
  const peer = await localRelay(() => seen(), { max_subscriptions: 1 });
  const controller = new AbortController();
  try {
    await relayAdapter.withRelayQuery({ signal: controller.signal, maxConnections: 1 }, async query => {
      const pending = Array.from({ length: 8 }, (_, i) => query.query(request(peer.relay, i + 1)));
      const poolWait = query.query(request(peer.relay + '/other'));
      await firstRequest;
      controller.abort();
      const results = await Promise.all([...pending, poolWait]);
      assert.ok(results.every(result => !result.ok));
      assert.equal(peer.requests.length, 1);
      assert.equal(peer.counts().handshakes, 1);
    });
  } finally { await peer.close(); }
});

test('zero advertised capacity fails without connecting and invalid optional caps still allow reads', async () => {
  for (const cap of [0, undefined, -1, 1.5, '2']) {
    const peer = await localRelay(undefined, { max_subscriptions: cap });
    // Malformed advertisements are intentionally ignored by the wire fixture too.
    try {
      await relayAdapter.withRelayQuery({}, async query => {
        const result = await query.query(request(peer.relay));
        assert.equal(result.ok, cap !== 0);
        assert.equal(peer.counts().handshakes, cap === 0 ? 0 : 1);
        if (!result.ok) assert.match(result.error.message, /zero subscription capacity/);
      });
    } finally { await peer.close(); }
  }
});

test('CLOSED and deadline release only their own slot and leave sibling scopes usable', async () => {
  for (const mode of ['closed', 'deadline']) {
    let count = 0;
    const peer = await localRelay((client, id) => {
      if (++count === 1) { if (mode === 'closed') { client.send(JSON.stringify(['CLOSED', id, 'restricted'])); return 'closed'; } }
      else client.send(JSON.stringify(['EOSE', id]));
    }, { max_subscriptions: 1 });
    try {
      await relayAdapter.withRelayQuery({}, async query => {
        const results = await Promise.all([1, 2, 3].map(scope => query.query({ ...request(peer.relay, scope), timeoutMs: 100 })));
        assert.deepEqual(results.map(result => result.ok), [false, true, true]);
        if (!results[0].ok) assert.match(results[0].error.message, mode === 'closed' ? /restricted/ : /Timed out/);
        assert.equal(peer.counts().handshakes, 1);
        // Barrier: this request reaches the peer after the preceding CLOSE frames.
        assert.ok((await query.query(request(peer.relay, 4))).ok);
        assert.equal(peer.closes.length, mode === 'closed' ? 2 : 3);
        assert.equal(new Set(peer.closes).size, peer.closes.length, 'SDK closes each settled subscription once');
      });
    } finally { await peer.close(); }
  }
});

test('shared disconnect fails active and unsent scopes and a later scope can reconnect', async () => {
  let drop = true;
  const peer = await localRelay((client, id) => { if (drop) client.terminate(); else client.send(JSON.stringify(['EOSE', id])); }, { max_subscriptions: 1 });
  try {
    await relayAdapter.withRelayQuery({}, async query => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => query.query(request(peer.relay, i + 1))));
      assert.ok(results.every(result => !result.ok));
      assert.equal(peer.requests.length, 1);
      drop = false;
      assert.ok((await query.query(request(peer.relay, 9))).ok);
      assert.equal(peer.counts().handshakes, 2);
    });
  } finally { await peer.close(); }
});

test('managed exits preserve success, typed failure and exception and reject escaped capabilities before metadata', async () => {
  const peer = await localRelay();
  try {
    for (const exit of ['success', 'failure', 'exception']) {
      let escaped!: RelayQuery;
      let metadata = 0;
      const operation = relayAdapter.withRelayQuery({ limits: { async get() { metadata++; return {}; } } }, async query => {
        escaped = query; assert.ok((await query.query(request(peer.relay))).ok);
        if (exit === 'exception') throw new Error('caller exception');
        return { ok: exit === 'success', marker: 'unchanged result' };
      });
      if (exit === 'exception') await assert.rejects(operation, /caller exception/);
      else assert.deepEqual(await operation, { ok: exit === 'success', marker: 'unchanged result' });
      const before = metadata;
      assert.equal((await escaped.query(request(peer.relay + '/escaped'))).ok, false);
      assert.equal(metadata, before);
    }
  } finally { await peer.close(); }
});

test('shutdown during a pending handshake clears SDK timers and settles borrowed reads', { timeout: 2000 }, async () => {
  const { createServer } = await import('node:http');
  const server = createServer();
  let seen!: () => void;
  const upgrading = new Promise<void>(resolve => { seen = resolve; });
  const stalled = new Set<import('node:stream').Duplex>();
  server.on('upgrade', (_req, socket) => { stalled.add(socket); seen(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const controller = new AbortController();
    await relayAdapter.withRelayQuery({ limits: { get: async () => ({}) }, signal: controller.signal }, async query => {
      const pending = query.query({ ...request(`ws://127.0.0.1:${address.port}`), timeoutMs: 30000 });
      await upgrading; controller.abort();
      assert.equal((await pending).ok, false);
    });
  } finally { for (const socket of stalled) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('eight failed handshakes share one attempt and retain the existing cooldown', async () => {
  const peer = await localRelay();
  const relay = peer.relay; await peer.close();
  let time = 0;
  await relayAdapter.withRelayQuery({ limits: { get: async () => ({}) }, now: () => time }, async query => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => query.query(request(relay, i))));
    assert.ok(results.every(result => !result.ok));
    const skipped = await query.query(request(relay, 10));
    assert.ok(!skipped.ok); assert.match(skipped.error.message, /cooldown/);
    time = 30000;
    const retry = await query.query(request(relay, 11));
    assert.ok(!retry.ok); assert.doesNotMatch(retry.error.message, /cooldown/);
  });
});

test('a later page failure preserves verified events as incomplete', async () => {
  const { finalizeEvent } = await import('nostr-tools');
  const note = finalizeEvent({ kind: 1, created_at: 1800000000,
    content: 'Synthetic relay pagination fixture', tags: [] }, new Uint8Array(32).fill(1));
  let page = 0;
  const peer = await localRelay((client, id) => {
    if (++page === 1) { client.send(JSON.stringify(['EVENT', id, note])); client.send(JSON.stringify(['EOSE', id])); }
    else client.terminate();
  });
  try {
    await relayAdapter.withRelayQuery({}, async query => {
      const result = await query.query({ ...request(peer.relay), filter: { kinds: [1] } });
      assert.ok(result.ok);
      assert.equal(result.value.complete, false);
      assert.equal(result.value.pages, 2);
      assert.deepEqual(result.value.events.map(event => event.id), [note.id]);
    });
  } finally { await peer.close(); }
});

test('busy connections survive pool contention and all scopes eventually complete within the socket bound', async () => {
  const peer = await localRelay((client, id) => setImmediate(() => client.send(JSON.stringify(['EOSE', id]))));
  const observations: relayAdapter.RelayObservation[] = [];
  try {
    await relayAdapter.withRelayQuery({ maxConnections: 2, observer: { report: event => observations.push(event) } }, async query => {
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => query.query(request(`${peer.relay}/${i % 3}`, i))));
      assert.ok(results.every(result => result.ok));
      assert.ok(observations.every(event => !('ownedSockets' in event) || event.ownedSockets <= 2));
    });
    const released = observations.filter(event => event.type === 'socket-released');
    const last = released.at(-1); assert.ok(last && 'ownedSockets' in last); assert.equal(last.ownedSockets, 0);
  } finally { await peer.close(); }
});

test('reuse preserves message-limit admission across SDK subscription ID length boundaries', async () => {
  // Original fresh transport uses five-character sub:1 IDs for each independent page.
  const sample = request('ws://unused');
  const maximum = Buffer.byteLength(JSON.stringify(['REQ', 'sub:1', { ...sample.filter, limit: sample.pageSize }]));
  const peer = await localRelay(undefined, { max_message_length: maximum });
  try {
    await relayAdapter.withRelayQuery({}, async query => {
      for (let scope = 1; scope <= 40; scope++) assert.ok((await query.query(request(peer.relay, scope))).ok, `Scope ${scope} should retain message-limit admission.`);
      assert.equal(peer.counts().handshakes, 1);
    });
  } finally { await peer.close(); }
});
