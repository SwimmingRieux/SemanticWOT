import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { startWebServer } from '../../src/web/server.js';
import { createWebRuntime } from '../../src/web/runtime.js';
import { resolveConfiguration } from '../../src/index.js';
import type { FeedState } from '../../src/web/types.js';
import { controlledServices, requireWebRuntime } from './helpers/web-services.js';

async function state(url: string, viewer: string): Promise<FeedState> {
  return (await fetch(`${url}/api/feed?viewer=${viewer}`)).json();
}
async function submit(url: string, viewer: string, refresh = false) {
  return fetch(`${url}/api/feed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer, refresh }) });
}
async function finished(url: string, viewer: string) {
  const timeout = AbortSignal.timeout(10000);
  while (!timeout.aborted) {
    const current = await state(url, viewer);
    if (current.job && current.job.status !== 'running') return current;
    await setImmediate();
  }
  assert.fail('controlled workflow did not finish');
}

test('saved results survive disposable cache deletion at a separately configured durable path', async () => {
  const services = await controlledServices('openai');
  services.options.statePath = join(services.directory, 'saved', 'feeds.sqlite');
  let app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  try {
    await submit(app.url, services.viewer);
    const previous = await finished(app.url, services.viewer);
    assert.equal(previous.job?.status, 'completed'); assert.equal(previous.saved?.feed.items.length, 2);
    services.setMode('relay-error');
    await submit(app.url, services.viewer, true);
    const failed = await finished(app.url, services.viewer);
    assert.equal(failed.job?.status, 'failed'); assert.deepEqual(failed.saved, previous.saved);
    await app.close();
    for (const suffix of ['', '-wal', '-shm']) await rm(services.options.config.cachePath + suffix, { force: true });
    const requests = services.relay.requests.length, embeds = services.embeddingRequests.length;
    services.options.apiKey = undefined;
    app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
    const revisited = await state(app.url, services.viewer);
    assert.deepEqual(revisited.saved, previous.saved); assert.equal(revisited.job?.status, 'failed');
    assert.equal((await (await submit(app.url, services.viewer)).json()).disposition, 'saved');
    assert.equal(services.relay.requests.length, requests); assert.equal(services.embeddingRequests.length, embeds);
    // Only isolated fixture databases are inspected for dummy credential leakage.
    for (const path of await readdir(services.directory, { recursive: true, withFileTypes: true })) {
      if (path.isFile()) assert.ok(!(await readFile(join(path.parentPath, path.name))).includes(Buffer.from('dummy-browser-secret')), path.name);
    }
  } finally { await app.close(); await services.close(); }
});

test('stopping a first-use job during HTTP embeddings persists interruption and permits a safe retry', async () => {
  const services = await controlledServices('ollama'); services.holdEmbeddings();
  let app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
  try {
    const accepted = await (await submit(app.url, services.viewer)).json();
    await services.embeddingStarted;
    await app.close();
    app = await startWebServer({ runtime: requireWebRuntime(await createWebRuntime(services.options)), port: 0 });
    const interrupted = await state(app.url, services.viewer);
    assert.equal(interrupted.job?.status, 'interrupted'); assert.equal(interrupted.job?.id, accepted.job.id);
    assert.equal(interrupted.saved, undefined);
    const retry = await (await submit(app.url, services.viewer)).json();
    assert.equal(retry.disposition, 'accepted'); assert.notEqual(retry.job.id, accepted.job.id);
    services.releaseEmbeddings();
    const completed = await finished(app.url, services.viewer);
    assert.equal(completed.job?.status, 'completed'); assert.equal(completed.saved?.feed.items.length, 2);
  } finally { services.releaseEmbeddings(); await app.close(); await services.close(); }
});

test('startup returns actionable cache failures for invalid storage paths and permits retry after repair', async t => {
  for (const failure of ['data-directory', 'application-cache', 'saved-feeds'] as const) await t.test(failure, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wot-startup-'));
    const blocked = join(directory, 'blocked-private-path');
    try {
      if (failure === 'data-directory') await writeFile(blocked, 'not a directory');
      else await mkdir(blocked);
      const checked = resolveConfiguration({ file: { cachePath: failure === 'data-directory' ? join(blocked, 'wot.sqlite') : failure === 'application-cache' ? blocked : join(directory, 'wot.sqlite') } });
      assert.ok(checked.ok);
      const options = { config: checked.value, statePath: failure === 'saved-feeds' ? blocked : join(directory, 'web-state.sqlite') };
      const result = await createWebRuntime(options);
      assert.deepEqual(result, { ok: false, error: { code: 'cache-failure', message: failure === 'saved-feeds'
        ? 'Cannot open saved feeds. Check the server data directory.'
        : failure === 'application-cache' ? 'Cannot open the application cache. Check the configured data directory.'
        : 'Cannot create the data directory. Check the configured data directory.' } });
      await rm(blocked, { recursive: true, force: true });
      const retried = await createWebRuntime(options);
      assert.ok(retried.ok);
      await retried.value.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
