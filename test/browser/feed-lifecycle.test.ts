import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, capture } from './helpers.js';
import { controlledServices, requireWebRuntime } from '../integration/helpers/web-services.js';
const { startWebServer } = await import(new URL('../../dist/web/server.js', import.meta.url).href) as typeof import('../../src/web/server.js');
const { createWebRuntime } = await import(new URL('../../dist/web/runtime.js', import.meta.url).href) as typeof import('../../src/web/runtime.js');

test('a saved feed survives app restart and a browser revisit without implicit collection', async () => {
  const services = await controlledServices('ollama');
  let app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(app.url);
    await page.getByLabel('Nostr public key').fill(services.viewer);
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    const previous = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    await app.close();
    app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
    const requests = services.relay.requests.length, embeds = services.embeddingRequests.length;
    await page.goto(`${app.url}/?viewer=${services.viewer}`);
    await page.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    const revisited = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.deepEqual(revisited.saved, previous.saved);
    assert.equal(services.relay.requests.length, requests);
    assert.equal(services.embeddingRequests.length, embeds);
    assert.equal(await page.getByRole('article').count(), 2);
    assert.match(await page.locator('#feed-age').innerText(), /Completed/);
  } finally { await browser.close(); await app.close(); await services.close(); }
});

test('simultaneous normalized submissions reconnect, another key is busy, and closing a tab keeps work alive', async () => {
  const services = await controlledServices('openai'); services.holdEmbeddings();
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  const browser = await launchBrowser();
  try {
    const { nip19 } = await import('nostr-tools');
    const submit = (viewer: string) => fetch(app.url + '/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer }) });
    const responses = await Promise.all([submit(services.viewer), submit(nip19.npubEncode(services.viewer))]);
    const states = await Promise.all(responses.map(response => response.json()));
    assert.deepEqual(states.map(state => state.disposition).sort(), ['accepted', 'existing']);
    assert.equal(states[0].job.id, states[1].job.id);
    const other = await submit('f'.repeat(64));
    assert.equal(other.status, 409); assert.equal((await other.json()).disposition, 'busy');
    await services.embeddingStarted;
    const busy = await browser.newPage(); await busy.goto(app.url);
    await busy.getByLabel('Nostr public key').fill('f'.repeat(64));
    await busy.getByRole('button', { name: 'Find my feed' }).click();
    await busy.getByRole('status').filter({ hasText: 'Another public key is being processed' }).waitFor();
    const first = await browser.newPage(); await first.goto(`${app.url}/?viewer=${services.viewer}`);
    await first.getByRole('status').filter({ hasText: 'Preparing semantic embeddings' }).waitFor();
    await first.close();
    const returning = await browser.newPage(); await returning.goto(`${app.url}/?viewer=${services.viewer}`);
    await returning.getByRole('status').filter({ hasText: 'Preparing semantic embeddings' }).waitFor();
    const current = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(current.job.id, states[0].job.id);
    assert.equal(services.embeddingRequests.length, 1);
    services.releaseEmbeddings();
    await returning.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    assert.equal(await returning.getByRole('article').count(), 2);
  } finally { services.releaseEmbeddings(); await browser.close(); await app.close(); await services.close(); }
});

test('refresh preserves readable saved results during other work and after failure, then explicitly retries', async () => {
  const services = await controlledServices('ollama');
  services.options.config.relayTimeoutMs = 10000;
  let clock = services.options.clock!.now(); services.options.clock = { now: () => clock };
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(`${app.url}/?viewer=${services.viewer}`);
    await page.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    const before = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    const initialEmbeddings = services.embeddingRequests.length;
    const blocked = services.holdRelays(); clock += 60;
    await page.getByRole('button', { name: 'Refresh feed' }).click(); await blocked;
    assert.equal(await page.getByRole('article').count(), 2);
    await capture(page, 'saved-during-refresh');
    assert.deepEqual((await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json()).saved, before.saved);
    services.setMode('relay-error'); services.releaseRelays();
    await page.getByRole('status').filter({ hasText: 'Refresh to retry' }).waitFor();
    assert.equal(await page.getByRole('article').count(), 2);
    const failed = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(failed.job.status, 'failed'); assert.deepEqual(failed.saved, before.saved);
    const requests = services.relay.requests.length;
    await page.reload(); await page.getByRole('status').filter({ hasText: 'Refresh to retry' }).waitFor();
    assert.equal(services.relay.requests.length, requests);
    services.setMode('feed');
    const busyStarted = services.holdRelays();
    await fetch(app.url + '/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer: 'f'.repeat(64) }) });
    await busyStarted;
    const savedRead = await fetch(app.url + '/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer: services.viewer }) });
    assert.equal(savedRead.status, 200); assert.deepEqual((await savedRead.json()).saved, before.saved);
    const blockedRefresh = await fetch(app.url + '/api/feed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer: services.viewer, refresh: true }) });
    assert.equal(blockedRefresh.status, 409); assert.deepEqual((await blockedRefresh.json()).saved, before.saved);
    // The other viewer has no seeds and completes without changing this saved result.
    services.releaseRelays();
    const other = await browser.newPage(); await other.goto(`${app.url}/?viewer=${'f'.repeat(64)}`);
    await other.getByRole('status').filter({ hasText: 'No usable sent note-zaps' }).waitFor();
    await page.getByRole('button', { name: 'Refresh feed' }).click();
    await page.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    const refreshed = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(refreshed.job.status, 'completed'); assert.equal(refreshed.saved.completedAt, clock);
    assert.equal(services.embeddingRequests.length, initialEmbeddings, 'compatible vectors are reused during explicit refresh');
  } finally { services.releaseRelays(); await browser.close(); await app.close(); await services.close(); }
});

test('a killed process leaves refresh interrupted and retryable while preserving its last feed', async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const services = await controlledServices('ollama'); services.options.config.relayTimeoutMs = 10000;
  let clock = services.options.clock!.now();
  async function start() {
    const child = fork(new URL('./runtime-process.ts', import.meta.url), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const ready = new Promise<{ url: string }>((resolve, reject) => {
      child.once('message', value => resolve(value as { url: string }));
      child.once('exit', code => reject(new Error(`Runtime process exited before startup (${code}).`)));
      child.once('error', reject);
    });
    child.send({ config: services.options.config, apiKey: services.options.apiKey, now: clock });
    const message = await ready;
    return { child, url: message.url, async stop(signal: NodeJS.Signals) { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill(signal); await exited; } };
  }
  let app = await start();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(`${app.url}/?viewer=${services.viewer}`);
    await page.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    const before = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    const initialEmbeddings = services.embeddingRequests.length;
    const blocked = services.holdRelays();
    await page.getByRole('button', { name: 'Refresh feed' }).click(); await blocked;
    const running = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(running.job.status, 'running'); assert.deepEqual(running.saved, before.saved);
    await app.stop('SIGKILL'); services.releaseRelays(); clock += 90;
    app = await start();
    const requests = services.relay.requests.length;
    await page.goto(`${app.url}/?viewer=${services.viewer}`);
    await page.getByRole('status').filter({ hasText: 'Processing was interrupted' }).waitFor();
    assert.match(await page.getByRole('status').innerText(), /Refresh to retry/);
    await capture(page, 'interrupted-refresh');
    const interrupted = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(interrupted.job.id, running.job.id); assert.equal(interrupted.job.status, 'interrupted');
    assert.deepEqual(interrupted.saved, before.saved); assert.equal(await page.getByRole('article').count(), 2);
    assert.equal(services.relay.requests.length, requests, 'revisiting interrupted work must not implicitly refresh');
    await page.getByRole('button', { name: 'Refresh feed' }).click();
    await page.getByRole('status').filter({ hasText: 'Your feed is ready' }).waitFor();
    const retry = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(retry.job.status, 'completed'); assert.notEqual(retry.job.id, running.job.id);
    assert.equal(retry.saved.completedAt, clock); assert.equal(services.embeddingRequests.length, initialEmbeddings);
  } finally { services.releaseRelays(); await browser.close(); await app.stop('SIGTERM'); await services.close(); }
});
