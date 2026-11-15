import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser, capture } from './helpers.js';
// Exercise the built modules and copied assets that the packaged app actually serves.
const { startWebServer } = await import(new URL('../../dist/web/server.js', import.meta.url).href) as typeof import('../../src/web/server.js');
const { createWebRuntime } = await import(new URL('../../dist/web/runtime.js', import.meta.url).href) as typeof import('../../src/web/runtime.js');
import { controlledServices, requireWebRuntime } from '../integration/helpers/web-services.js';

test('a viewer submits a public key and reads a feed through the shipped Ollama app', async () => {
  const services = await controlledServices('ollama');
  const runtime = requireWebRuntime(await createWebRuntime(services.options));
  const app = await startWebServer({ runtime, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(app.url);
    await page.getByLabel('Nostr public key').fill(services.viewer);
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('article').filter({ hasText: 'A recommended note about open networks.' }).waitFor();
    assert.equal(await page.getByRole('article').count(), 2);
    await page.getByRole('complementary', { name: 'Discovery limitations' }).filter({ hasText: 'Some relay evidence was unavailable or capped' }).waitFor();
    assert.ok(services.embeddingRequests.length > 0);
    await capture(page, 'desktop-feed');
  } finally { await browser.close(); await app.close(); await services.close(); }
});

test('OpenAI first use validates keys, shows actual embedding progress, normalizes npub and keeps credentials on the server', async () => {
  const services = await controlledServices('openai'); services.holdEmbeddings();
  const runtime = requireWebRuntime(await createWebRuntime(services.options));
  const app = await startWebServer({ runtime, port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(app.url);
    await page.getByLabel('Nostr public key').fill('nsec1never-submit-private-keys');
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('status').filter({ hasText: 'Never enter a private key' }).waitFor();
    assert.equal(services.relay.requests.length, 0);
    const { nip19 } = await import('nostr-tools');
    await page.getByLabel('Nostr public key').fill(nip19.npubEncode(services.viewer));
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await services.embeddingStarted;
    await page.getByRole('status').filter({ hasText: 'Preparing semantic embeddings · 0 of 2' }).waitFor();
    const running = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(running.viewer, services.viewer); assert.equal(running.job.status, 'running');
    assert.deepEqual(running.job.progress, { phase: 'embeddings', completed: 0, total: 2 });
    services.releaseEmbeddings();
    await page.getByRole('article').filter({ hasText: 'A recommended note about open networks.' }).waitFor();
    assert.equal(services.embeddingRequests[0].path, '/v1/embeddings');
    assert.equal(services.embeddingRequests[0].authorization, 'Bearer dummy-browser-secret');
    const completed = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.deepEqual(await page.locator('.post-content').allTextContents(), completed.saved.feed.items.map((item: { content: string }) => item.content));
    for (const path of ['/', '/app.js', '/cards.js', '/styles.css', `/api/feed?viewer=${services.viewer}`]) {
      const body = await (await fetch(app.url + path)).text();
      assert.ok(!body.includes('dummy-browser-secret'), path);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await capture(page, 'mobile-feed');
  } finally { services.releaseEmbeddings(); await browser.close(); await app.close(); await services.close(); }
});

test('no usable note-zaps produces an explained empty success without requiring provider credentials', async () => {
  const services = await controlledServices('openai', 'empty'); services.options.apiKey = undefined;
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(app.url);
    await page.getByLabel('Nostr public key').fill(services.viewer);
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('status').filter({ hasText: 'No usable sent note-zaps were found' }).waitFor();
    const state = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(state.job.status, 'completed'); assert.equal(state.saved.emptyReason, 'no-seeds');
    assert.equal(services.embeddingRequests.length, 0); assert.equal(await page.getByRole('article').count(), 0);
  } finally { await browser.close(); await app.close(); await services.close(); }
});

for (const mode of ['embedding-error', 'relay-error'] as const) test(`${mode} remains a typed, actionable browser failure with retry`, async () => {
  const services = await controlledServices('ollama', mode);
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(app.url);
    await page.getByLabel('Nostr public key').fill(services.viewer);
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('status').filter({ hasText: 'Submit your key again to retry' }).waitFor();
    const state = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(state.job.status, 'failed'); assert.equal(state.job.error.code, mode === 'embedding-error' ? 'embedding-failure' : 'relay-failure');
    assert.ok(!JSON.stringify(state).includes('dummy-browser-secret'));
    assert.match(await page.getByRole('status').innerText(), mode === 'embedding-error' ? /Ollama.*installed model/ : /Relays.*connectivity/);
    assert.equal(await page.getByRole('article').count(), 0);
  } finally { await browser.close(); await app.close(); await services.close(); }
});

test('missing referenced content yields sparse-evidence guidance rather than a no-zap claim', async () => {
  const services = await controlledServices('openai', 'sparse');
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(app.url);
    await page.getByLabel('Nostr public key').fill(services.viewer);
    await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('status').filter({ hasText: 'No recommendations were found in the available evidence' }).waitFor();
    await page.getByRole('complementary', { name: 'Discovery limitations' }).filter({ hasText: 'Some referenced notes could not be found' }).waitFor();
    const state = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    assert.equal(state.job.status, 'completed'); assert.equal(state.saved.emptyReason, 'sparse-evidence');
    assert.equal(services.embeddingRequests.length, 0);
  } finally { await browser.close(); await app.close(); await services.close(); }
});
