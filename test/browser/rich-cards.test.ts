import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { launchBrowser, capture } from './helpers.js';
import { controlledServices, requireWebRuntime } from '../integration/helpers/web-services.js';
import { localRelay } from '../integration/helpers/relay.js';
import { receipt, now } from '../fixtures.js';
const { startWebServer } = await import(new URL('../../dist/web/server.js', import.meta.url).href) as typeof import('../../src/web/server.js');
const { createWebRuntime } = await import(new URL('../../dist/web/runtime.js', import.meta.url).href) as typeof import('../../src/web/runtime.js');

async function richServices() {
  const services = await controlledServices('ollama');
  const media = createServer((req, res) => { if (req.url === '/ok.png') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240"><rect width="480" height="240" fill="#e4ecdf"/><circle cx="360" cy="65" r="28" fill="#e5c878"/><path d="M0 200L130 60L280 220L390 130L480 200V240H0Z" fill="#799376"/><path d="M0 215L170 150L310 190L480 150V240H0Z" fill="#3f654a"/></svg>'); } else { res.statusCode = 404; res.end(); } });
  await new Promise<void>(resolve => media.listen(0, '127.0.0.1', resolve));
  const address = media.address(); assert.ok(address && typeof address !== 'string');
  const mediaUrl = `http://127.0.0.1:${address.port}`;
  const seed = services.inventory.events.find(event => event.kind === 1)!;
  const originalZaps = services.inventory.events.filter(event => event.kind === 9735).slice(0, 2);
  const reference = nip19.noteEncode(seed.id), profileReference = nip19.npubEncode(seed.pubkey);
  const secrets = [4, 5, 6, 7].map(value => new Uint8Array(32).fill(value));
  const content = [
    `Long reading note <img src=x onerror="window.hostile=true"> & <script>window.hostile=true</script>\n${'Thoughtful open networks. '.repeat(80)}\nFull ending. https://example.com/read?x=1&y=2 nostr:${reference} nostr:${profileReference} javascript:alert(1) data:text/html,bad`,
    `Image note\n${mediaUrl}/ok.png\n${mediaUrl}/broken.jpg`,
    'Malformed profile remains readable.', 'Missing profile remains readable.',
  ];
  const notes = content.map((content, index) => finalizeEvent({ kind: 1, created_at: now - 50 + index, content, tags: [] }, secrets[index]));
  const curator = new Uint8Array(32).fill(2), signer = new Uint8Array(32).fill(3);
  const zaps = notes.map((note, index) => {
    const id = index + 10, amount = 1000000 + id;
    const request = finalizeEvent({ kind: 9734, created_at: now - 20 + id, content: '', tags: [['e', note.id], ['p', note.pubkey], ['amount', String(amount)]] }, curator);
    const unsigned = receipt(id, 1, 1, amount); unsigned.created_at = request.created_at;
    unsigned.tags = unsigned.tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(request)] : tag[0] === 'P' ? ['P', request.pubkey] : tag[0] === 'e' ? ['e', note.id] : tag);
    unsigned.tags.push(['p', note.pubkey]); return finalizeEvent(unsigned, signer);
  });
  services.inventory.events.splice(0, Infinity, seed, ...notes, ...originalZaps, ...zaps);
  const profiles = [
    finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ display_name: '<svg onload="window.hostile=true">', picture: `${mediaUrl}/avatar-broken.png` }) }, secrets[0]),
    finalizeEvent({ kind: 0, created_at: now, tags: [], content: JSON.stringify({ name: 'River', picture: `${mediaUrl}/ok.png` }) }, secrets[1]),
    finalizeEvent({ kind: 0, created_at: now, tags: [], content: '{invalid JSON' }, secrets[2]),
  ];
  let profileCalls = 0;
  let releaseProfiles: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { releaseProfiles = resolve; });
  const profileRelay = await localRelay(async (client, id, filter) => { profileCalls++; await gate; for (const event of profiles.filter(event => matchFilter(filter, event))) client.send(JSON.stringify(['EVENT', id, event])); client.send(JSON.stringify(['EOSE', id])); });
  return { ...services, notes, reference, profileReference, authors: secrets.map(getPublicKey), profileRelay, profileCalls: () => profileCalls, releaseProfiles: () => releaseProfiles?.(), async close() { releaseProfiles?.(); await profileRelay.close(); media.closeAllConnections(); await new Promise<void>(resolve => media.close(() => resolve())); await services.close(); } };
}

test('shipped cards preserve ranked order while profiles load and safely render long notes, links, Nostr references and media fallbacks', async () => {
  const services = await richServices();
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0, profileRelays: [services.profileRelay.relay], profileTimeoutMs: 3000 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(app.url); await page.getByLabel('Nostr public key').fill(services.viewer); await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('article').filter({ hasText: 'Long reading note' }).waitFor();
    const state = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json();
    const order = state.saved.feed.items.map((item: { id: string }) => item.id);
    assert.deepEqual(await page.locator('.post').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-note-id'))), order);
    services.releaseProfiles();
    await page.getByText('<svg onload="window.hostile=true">', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.post').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-note-id'))), order);
    const long = page.getByRole('article').filter({ hasText: 'Long reading note' });
    const expand = long.locator('.expand-note');
    assert.equal(await expand.innerText(), 'Read full note');
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    await expand.click(); assert.equal(await expand.getAttribute('aria-expanded'), 'true');
    await long.getByText('Full ending.', { exact: false }).waitFor();
    assert.equal(await long.getByRole('link', { name: 'https://example.com/read?x=1&y=2', exact: true }).getAttribute('href'), 'https://example.com/read?x=1&y=2');
    assert.equal(await long.locator(`a[href="https://njump.me/${services.reference}"]`).count(), 1);
    assert.equal(await long.locator(`a[href="https://njump.me/${services.profileReference}"]`).count(), 1);
    assert.equal(await page.locator('a[href^="javascript:"],a[href^="data:"],script:not([src])').count(), 0);
    assert.equal(await page.evaluate(() => 'hostile' in window), false);
    assert.equal(await long.locator('.post-content img,.post-content script,.author-name svg').count(), 0);
    await page.getByText('Image unavailable', { exact: true }).waitFor();
    assert.equal(await page.locator('.post-image').count(), 1);
    assert.equal(await page.locator('.post-image').evaluate(image => (image as HTMLImageElement).naturalWidth > 0), true);
    assert.equal(await page.locator('.avatar-image').count(), 1);
    for (const author of services.authors.slice(2)) await page.locator('.author-name').filter({ hasText: `${author.slice(0, 8)}…${author.slice(-6)}` }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open in Nostr client' }).count(), order.length);
    for (const id of order) assert.equal(await page.locator(`[data-note-id="${id}"] .open-note`).getAttribute('href'), `https://njump.me/${nip19.noteEncode(id)}`);
    await capture(page, 'rich-desktop-expanded');
    await expand.click(); await capture(page, 'rich-desktop-collapsed');
    const calls = services.profileCalls();
    await page.reload(); await page.getByText('River', { exact: true }).waitFor(); assert.equal(services.profileCalls(), calls);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await capture(page, 'rich-mobile');
  } finally { services.releaseProfiles(); await browser.close(); await app.close(); await services.close(); }
});


test('unavailable profile relay leaves a completed feed and avatar fallbacks readable', async () => {
  const services = await controlledServices('openai');
  const profiles = await localRelay((client, id) => client.send(JSON.stringify(['CLOSED', id, 'metadata offline'])));
  const app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0, profileRelays: [profiles.relay], profileTimeoutMs: 200 });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage(); await page.goto(app.url);
    const lookup = page.waitForResponse(response => response.url().includes('/api/profiles?'));
    await page.getByLabel('Nostr public key').fill(services.viewer); await page.getByRole('button', { name: 'Find my feed' }).click();
    await page.getByRole('article').filter({ hasText: 'A recommended note about open networks.' }).waitFor();
    const response = await lookup; assert.equal(response.status(), 200);
    assert.deepEqual(await response.json(), { profiles: [{ pubkey: services.inventory.recommended.pubkey }] });
    const calls = profiles.requests.length;
    await fetch(`${app.url}/api/profiles?authors=${services.inventory.recommended.pubkey}`);
    assert.equal(profiles.requests.length, calls, 'unavailable profiles are cached too');
    const author = services.inventory.recommended.pubkey;
    assert.deepEqual(await page.locator('.author-name').allTextContents(), Array(2).fill(`${author.slice(0, 8)}…${author.slice(-6)}`));
    assert.equal(await page.locator('.avatar').count(), 2); assert.equal(await page.locator('.avatar-image').count(), 0);
    const state = await (await fetch(`${app.url}/api/feed?viewer=${services.viewer}`)).json(); assert.equal(state.job.status, 'completed');
    await capture(page, 'profile-outage');
  } finally { await browser.close(); await app.close(); await profiles.close(); await services.close(); }
});
