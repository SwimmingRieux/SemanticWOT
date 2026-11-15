import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { controlledServices } from '../integration/helpers/web-services.js';
import type { FeedState } from '../../src/web/types.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../..');
async function docker(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = await run('docker', args, { cwd: root, env, timeout: 900_000, maxBuffer: 20_000_000 });
  if (args.includes('build')) console.log(result.stdout + result.stderr);
  return result.stdout.trim();
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const value = await read(); if (ready(value)) return value; } catch { /* app starting */ }
    await setTimeout(50);
  }
  assert.fail('Docker app did not reach the expected state within 30 seconds');
}

test('clean Compose image runs both provider paths and preserves saved feeds and embedding cache', { timeout: 1_200_000 }, async () => {
  // These are explicit, opt-in infrastructure checks, never part of unit/integration defaults.
  await readFile(join(root, 'compose.yaml'));
  const directory = await mkdtemp(join(tmpdir(), 'semanticwot-docker-'));
  const image = `semanticwot-acceptance:${process.pid}`;
  const projectPrefix = `wot-acceptance-${process.pid}`;
  const buildEnv = { ...process.env, WOT_IMAGE: image, WOT_ENV_FILE: join(directory, 'build.env') };
  await writeFile(buildEnv.WOT_ENV_FILE, '');
  try {
    assert.equal(await docker(['compose', '-p', projectPrefix, 'config', '--services'], buildEnv), 'app');
    await docker(['compose', '-p', projectPrefix, 'build', ...(process.env.DOCKER_ACCEPTANCE_BUILD_CACHE === '1' ? [] : ['--no-cache'])], buildEnv);
    // Inspect exactly what COPY can see: the allowlist excludes tests, contexts,
    // credentials, private TOML, generated assets and historical artifacts.
    const auditImage = `${image}-context`;
    const auditDockerfile = join(directory, 'Context.Dockerfile');
    await writeFile(auditDockerfile, 'FROM scratch\nCOPY . /context\n');
    let auditContainer: string | undefined;
    const excludedProbes = [join(root, `.env.docker-acceptance-${process.pid}`), join(root, `docker-acceptance-${process.pid}.sqlite`)];
    for (const probe of excludedProbes) await writeFile(probe, 'dummy-context-secret', { flag: 'wx' });
    try {
      await docker(['build', '-f', auditDockerfile, '-t', auditImage, '.']);
      auditContainer = await docker(['create', auditImage, 'unused']);
      const copied = join(directory, 'context');
      await docker(['cp', `${auditContainer}:/context`, copied]);
      const paths = await readdir(copied, { recursive: true, withFileTypes: true });
      const files = paths.filter(path => path.isFile()).map(path => join(path.parentPath, path.name).slice(copied.length + 1));
      assert.ok(files.includes('src/web/main.ts'));
      assert.ok(files.includes('scripts/copy-web-assets.mjs'));
      for (const file of files) assert.ok(/^(?:Dockerfile|package(?:-lock)?\.json|tsconfig\.json|src\/.+|scripts\/copy-web-assets\.mjs)$/.test(file), `unexpected Docker context file: ${file}`);
    } finally {
      if (auditContainer) await docker(['rm', auditContainer]);
      await docker(['image', 'rm', auditImage]).catch(() => {});
      for (const probe of excludedProbes) await rm(probe, { force: true });
    }
    // Resolve the packaged examples through the public loader in the final image;
    // maxRelays alone would not establish the required single relay default.
    for (const provider of ['ollama', 'openai'] as const) {
      const text = await docker(['run', '--rm', '--env-file', `examples/${provider}.env`, '--entrypoint', 'node', image, '--input-type=module', '-e', "import {loadConfiguration} from './dist/adapters/config.js'; const result=await loadConfiguration({cwd:'/app',home:'/home/node',environment:process.env}); if(!result.ok)throw Error(result.error.message); const {provider,model,dimensions,relays,maxRelays,maxSeedZaps,maxCoZappers,maxZapsPerCoZapper}=result.value; console.log(JSON.stringify({provider,model,dimensions,relays,maxRelays,maxSeedZaps,maxCoZappers,maxZapsPerCoZapper}));"]);
      assert.deepEqual(JSON.parse(text), { provider, model: provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small', dimensions: provider === 'ollama' ? 768 : 1536, relays: ['wss://nos.lol'], maxRelays: 1, maxSeedZaps: 20, maxCoZappers: 20, maxZapsPerCoZapper: 20 });
    }
    // Load the native module inside the final image, independent of host ABI/modules.
    assert.equal(await docker(['run', '--rm', '--entrypoint', 'node', image, '--input-type=module', '-e', "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('select 42 as n').get().n); db.close();"]), '42');
    for (const provider of ['ollama', 'openai'] as const) {
      const services = await controlledServices(provider, 'feed', { timestamp: Math.floor(Date.now() / 1000), bindHost: '0.0.0.0', advertisedHost: 'host.docker.internal' });
      const file = join(directory, `${provider}.env`);
      const example = await readFile(join(root, 'examples', `${provider}.env`), 'utf8');
      const endpoint = provider === 'ollama' ? `WOT_ENDPOINT=${services.options.config.endpoint}` : `WOT_OPENAI_ENDPOINT=${services.options.config.openaiEndpoint}\nOPENAI_API_KEY=dummy-docker-secret`;
      await writeFile(file, `${example}\n${endpoint}\nWOT_MODEL=fixture\nWOT_DIMENSIONS=2\nWOT_RELAYS=${services.options.config.relays[0]}\nWOT_RELAY_TIMEOUT_MS=2000\n`);
      const env = { ...process.env, WOT_IMAGE: image, WOT_ENV_FILE: file, PORT: '0' };
      const project = `${projectPrefix}-${provider}`;
      const compose = (...args: string[]) => docker(['compose', '-p', project, ...args], env);
      try {
        await compose('up', '-d', '--no-build', '--wait');
        const address = await compose('port', 'app', '3000');
        let url = `http://${address}`;
        assert.match(await (await fetch(url)).text(), /SemanticWOT/);
        assert.equal(services.embeddingPaths.length, 0, 'startup does not call an embedding provider');
        assert.equal(services.relay.requests.length, 0, 'startup does not collect relay events');
        const read = async (): Promise<FeedState> => (await fetch(`${url}/api/feed?viewer=${services.viewer}`)).json();
        const submit = async (refresh = false): Promise<FeedState> => (await fetch(`${url}/api/feed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewer: services.viewer, refresh }) })).json();
        const first = await submit(); assert.equal(first.disposition, 'accepted');
        const saved = await until(read, value => value.job?.status !== 'running');
        assert.equal(saved.job?.status, 'completed', JSON.stringify(saved));
        assert.equal(saved.saved?.feed.items.length, 2);
        assert.ok(services.embeddingRequests.length > 0);
        for (const request of services.embeddingRequests) {
          assert.equal(request.path, provider === 'ollama' ? '/api/embed' : '/v1/embeddings');
          assert.equal(request.authorization, provider === 'openai' ? 'Bearer dummy-docker-secret' : undefined);
        }
        const relayCount = services.relay.requests.length, embeddings = services.embeddingRequests.length;
        assert.equal((await submit()).disposition, 'saved');
        assert.deepEqual((await read()).saved, saved.saved);
        assert.equal(services.relay.requests.length, relayCount);
        assert.equal(services.embeddingRequests.length, embeddings);
        assert.equal((await submit(true)).disposition, 'accepted');
        const refreshed = await until(read, value => value.job?.status !== 'running');
        assert.equal(refreshed.job?.status, 'completed', JSON.stringify(refreshed));
        assert.notEqual(refreshed.job?.id, first.job?.id);
        assert.ok(services.relay.requests.length > relayCount);
        assert.equal(services.embeddingRequests.length, embeddings, 'refresh reuses compatible vectors');
        const beforeRestartRelays = services.relay.requests.length;
        await compose('restart', 'app');
        // Docker may reassign an ephemeral host port on container restart.
        url = `http://${await compose('port', 'app', '3000')}`;
        await until(async () => (await fetch(url)).status, status => status === 200);
        assert.deepEqual((await read()).saved, refreshed.saved);
        assert.equal((await submit()).disposition, 'saved');
        assert.equal(services.relay.requests.length, beforeRestartRelays, 'restart/revisit does not collect');
        assert.equal(services.embeddingRequests.length, embeddings);
        assert.equal((await submit(true)).disposition, 'accepted');
        const afterRestart = await until(read, value => value.job?.status !== 'running');
        assert.equal(afterRestart.job?.status, 'completed', JSON.stringify(afterRestart));
        assert.equal(afterRestart.saved?.feed.items.length, 2);
        assert.equal(services.embeddingRequests.length, embeddings, 'restart retains compatible cached vectors');
        const files = await compose('exec', '-T', 'app', 'node', '--input-type=module', '-e', "import {readdirSync,readFileSync} from 'node:fs'; const files=readdirSync('/app/data'); for(const name of ['wot.sqlite','web-state.sqlite']) { if(!files.includes(name))throw Error(name); } for(const name of files)if(readFileSync('/app/data/'+name).includes(Buffer.from('dummy-docker-secret')))throw Error('credential persisted'); console.log(files.sort().join(','));");
        assert.match(files, /web-state.sqlite/); assert.match(files, /wot.sqlite/);
        assert.ok(!(await compose('logs', '--no-color')).includes('dummy-docker-secret'));
        console.log(`${provider}: first feed, saved revisit, refresh/cache reuse and restart durability passed`);
      } catch (error) {
        console.error(await compose('ps', '--all'));
        console.error(await compose('logs', '--no-color'));
        throw error;
      } finally { try { await compose('down', '-v', '--remove-orphans'); } finally { await services.close(); } }
    }
  } finally {
    await docker(['image', 'rm', image]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
