import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createNip11Limits, createRelayQuery } from '../../src/adapters/relay.js';

test('independent relay scopes keep advertised limits when subsequent metadata requests are rate limited', async () => {
  let available = true, advertisedLimit = 7;
  const server = createServer((_request, response) => {
    if (!available) { response.writeHead(429); response.end(); return; }
    available = false;
    response.setHeader('Content-Type', 'application/nostr+json');
    response.end(JSON.stringify({ limitation: { max_limit: advertisedLimit } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const relay = `ws://127.0.0.1:${address.port}`;
  try {
    const query = createRelayQuery({ limits: createNip11Limits(), pageReader: { async read(input) {
      return input.pageSize <= advertisedLimit
        ? { ok: true, value: [] }
        : { ok: false, error: { code: 'relay-failure', message: 'Requested limit exceeds relay advertisement.' } };
    } } });
    const request = { relay, filter: { kinds: [9735] }, timeoutMs: 1000, pageSize: 500, maxPages: 1, maxEvents: 1000 };
    const first = await query.query(request);
    assert.ok(first.ok);
    const [second, third] = await Promise.all([
      query.query({ ...request, filter: { kinds: [9735], '#P': ['a'.repeat(64)] } }),
      query.query({ ...request, filter: { kinds: [9735], '#P': ['b'.repeat(64)] } }),
    ]);
    assert.ok(second.ok, 'A later scope should retain the already observed relay limit.');
    assert.ok(third.ok, 'Concurrent scopes should retain the same observed relay limit.');
    advertisedLimit = 11; available = true;
    assert.deepEqual(await createNip11Limits().get(relay, 1000), { maxLimit: 11, maxMessageLength: undefined });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
