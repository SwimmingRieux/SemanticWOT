import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { localRelay } from './helpers/relay.js';
import type { WebRuntime } from '../../src/web/types.js';
const { createProfileReader } = await import(new URL('../../dist/web/profiles.js', import.meta.url).href) as typeof import('../../src/web/profiles.js');
const { startWebServer } = await import(new URL('../../dist/web/server.js', import.meta.url).href) as typeof import('../../src/web/server.js');

test('profile HTTP lookup selects latest signed metadata and caches success and unavailable profiles without feed work', async () => {
  const secret = new Uint8Array(32).fill(3), author = getPublicKey(secret), missing = 'a'.repeat(64);
  const metadata = [
    finalizeEvent({ kind: 0, created_at: 100, content: JSON.stringify({ name: 'old' }), tags: [] }, secret),
    finalizeEvent({ kind: 0, created_at: 101, content: JSON.stringify({ display_name: '<img src=x onerror=alert(1)>', picture: 'javascript:alert(1)' }), tags: [] }, secret),
  ];
  let calls = 0;
  const relay = await localRelay((client, id, filter) => { calls++; assert.deepEqual(filter.kinds, [0]); for (const event of metadata) client.send(JSON.stringify(['EVENT', id, event])); client.send(JSON.stringify(['EOSE', id])); });
  const runtime: WebRuntime = { submit() { throw new Error('profile lookup must not submit feed'); }, read() { throw new Error('profile lookup must not read feed'); }, async close() {} };
  let time = 1000;
  const app = await startWebServer({ runtime, port: 0, profileReader: createProfileReader({ relays: [relay.relay], timeoutMs: 200, now: () => time }) });
  try {
    const url = `${app.url}/api/profiles?authors=${author},${missing}`;
    const response = await fetch(url); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { profiles: [{ pubkey: author, name: '<img src=x onerror=alert(1)>' }, { pubkey: missing }] });
    const afterFirst = calls;
    assert.equal((await fetch(url)).status, 200); assert.equal(calls, afterFirst);
    assert.equal((await fetch(`${app.url}/api/profiles?authors=nsec1invalid`)).status, 400);
    assert.equal(calls, afterFirst);
    time += 300001;
    await fetch(url); assert.equal(calls, afterFirst + 1, 'negative cache expires after five minutes');
    time += 3600001;
    await fetch(url); assert.equal(calls, afterFirst + 2, 'positive cache expires after an hour');
  } finally { await app.close(); await relay.close(); }
});
