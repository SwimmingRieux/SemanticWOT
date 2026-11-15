import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nip19 } from 'nostr-tools';
import { openSqliteCache } from '../../src/adapters/sqlite.js';
import { readFeed } from '../../src/index.js';
import { key, now, snapshot } from '../fixtures.js';

test('SQLite reuses shared frozen events and vectors and CLI emits JSON with separate diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wot-cache-'));
  try {
    const path = join(dir, 'cache.sqlite');
    const opened = openSqliteCache({ path }); assert.ok(opened.ok);
    const cache = opened.value;
    assert.ok((await cache.eventWriter.put(snapshot().events)).ok);
    assert.ok((await cache.embeddingWriter.put(snapshot().embeddings)).ok);
    assert.ok((await cache.indexedAtWriter.put(now)).ok);
    const result = await readFeed({ viewer: key(10), config: { model: 'test', dimensions: 2 } }, { snapshotReader: cache.snapshotReader, clock: { now: () => now } });
    assert.ok(result.ok); assert.equal(result.value.items.length, 3);
    const other = await readFeed({ viewer: key(20), config: { model: 'test', dimensions: 2 } }, { snapshotReader: cache.snapshotReader, clock: { now: () => now } });
    assert.ok(other.ok); assert.equal(other.value.counts.seeds, 2);
    cache.close();
    const cli = spawnSync(process.execPath, ['dist/cli.js', 'feed', nip19.npubEncode(key(10)), '--cache', path, '--model', 'test', '--dimensions', '2', '--compact', '--limit', '2', '--offline'], { encoding: 'utf8' });
    assert.ifError(cli.error);
    assert.equal(cli.status, 0, cli.stderr); assert.ok(cli.stdout, JSON.stringify(cli)); assert.equal(JSON.parse(cli.stdout).items.length, 2);
    assert.equal(cli.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(cli.stdout).selection, 'mmr');
    assert.ok(JSON.parse(cli.stdout).items.every((item: { mmrScore: number }) => Number.isFinite(item.mmrScore)));
    assert.doesNotMatch(cli.stderr, /intermediate-selection/);
    const usage = spawnSync(process.execPath, ['dist/cli.js', 'feed', 'bad-key'], { encoding: 'utf8' });
    assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
    const missing = spawnSync(process.execPath, ['dist/cli.js', 'feed', nip19.npubEncode(key(10)), '--cache', join(dir, 'missing.sqlite')], { encoding: 'utf8' });
    assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
