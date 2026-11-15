import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { finalizeEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { localRelay } from './helpers/relay.js';
import { receipt, key } from '../fixtures.js';
import { createEmbeddingAdapter, resolveConfiguration } from '../../src/index.js';

async function embeddingServer() {
  const requests: { path: string; body: any; authorization?: string }[] = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url!, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (fail) { res.statusCode = 500; res.end(JSON.stringify({ error: 'dummy-key' })); return; }
    if (req.url === '/v1/traces') res.end('{}');
    else if (req.url === '/api/tags') res.end(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest', digest: 'sha256:controlled-model' }] }));
    else if (req.url === '/api/embed') res.end(JSON.stringify({ embeddings: body.input.map((_: string, index: number) => [index + 1, 1]) }));
    else if (req.url === '/v1/embeddings') res.end(JSON.stringify({ model: body.model, data: body.input.map((_: string, index: number) => ({ index, embedding: [index + 1, 1] })).reverse() }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests, fail: () => { fail = true; }, close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())) };
}

test('real HTTP transport preserves ordering, authorization and failure selection for both providers', async () => {
  const server = await embeddingServer();
  try {
    for (const provider of ['ollama', 'openai']) {
      const config = resolveConfiguration({ file: provider === 'ollama' ? { endpoint: server.endpoint } : { openaiEndpoint: server.endpoint + '/v1' } }); assert.ok(config.ok);
      const adapter = createEmbeddingAdapter({ config: config.value, apiKey: 'dummy-key' }); assert.ok(adapter.ok);
      const vectors = await adapter.value.embedder.embed({ model: config.value.model, dimensions: 2, input: ['first', 'second'] });
      assert.deepEqual(vectors, { ok: true, value: [[1, 1], [2, 1]] });
    }
    assert.deepEqual(server.requests.map(item => item.path), ['/api/embed', '/v1/embeddings']);
    assert.equal(server.requests[0].authorization, undefined); assert.equal(server.requests[1].authorization, 'Bearer dummy-key');
    assert.equal(server.requests[0].body.truncate, false); assert.equal(server.requests[1].body.encoding_format, 'float');
    server.fail();
    const config = resolveConfiguration({ file: { openaiEndpoint: server.endpoint + '/v1' } }); assert.ok(config.ok);
    const adapter = createEmbeddingAdapter({ config: config.value, apiKey: 'dummy-key' }); assert.ok(adapter.ok);
    const failed = await adapter.value.embedder.embed({ model: config.value.model, dimensions: 2, input: ['first'] });
    assert.equal(failed.ok, false); assert.ok(!JSON.stringify(failed).includes('dummy-key'));
    assert.deepEqual(server.requests.map(item => item.path), ['/api/embed', '/v1/embeddings', '/v1/embeddings']);
  } finally { await server.close(); }
});

test('CLI completes controlled feeds through both providers, then reads offline without credentials or inference', async () => {
  const secret = new Uint8Array(32).fill(1);
  const note = finalizeEvent({ kind: 1, created_at: 1700000000, content: 'controlled provider fixture', tags: [] }, secret);
  const request = finalizeEvent({ kind: 9734, created_at: 1700000000, content: '', tags: [['e', note.id], ['p', key(20)], ['amount', '1000000']] }, secret);
  const unsigned = receipt(1, 10, 1); unsigned.created_at = 1700000000;
  unsigned.tags = unsigned.tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(request)] : tag[0] === 'P' ? ['P', request.pubkey] : tag[0] === 'e' ? ['e', note.id] : tag);
  unsigned.tags.push(['p', key(20)]);
  const zap = finalizeEvent(unsigned, secret);
  const directory = await mkdtemp(join(tmpdir(), 'wot-provider-cli-'));
  const server = await embeddingServer();
  const relay = await localRelay((client, id, filter) => {
    for (const event of [note, zap].filter(event => matchFilter(filter, event))) client.send(JSON.stringify(['EVENT', id, event]));
    client.send(JSON.stringify(['EOSE', id]));
  });
  try {
    for (const provider of ['ollama', 'openai']) {
      const path = join(directory, provider + '.sqlite');
      const settings = ['--openai-endpoint', server.endpoint + '/v1', ...(provider === 'ollama' ? ['--endpoint', server.endpoint] : ['--model-version', 'controlled-v1'])];
      const args = [resolve('dist/cli.js'), 'feed', request.pubkey, '--cache', path, '--dimensions', '2', '--relays', relay.relay, '--relay-timeout-ms', '1000', '--compact', ...settings];
      const env = { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: join(directory, 'xdg'), OPENAI_API_KEY: 'dummy-key', ...(provider === 'openai' ? { SEMANTICWOT_TRACE: '1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: server.endpoint + '/v1/traces' } : {}) };
      const refreshed = await promisify(execFile)(process.execPath, [...args, '--refresh'], { cwd: directory, env });
      assert.equal(JSON.parse(refreshed.stdout).items.length, 1);
      assert.ok(!refreshed.stdout.includes('dummy-key')); assert.ok(!refreshed.stderr.includes('dummy-key'));
      const count = server.requests.length;
      const cached = await promisify(execFile)(process.execPath, [...args, '--offline'], { cwd: directory, env: { ...env, OPENAI_API_KEY: '', SEMANTICWOT_TRACE: '0' } });
      assert.equal(JSON.parse(cached.stdout).items.length, 1); assert.equal(server.requests.length, count);
      assert.ok(!(await readFile(path)).includes(Buffer.from('dummy-key')));
    }
    assert.deepEqual(server.requests.filter(item => item.path !== '/v1/traces').map(item => item.path), ['/api/tags', '/api/embed', '/v1/embeddings']);
    const traces = server.requests.filter(item => item.path === '/v1/traces');
    assert.ok(traces.length > 0);
    assert.ok(!JSON.stringify(traces).includes('dummy-key'));
    assert.match(JSON.stringify(traces), /embedding.inference/);
    assert.equal(server.requests[2].authorization, 'Bearer dummy-key');
  } finally { await relay.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
