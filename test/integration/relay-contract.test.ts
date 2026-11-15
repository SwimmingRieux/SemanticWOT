import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { key } from '../fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { Duplex } from 'node:stream';
import { createRelayPageReader, createRelayQuery } from '../../src/adapters/relay.js';

test('connection cooldown lets independent crawl scopes fail promptly and retries a recovered relay after expiry', async () => {
  const server = createServer();
  const stalled = new Set<Duplex>();
  const sockets = new WebSocketServer({ noServer: true });
  let accepting = false, time = 0;
  server.on('upgrade', (request, socket) => {
    if (!accepting && request.url !== '/healthy') { stalled.add(socket); return; }
    sockets.handleUpgrade(request, socket, Buffer.alloc(0), client => client.on('message', payload => {
      const message = JSON.parse(payload.toString()) as string[];
      if (message[0] === 'REQ') client.send(JSON.stringify(['EOSE', message[1]]));
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const query = createRelayQuery({ now: () => time });
    const request = { relay: `ws://127.0.0.1:${address.port}`, filter: { kinds: [9735] }, timeoutMs: 100, pageSize: 20, maxPages: 1, maxEvents: 20 };
    const failed = await query.query(request);
    assert.ok(!failed.ok); assert.match(failed.error.message, /timed out/i);
    const healthy = await query.query({ ...request, relay: `${request.relay}/healthy` });
    assert.ok(healthy.ok); assert.equal(healthy.value.complete, true);
    accepting = true;
    for (let scope = 1; scope <= 5; scope++) {
      const skipped = await query.query({ ...request, filter: { ...request.filter, '#e': [key(scope)] } });
      assert.ok(!skipped.ok); assert.match(skipped.error.message, /connection cooldown/i);
    }
    time = 30_000;
    const recovered = await query.query(request);
    assert.ok(recovered.ok); assert.equal(recovered.value.complete, true);
  } finally {
    for (const socket of stalled) socket.destroy();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('relay connection refusal and invalid endpoint return typed failures', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  for (const relay of [`ws://127.0.0.1:${address.port}`, 'not a relay URL']) {
    const result = await createRelayPageReader().read({ relay, filter: { kinds: [9735] }, timeoutMs: 100, pageSize: 20, maxPages: 1, maxEvents: 20 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'relay-failure');
  }
});

test('a stalled WebSocket handshake returns a typed timeout without an unhandled transport error', async () => {
  const server = createServer();
  const sockets = new Set<Duplex>();
  server.on('upgrade', (_request, socket) => { sockets.add(socket); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const result = await createRelayPageReader().read({ relay: `ws://127.0.0.1:${address.port}`, filter: { kinds: [9735] }, timeoutMs: 100, pageSize: 20, maxPages: 1, maxEvents: 20 });
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, 'relay-failure'); assert.match(result.error.message, /timed out/i); }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('nostr-tools adapter recognizes wire EOSE and rejects CLOSED and deadline expiry', async () => {
  for (const mode of ['empty', 'closed', 'timeout']) {
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket) => {
      sockets.handleUpgrade(request, socket, Buffer.alloc(0), client => client.on('message', payload => {
        const message = JSON.parse(payload.toString()) as string[];
        if (message[0] !== 'REQ' || mode === 'timeout') return;
        client.send(JSON.stringify(mode === 'empty' ? ['EOSE', message[1]] : ['CLOSED', message[1], 'restricted']));
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const query = createRelayQuery();
      const request = { relay: `ws://127.0.0.1:${address.port}`, filter: { kinds: [9735] }, timeoutMs: 100, pageSize: 20, maxPages: 1, maxEvents: 20 };
      const result = await query.query(request);
      assert.equal(result.ok, mode === 'empty');
      if (result.ok) {
        assert.deepEqual(result.value.events, []);
        const directory = await mkdtemp(join(tmpdir(), 'wot-empty-index-'));
        try {
          const cache = join(directory, 'cache.sqlite');
          const indexed = await promisify(execFile)(process.execPath, ['dist/cli.js', 'index', key(10), '--cache', cache, '--relays', `ws://127.0.0.1:${address.port}`, '--relay-timeout-ms', '100', '--endpoint', 'http://127.0.0.1:1', '--compact']);
          assert.deepEqual(JSON.parse(indexed.stdout).seeds, { referenced: 0, found: 0, missing: 0 });
          assert.match(indexed.stderr, /no-seeds/);
          const feed = await promisify(execFile)(process.execPath, ['dist/cli.js', 'feed', key(10), '--cache', cache, '--offline', '--compact']);
          assert.deepEqual(JSON.parse(feed.stdout).items, []);
        } finally { await rm(directory, { recursive: true, force: true }); }
      }
      else {
        assert.match(result.error.message, mode === 'closed' ? /restricted/ : /Timed out/);
        const retried = await query.query({ ...request, filter: { kinds: [1] } });
        assert.ok(!retried.ok);
        assert.match(retried.error.message, mode === 'closed' ? /restricted/ : /Timed out/);
        assert.doesNotMatch(retried.error.message, /cooldown/i);
      }
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
