import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { parsePublicKey } from '../index.js';
import type { WebRuntime } from './types.js';
import { createProfileReader, type ProfileReader } from './profiles.js';

const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/cards.js': ['cards.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
export async function startWebServer(options: { runtime: WebRuntime; port?: number; host?: string; profileRelays?: readonly string[]; profileTimeoutMs?: number; profileReader?: ProfileReader }) {
  const profiles = options.profileReader ?? createProfileReader({ relays: options.profileRelays ?? [], timeoutMs: options.profileTimeoutMs });
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/profiles') {
        if (request.method !== 'GET') { send(405, { error: { code: 'invalid-input', message: 'Use GET.' } }); return; }
        const authors = [...new Set((url.searchParams.get('authors') ?? '').split(','))];
        if (authors.length > 50 || !authors.every(author => /^[0-9a-f]{64}$/.test(author))) { send(400, { error: { code: 'invalid-input', message: 'Supply up to 50 hex author public keys.' } }); return; }
        send(200, { profiles: await profiles.read(authors) }); return;
      }
      if (url.pathname === '/api/feed') {
        if (!['GET', 'POST'].includes(request.method ?? '')) { send(405, { error: { code: 'invalid-input', message: 'Use GET or POST.' } }); return; }
        let viewer: unknown = url.searchParams.get('viewer'), refresh = false;
        if (request.method === 'POST') {
          if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) { send(403, { error: { code: 'invalid-input', message: 'Submit from the local application.' } }); return; }
          if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { error: { code: 'invalid-input', message: 'Submit JSON.' } }); return; }
          let body = '';
          for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 4096) { send(413, { error: { code: 'invalid-input', message: 'Request is too large.' } }); return; } }
          let input: unknown;
          try { input = JSON.parse(body); } catch { send(400, { error: { code: 'invalid-input', message: 'Submit a public key as JSON.' } }); return; }
          if (!input || typeof input !== 'object' || Array.isArray(input)) { send(400, { error: { code: 'invalid-input', message: 'Submit a public key.' } }); return; }
          const fields = input as Record<string, unknown>; viewer = fields.viewer;
          if (fields.refresh !== undefined && typeof fields.refresh !== 'boolean') { send(400, { error: { code: 'invalid-input', message: 'Refresh must be true or false.' } }); return; }
          refresh = fields.refresh === true;
        }
        const parsed = parsePublicKey(typeof viewer === 'string' ? viewer.trim() : '');
        if (!parsed.ok) { send(400, { error: { code: 'invalid-input', message: 'Enter an npub or 64-character lowercase hex public key. Never enter a private key.' } }); return; }
        const state = request.method === 'POST' ? options.runtime.submit(parsed.value, refresh) : options.runtime.read(parsed.value);
        send(state.disposition === 'accepted' ? 202 : state.disposition === 'busy' ? 409 : 200, state); return;
      }
      const asset = assets[url.pathname];
      if (request.method !== 'GET' || !asset) { send(404, { error: { code: 'invalid-input', message: 'Not found.' } }); return; }
      const content = await readFile(new URL(`./assets/${asset[0]}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': asset[1] }); response.end(content);
    } catch { if (!response.headersSent) send(500, { error: { code: 'cache-failure', message: 'The server could not complete this request. Retry.' } }); else response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 3000, options.host ?? '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot obtain HTTP address.');
  return { url: `http://127.0.0.1:${address.port}`, async close() { server.closeIdleConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await options.runtime.close(); } };
}
