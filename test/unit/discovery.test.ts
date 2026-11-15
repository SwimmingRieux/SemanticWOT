import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { indexViewer, readFeed, type IndexPorts, type IndexProgress, type Coverage, type NostrEvent, type Snapshot } from '../../src/index.js';
import { createRelayQuery } from '../../src/adapters/relay.js';
import { parseReceipt } from '../../src/adapters/nostr.js';
import { key, note, now, receipt, snapshot } from '../fixtures.js';

function pipeline(source: NostrEvent[], cache: Snapshot = { events: [], embeddings: snapshot().embeddings, indexedAt: 0 }) {
  const ports: IndexPorts = {
    relayQuery: createRelayQuery({ pageReader: { async read(input) {
      return { ok: true, value: source.filter(event => matchFilter(input.filter as Filter, { ...event, sig: event.sig ?? '' }))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(0, Math.min(2, input.pageSize)) };
    } } }),
    eventValidator: { validate: () => ({ ok: true, value: true }) }, receiptParser: { parse: parseReceipt },
    eventWriter: { async put(events) { cache.events = [...new Map([...cache.events, ...events].map(event => [event.id, event])).values()]; return { ok: true, value: events.length }; } },
    indexRecordWriter: { async put(records) { cache.indexRecords = [...cache.indexRecords ?? [], ...records]; return { ok: true, value: records.length }; } },
    indexedAtWriter: { async put(at) { cache.indexedAt = at; return { ok: true, value: at }; } }, clock: { now: () => now },
  };
  return { ports, cache };
}
const config = { maxRelays: 20, model: 'test', dimensions: 2, relays: ['wss://one.test', 'wss://two.test'] };

test('independent seed scopes start while another seed request is waiting', async () => {
  const { ports } = pipeline([note(1), note(2), receipt(201, 10, 1), receipt(202, 10, 2)]);
  const relay = ports.relayQuery;
  const started = new Set<string>();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  ports.relayQuery = { async query(input) {
    if (input.filter['#e']) { started.add(input.filter['#e'][0]); await waiting; }
    return relay.query(input);
  } };
  const pending = indexViewer({ viewer: key(10), config: { ...config, relays: [config.relays[0]] } }, ports);
  // Drain asynchronous application turns, without wall-clock timing or network I/O.
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
  const concurrentScopes = started.size;
  release();
  assert.ok((await pending).ok);
  assert.equal(concurrentScopes, 2, 'a slow seed scope must not serialize independent seed collection');
});

test('collection concurrency bounds all phases without changing retained evidence or feed', async () => {
  const source = [note(1), note(2), note(3), note(4), receipt(201, 10, 1), receipt(202, 10, 2),
    receipt(203, 20, 1), receipt(204, 30, 2), receipt(205, 20, 3), receipt(206, 30, 4)];
  async function run(relayConcurrency: number) {
    const { ports, cache } = pipeline(source);
    const relay = ports.relayQuery;
    let active = 0, peak = 0;
    ports.relayQuery = { async query(input) {
      active++; peak = Math.max(peak, active);
      try {
        // Different completion orders exercise request isolation and canonical admission.
        for (let turn = 0; turn < (input.relay === config.relays[0] ? 5 : 1); turn++) await Promise.resolve();
        return await relay.query(input);
      } finally { active--; }
    } };
    const checked = { ...config, relayConcurrency, relayPageSize: 2, maxZapsPerCoZapper: 2, maxCandidates: 3 };
    const result = await indexViewer({ viewer: key(10), config: checked }, ports);
    assert.ok(result.ok);
    const feed = await readFeed({ viewer: key(10), config: checked }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
    assert.ok(feed.ok);
    return { result: result.value, events: cache.events, feed: feed.value, peak };
  }
  const serial = await run(1), concurrent = await run(3);
  assert.equal(serial.peak, 1);
  assert.equal(concurrent.peak, 3);
  assert.deepEqual(concurrent.result, serial.result);
  assert.deepEqual(concurrent.events, serial.events);
  assert.deepEqual(concurrent.feed, serial.feed);
});

test('progress reports independent failures while another scope waits and never publishes failed coverage', async () => {
  const { ports } = pipeline([note(1), note(2), receipt(201, 10, 1), receipt(202, 10, 2)]);
  const relay = ports.relayQuery;
  const progress: IndexProgress[] = [];
  let coverage: Coverage[] = [], committed = false, release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  ports.progress = { report: update => { progress.push(update); } };
  ports.indexCompletionWriter = { async put(input) { committed = true; coverage = input.coverage; return { ok: true, value: now }; } };
  ports.relayQuery = { async query(input) {
    if (input.filter['#e']?.[0] === key(1)) { await waiting; return { ok: true, value: { events: [], complete: true, pages: 1 } }; }
    if (input.filter['#e']?.[0] === key(2)) return { ok: false, error: { code: 'relay-failure', message: 'scope unavailable' } };
    return relay.query(input);
  } };
  const pending = indexViewer({ viewer: key(10), config: { ...config, relays: [config.relays[0]] } }, ports);
  for (let turn = 0; turn < 100; turn++) await Promise.resolve();
  const early = progress.find(update => update.phase === 'targets' && update.request?.status === 'failed');
  assert.deepEqual(early, { phase: 'targets', completed: 1, total: 2, request: {
    relay: config.relays[0], scope: `target:${key(2)}`, status: 'failed', events: 0, pages: 0, message: 'scope unavailable',
  } });
  assert.equal(committed, false);
  release();
  assert.ok((await pending).ok);
  assert.equal(committed, true);
  assert.ok(coverage.some(item => item.scope === `target:${key(1)}`));
  assert.ok(coverage.every(item => item.scope !== `target:${key(2)}`));
  assert.equal(progress.at(-1)?.phase, 'complete');
});

test('hints discovered during curator collection enter the next phase independently of concurrency', async () => {
  const hinted = receipt(205, 20, 2);
  hinted.tags[1].push('wss://later.test');
  const source = [note(1), note(2), receipt(201, 10, 1), receipt(202, 20, 1), receipt(203, 30, 1), hinted];
  async function run(relayConcurrency: number) {
    const { ports } = pipeline(source);
    return indexViewer({ viewer: key(10), config: { ...config, relayConcurrency } }, ports);
  }
  const serial = await run(1), concurrent = await run(8);
  assert.ok(serial.ok && concurrent.ok);
  assert.deepEqual(serial.value, concurrent.value);
  assert.ok(serial.value.relays.some(status => status.relay === 'wss://later.test' && status.scope.startsWith('notes:')));
  assert.ok(serial.value.relays.every(status => status.relay !== 'wss://later.test' || status.scope.startsWith('notes:')));
});

test('shared-curator discovery crosses paginated fake relays into new cached feed candidates', async () => {
  const { ports, cache } = pipeline([note(1), note(2), receipt(201, 10, 1), receipt(202, 20, 1), receipt(203, 20, 2)]);
  const indexed = await indexViewer({ viewer: key(10), config }, ports);
  assert.ok(indexed.ok);
  const feed = await readFeed({ viewer: key(10), config }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
  assert.ok(feed.ok);
  assert.ok(feed.value.items.some(item => item.id === key(2) && item.graphScore > 0));
  assert.equal(feed.value.counts.edges, 1);
  assert.equal(indexed.value.coZappers.selected, 1);
  assert.deepEqual(indexed.value.candidates, { referenced: 2, found: 2, missing: 0 });
  assert.equal(indexed.value.seedDiscoveryRate, 1);
  assert.ok(cache.indexRecords?.some(record => record.scope.startsWith('target:')));
  assert.ok(cache.indexRecords?.some(record => record.scope === `outgoing:${key(20)}`));
});

test('refresh reuses immutable cached notes and fetches only newly discovered missing content', async () => {
  const source = [note(1), note(2), receipt(201, 10, 1), receipt(202, 20, 1), receipt(203, 20, 2)];
  const { ports, cache } = pipeline(source);
  ports.indexStateReader = { async get() { return { ok: true, value: { events: cache.events, coverage: [] } }; } };
  const feed = () => readFeed({ viewer: key(10), config }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
  assert.ok((await indexViewer({ viewer: key(10), config }, ports)).ok);
  const original = await feed();
  assert.ok(original.ok);
  const relay = ports.relayQuery;
  const fetched: string[] = [];
  ports.relayQuery = { async query(input) {
    if (input.filter.ids) {
      assert.ok(input.filter.ids.every(id => id !== key(1) && id !== key(2)), 'cached immutable note content must not be requested again');
      fetched.push(...input.filter.ids);
    }
    return relay.query(input);
  } };
  const refreshed = await indexViewer({ viewer: key(10), config }, ports);
  assert.ok(refreshed.ok);
  assert.deepEqual(refreshed.value.candidates, { referenced: 2, found: 2, missing: 0 });
  assert.deepEqual(await feed(), original);
  assert.deepEqual(fetched, []);
  source.push(note(3), receipt(204, 20, 3, 1_000_000, 1));
  let embeddingNotes: string[] = [];
  ports.embeddingHook = { async prepare(input) { embeddingNotes = input.notes.map(event => event.id).sort(); return { ok: true, value: undefined }; } };
  const expanded = await indexViewer({ viewer: key(10), config }, ports);
  assert.ok(expanded.ok);
  assert.deepEqual(expanded.value.candidates, { referenced: 3, found: 3, missing: 0 });
  assert.ok(fetched.length > 0 && fetched.every(id => id === key(3)));
  assert.deepEqual(embeddingNotes, [key(1), key(2), key(3)]);
  const discovered = await feed();
  assert.ok(discovered.ok);
  assert.ok(discovered.value.items.some(item => item.id === key(3) && item.graphScore > 0));
});

test('co-zapper spend ties, repeat payments and crawl caps are deterministic with separate truncation counts', async () => {
  const repeat = receipt(207, 20, 1, 2_000_000, 9);
  // Total seed spend for 20 equals 30, so ascending curator key picks 20.
  const source = [note(1), note(2), note(3), receipt(201, 10, 1, 1_000_000, 20), receipt(202, 20, 1, 1_000_000, 10), repeat,
    receipt(203, 30, 1, 3_000_000, 8), receipt(204, 20, 2, 4_000_000, 1), receipt(205, 20, 3, 5_000_000, 2)];
  const { ports, cache } = pipeline(source);
  const result = await indexViewer({ viewer: key(10), config: { ...config, maxCoZappers: 1, maxZapsPerCoZapper: 2, maxCandidates: 2, maxEdges: 1 } }, ports);
  assert.ok(result.ok);
  assert.deepEqual(result.value.coZappers, { discovered: 2, selected: 1 });
  assert.deepEqual(result.value.edges, { retained: 1, truncated: false });
  assert.equal(result.value.limits.maxZapsPerCoZapper, 2);
  assert.deepEqual(result.value.candidates, { referenced: 2, found: 2, missing: 0 });
  assert.ok(result.value.diagnostics.some(d => d.code === 'co-zapper-cap'));
  assert.ok(result.value.diagnostics.some(d => d.code === 'candidate-cap'));
  const feed = await readFeed({ viewer: key(10), config: { ...config, maxCandidates: 2, maxEdges: 1 } }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
  assert.ok(feed.ok);
  assert.deepEqual(feed.value.items.map(item => item.id).sort(), [key(1), key(2)]);
  assert.equal(feed.value.counts.receipts, 5); // viewer + two seed payments + two outgoing payments
  assert.equal(feed.value.walk.reason, 'converged');
  assert.ok(result.value.relays.some(status => status.status === 'incomplete'));
});

test('receipt relay hints extend curator collection as well as direct target retrieval', async () => {
  const seed = receipt(201, 10, 1);
  seed.tags[1].push('wss://hint.test');
  const { ports, cache } = pipeline([note(1), note(2), seed, receipt(202, 20, 1), receipt(203, 20, 2)]);
  const relay = ports.relayQuery;
  ports.relayQuery = { async query(input) {
    if ((input.filter['#e'] || input.filter['#P']?.includes(key(20))) && input.relay !== 'wss://hint.test') return { ok: true, value: { events: [], complete: true, pages: 1 } };
    return relay.query(input);
  } };
  const result = await indexViewer({ viewer: key(10), config }, ports);
  assert.ok(result.ok);
  assert.equal(result.value.coZappers.selected, 1);
  assert.ok(cache.events.some(event => event.id === key(2)));
});

test('private receipt hints cannot consume public discovery slots while configured local relays remain usable', async () => {
  const seed = receipt(201, 10, 1);
  seed.tags[1].push('ws://127.0.0.1:4869');
  seed.tags.push(['p', key(20), 'ws://192.168.62.214:7000']);
  const request = JSON.parse(seed.tags[3][1]);
  request.tags.push(['relays', 'ws://127.0.0.1:4869', ...Array.from({ length: 20 }, (_, n) => `wss://hint${String(n).padStart(2, '0')}.test`)]);
  seed.tags[3][1] = JSON.stringify(request);
  const { ports, cache } = pipeline([note(1), note(2), seed, receipt(202, 20, 1), receipt(203, 20, 2)]);
  const relay = ports.relayQuery;
  ports.relayQuery = { async query(input) {
    if ((input.filter['#e'] || input.filter['#P']?.includes(key(20)) || input.filter.ids) && input.relay !== 'wss://hint17.test') return { ok: true, value: { events: [], complete: true, pages: 1 } };
    return relay.query(input);
  } };
  const checked = { ...config, relays: ['ws://localhost:7777', 'wss://one.test'] };
  const result = await indexViewer({ viewer: key(10), config: checked }, ports);
  assert.ok(result.ok);
  assert.ok(result.value.relays.every(status => !['ws://127.0.0.1:4869', 'ws://192.168.62.214:7000'].includes(status.relay)), 'untrusted private hints must never enter a query');
  assert.ok(result.value.relays.some(status => status.relay === 'ws://localhost:7777'));
  assert.equal(new Set(result.value.relays.map(status => status.relay)).size, 20);
  assert.ok(result.value.relays.some(status => status.relay === 'wss://hint17.test'));
  assert.ok(result.value.relays.every(status => status.relay !== 'wss://hint18.test'));
  assert.deepEqual(result.value.diagnostics.filter(diagnostic => diagnostic.code === 'ignored-relay-hint').map(diagnostic => diagnostic.message), [
    'Ignored nonpublic receipt relay hint ws://127.0.0.1:4869.',
    'Ignored nonpublic receipt relay hint ws://192.168.62.214:7000.',
  ]);
  assert.ok(cache.indexRecords?.some(record => record.relay === 'wss://hint17.test' && record.eventId === key(203)));
  const feed = await readFeed({ viewer: key(10), config: checked }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
  assert.ok(feed.ok);
  assert.ok(feed.value.items.some(item => item.id === key(2) && item.graphScore > 0));
});

test('receipt hint admission handles normalized IP literals and local hostnames without filtering configured relays', async () => {
  const ignored = [
    'ws://0.0.0.0', 'ws://10.2.3.4', 'ws://127.1', 'ws://2130706433', 'ws://0x7f000001', 'ws://0177.0.0.1',
    'ws://100.64.0.1', 'ws://169.254.169.254', 'ws://172.31.2.3', 'ws://192.168.1.2',
    'ws://192.0.0.8', 'ws://192.0.2.1', 'ws://192.88.99.1', 'ws://198.18.0.1', 'ws://198.51.100.1',
    'ws://203.0.113.1', 'ws://224.0.0.1', 'ws://255.255.255.255',
    'ws://[::]', 'ws://[0:0:0:0:0:0:0:1]', 'ws://[fc00::1]', 'ws://[fd12::1]', 'ws://[fe80::1]',
    'ws://[febf::1]', 'ws://[ff02::1]', 'ws://[::ffff:127.0.0.1]', 'ws://[::ffff:192.168.1.1]',
    'ws://[::ffff:a00:1]', 'ws://[2001:db8::1]', 'ws://[3fff::1]', 'ws://[2001:2::1]',
    'ws://[2001:10::1]', 'ws://[2001:20::1]', 'ws://[2002:7f00:1::1]',
    'ws://LOCALHOST.', 'ws://relay.localhost', 'ws://localhost.localdomain', 'ws://relay.local',
    'ws://relay.internal', 'ws://relay.lan', 'ws://relay.home.arpa', 'ws://relay',
  ];
  const allowed = ['ws://8.8.8.8', 'wss://1.1.1.1/path?key=value', 'ws://[2606:4700:4700::1111]',
    'ws://[::ffff:8.8.8.8]', 'wss://relay.example.com', 'ws://relay.example.net:8080/path'];
  const seed = receipt(201, 10, 1);
  const request = JSON.parse(seed.tags[3][1]);
  request.tags.push(['relays', ...ignored, ...allowed, ...ignored]);
  seed.tags[3][1] = JSON.stringify(request);
  const { ports } = pipeline([note(1), seed]);
  const result = await indexViewer({ viewer: key(10), config: { ...config, relays: ['ws://127.0.0.1:7777', 'ws://[::1]:7777'] } }, ports);
  assert.ok(result.ok);
  assert.deepEqual([...new Set(result.value.relays.map(status => status.relay))].sort(), [
    'ws://127.0.0.1:7777', 'ws://[::1]:7777', 'ws://8.8.8.8', 'wss://1.1.1.1/path?key=value',
    'ws://[2606:4700:4700::1111]', 'ws://[::ffff:808:808]', 'wss://relay.example.com', 'ws://relay.example.net:8080/path',
  ].sort());
});

test('index reports paginated request scopes deterministically despite relay ordering', async () => {
  const source = [note(1), note(2), receipt(201, 10, 1), receipt(202, 20, 1), receipt(203, 20, 2)];
  const first = pipeline(source), second = pipeline([...source].reverse());
  const a = await indexViewer({ viewer: key(10), config }, first.ports);
  const b = await indexViewer({ viewer: key(10), config: { ...config, relays: [...config.relays].reverse() } }, second.ports);
  assert.ok(a.ok && b.ok);
  assert.ok(a.value.relays.some(status => status.scope.startsWith('target:') && status.pages > 1));
  assert.deepEqual(a.value, b.value);
});

test('capped relay hints choose the same neighborhood when bootstrap replies race', async () => {
  const seeds = [receipt(201, 10, 1), receipt(211, 10, 2)];
  for (const [index, event] of seeds.entries()) {
    const request = JSON.parse(event.tags[3][1]);
    request.tags.push(['relays', ...Array.from({ length: 12 }, (_, n) => `wss://hint${String(index * 12 + n).padStart(2, '0')}.test`)]);
    request.tags.push(['relays', 'ws://127.1', 'ws://2130706433']);
    event.tags[3][1] = JSON.stringify(request);
  }
  async function run(delayedRelay: string) {
    const { ports } = pipeline([note(1), note(2)]);
    const relay = ports.relayQuery;
    ports.relayQuery = { async query(input) {
      if (input.filter['#P']?.includes(key(10))) {
        if (input.relay === delayedRelay) { await Promise.resolve(); await Promise.resolve(); }
        return { ok: true, value: { events: [seeds[input.relay === config.relays[0] ? 0 : 1]], complete: true, pages: 1 } };
      }
      return relay.query(input);
    } };
    return indexViewer({ viewer: key(10), config }, ports);
  }
  const a = await run(config.relays[0]), b = await run(config.relays[1]);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.value, b.value);
  assert.ok(a.value.relays.some(status => status.relay === 'wss://hint17.test'));
  assert.ok(a.value.relays.every(status => status.relay !== 'wss://hint18.test'));
});

test('missing content, partial relay failure and edge exhaustion stay separate from walk convergence', async () => {
  const { ports, cache } = pipeline([note(1), note(2), note(3), receipt(201, 10, 1, 1_000_000, 10), receipt(210, 10, 4, 1_000_000, 9),
    receipt(202, 20, 1, 1_000_000, 8), receipt(203, 20, 2, 1_000_000, 7), receipt(204, 20, 3, 1_000_000, 6)]);
  const relay = ports.relayQuery;
  ports.relayQuery = { query: input => input.relay === 'wss://two.test' ? Promise.resolve({ ok: false, error: { code: 'relay-failure', message: 'disconnected' } }) : relay.query(input) };
  const result = await indexViewer({ viewer: key(10), config: { ...config, relayPageSize: 2, maxEdges: 1 } }, ports);
  assert.ok(result.ok);
  assert.equal(result.value.seedDiscoveryRate, 0.5);
  assert.deepEqual(result.value.candidates, { referenced: 4, found: 3, missing: 1 });
  assert.deepEqual(result.value.edges, { retained: 1, truncated: true });
  assert.ok(result.value.relays.some(status => status.status === 'failed'));
  assert.ok(result.value.diagnostics.some(d => d.code === 'missing-candidate-notes'));
  const feed = await readFeed({ viewer: key(10), config: { ...config, maxEdges: 1 } }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
  assert.ok(feed.ok);
  assert.equal(feed.value.items.length, 3);
  assert.ok(feed.value.items.every(item => item.id !== key(4)));
  assert.ok(feed.value.diagnostics.some(d => d.code === 'edge-cap'));
  assert.equal(feed.value.walk.reason, 'converged');
});

test('two independently indexed viewers share cached evidence without changing each other’s seeds', async () => {
  const { ports, cache } = pipeline([note(1), note(2), receipt(201, 10, 1), receipt(211, 11, 2), receipt(202, 20, 1), receipt(203, 20, 2)]);
  const first = await indexViewer({ viewer: key(10), config }, ports);
  assert.ok(first.ok);
  const second = await indexViewer({ viewer: key(11), config }, ports);
  assert.ok(second.ok);
  assert.equal(cache.events.filter(event => event.kind === 1).length, 2);
  assert.equal(cache.events.filter(event => event.kind === 9735).length, 4);
  assert.ok(cache.indexRecords?.some(record => record.scope === `outgoing:${key(10)}`));
  assert.ok(cache.indexRecords?.some(record => record.scope === `outgoing:${key(11)}`));
  for (const viewer of [10, 11]) {
    const feed = await readFeed({ viewer: key(viewer), config }, { snapshotReader: { get: async () => ({ ok: true, value: cache }) }, clock: ports.clock });
    assert.ok(feed.ok);
    assert.equal(feed.value.counts.seeds, 1);
    assert.equal(feed.value.counts.edges, 1);
    assert.equal(feed.value.items.length, 2);
    assert.ok(feed.value.items.every(item => item.graphScore > 0));
  }
});

test('relay budget excludes cached and fresh hints by default, admits sorted hints when raised, and retains configured relays', async () => {
  const fresh = receipt(201, 10, 1), cached = receipt(210, 30, 1);
  fresh.tags[1].push('wss://b.test');
  const request = JSON.parse(fresh.tags[3][1]);
  request.tags.push(['relays', 'wss://z.test']);
  fresh.tags[3][1] = JSON.stringify(request);
  cached.tags[1].push('wss://a.test');
  for (const scenario of [
    { relays: ['wss://one.test'], expected: ['wss://one.test'] },
    { relays: ['wss://one.test'], maxRelays: 3, expected: ['wss://a.test', 'wss://b.test', 'wss://one.test'] },
    { relays: ['wss://one.test', 'wss://two.test'], maxRelays: 1, expected: ['wss://one.test', 'wss://two.test'] },
  ]) {
    const { ports } = pipeline([note(1), note(2), fresh, receipt(202, 20, 1), receipt(203, 20, 2)]);
    ports.indexStateReader = { get: async () => ({ ok: true, value: { events: [cached], coverage: [] } }) };
    const result = await indexViewer({ viewer: key(10), config: {
      model: 'test', dimensions: 2, relays: scenario.relays,
      ...(scenario.maxRelays === undefined ? {} : { maxRelays: scenario.maxRelays }),
    } }, ports);
    assert.ok(result.ok);
    for (const prefix of ['target:', `outgoing:${key(20)}`, 'notes:']) {
      const relays = [...new Set(result.value.relays.filter(s => s.scope.startsWith(prefix)).map(s => s.relay))].sort();
      assert.deepEqual(relays, scenario.expected, prefix);
    }
  }
});
