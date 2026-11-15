import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RelayRequest } from '../../../src/application/indexing.js';

export const request = (relay: string, scope = 1): RelayRequest => ({ relay, filter: { kinds: [9735], '#e': [scope.toString(16).padStart(64, '0')] }, timeoutMs: 500, pageSize: 20, maxPages: 5, maxEvents: 100 });
export async function localRelay(handle: (client: WebSocket, id: string, filter: Record<string, any>, path: string) => unknown = (client, id) => client.send(JSON.stringify(['EOSE', id])), limitation: { max_subscriptions?: unknown; max_limit?: number; max_message_length?: number } = {}, network: { bindHost?: string; advertisedHost?: string } = {}) {
  let handshakes = 0, metadata = 0;
  const requests: Record<string, any>[] = [], closes: string[] = [];
  const server = createServer((_req, res) => { metadata++; res.setHeader('Content-Type', 'application/nostr+json'); res.end(JSON.stringify({ limitation })); });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    handshakes++;
    sockets.handleUpgrade(req, socket, head, client => {
      const active = new Set<string>();
      client.on('message', raw => {
      const [kind, id, filter] = JSON.parse(raw.toString());
      if (kind === 'CLOSE') { closes.push(id); active.delete(id); }
      if (kind === 'REQ') {
        requests.push(filter);
        if (limitation.max_message_length && Buffer.byteLength(raw.toString()) > limitation.max_message_length) { client.send(JSON.stringify(['CLOSED', id, 'message too long'])); return; }
        if (typeof limitation.max_subscriptions === 'number' && Number.isSafeInteger(limitation.max_subscriptions) && limitation.max_subscriptions >= 0 && active.size >= limitation.max_subscriptions) { client.send(JSON.stringify(['CLOSED', id, 'capacity exceeded'])); return; }
        active.add(id); if (handle(client, id, filter, req.url ?? '/') === 'closed') active.delete(id);
      }
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, network.bindHost ?? '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { relay: `ws://${network.advertisedHost ?? '127.0.0.1'}:${address.port}`, sockets, requests, closes, counts: () => ({ handshakes, metadata }),
    async close() { for (const client of sockets.clients) client.terminate(); sockets.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
