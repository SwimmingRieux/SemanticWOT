import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent } from 'nostr-tools';
import { matchFilter } from 'nostr-tools/filter';
import { localRelay } from './helpers/relay.js';
import { receipt, key, now } from '../fixtures.js';

test('CLI index and feed refresh use managed reuse through collection and embedding failure', async () => {
  const secret = new Uint8Array(32).fill(1);
  const note = finalizeEvent({ kind: 1, created_at: 1700000000, content: 'local fixture', tags: [] }, secret);
  const zapRequest = finalizeEvent({ kind: 9734, created_at: 1700000000, content: '', tags: [['e', note.id], ['p', key(20)], ['amount', '1000000']] }, secret);
  const unsigned = receipt(1, 10, 1);
  unsigned.created_at = 1700000000;
  unsigned.tags = unsigned.tags.map(tag => tag[0] === 'description' ? ['description', JSON.stringify(zapRequest)] : tag[0] === 'P' ? ['P', zapRequest.pubkey] : tag[0] === 'e' ? ['e', note.id] : tag);
  unsigned.tags.push(['p', key(20)]);
  const zap = finalizeEvent(unsigned, secret);
  const directory = await mkdtemp(join(tmpdir(), 'wot-managed-cli-'));
  try {
    for (const command of [['index'], ['feed', '--refresh']]) {
      const peer = await localRelay((client, id, filter) => {
        for (const event of [note, zap].filter(event => matchFilter(filter, event))) client.send(JSON.stringify(['EVENT', id, event]));
        client.send(JSON.stringify(['EOSE', id]));
      });
      try {
        await assert.rejects(promisify(execFile)(process.execPath, ['dist/cli.js', command[0], zapRequest.pubkey, ...command.slice(1), '--cache', join(directory, `${command[0]}.sqlite`), '--relays', peer.relay, '--endpoint', 'http://127.0.0.1:1', '--relay-timeout-ms', '500', '--compact']), (error: any) => {
          assert.match(error.stderr, /embed|Ollama/i); return true;
        });
        assert.ok(peer.requests.length > 2);
        assert.equal(peer.counts().handshakes, 1);
      } finally { await peer.close(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
