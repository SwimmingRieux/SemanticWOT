import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, deriveSeeds, defaultRankingConfig, rankRelevance, parseReceipt } from '../../src/index.js';
import { key, note, now, receipt } from '../fixtures.js';
const parse = (event: ReturnType<typeof receipt>) => { const result = parseReceipt(event); assert.ok(result.ok); return result.value; };
test('repeat zaps aggregate exact millisatoshis before each shared curator minimum', () => {
  const graph = buildGraph({ notes: [note(1), note(2)], zaps: [parse(receipt(1, 20, 1, 7001)), parse(receipt(2, 20, 1, 3002)), parse(receipt(3, 20, 2, 15000)), parse(receipt(4, 30, 1, 999)), parse(receipt(5, 30, 2, 2000))], vectors: { [key(1)]: [[1, 0]], [key(2)]: [[1, 0]] }, config: { ...defaultRankingConfig, dimensions: 2 } });
  assert.equal(graph.edges[0].strength, 11002n);
  assert.equal(graph.edges[0].similarity, 1);
});
test('seed half-life applies to each receipt and outgoing evidence never uses the wallet key', () => {
  const zaps = [parse(receipt(1, 10, 1, 1000000)), parse(receipt(2, 10, 2, 1000000, 30 * 86400)), parse(receipt(3, 20, 2, 9000000))];
  const seeds = deriveSeeds({ viewer: key(10), zaps, noteIds: [key(1), key(2)], now, halfLifeDays: 30 });
  assert.ok(Math.abs(seeds[key(1)] - 2 / 3) < 1e-12);
  assert.deepEqual(deriveSeeds({ viewer: key(999), zaps, noteIds: [key(1), key(2)], now, halfLifeDays: 30 }), {});
});
test('note age halves raw relevance at the configured half-life with deterministic ties and no cutoff', () => {
  const items = rankRelevance({ notes: [note(3), note(2, 180 * 86400), note(1)], scores: { [key(1)]: 0, [key(2)]: .5, [key(3)]: .25 }, now, halfLifeDays: 180, candidatePool: 200, limit: 20 });
  assert.deepEqual(items.map(i => i.id), [key(2), key(3), key(1)]);
  assert.equal(items[0].rawRelevance, .25);
});
test('receipt attribution rejects conflicting sender evidence, profile zaps, and request amount mismatches', () => {
  const conflict = receipt(1, 10, 1); conflict.tags[0][1] = key(20);
  assert.equal(parseReceipt(conflict).ok, false);
  const profile = receipt(2, 10, 1); profile.tags = profile.tags.filter(t => t[0] !== 'e');
  assert.equal(parseReceipt(profile).ok, false);
  const mismatch = receipt(3, 10, 1); mismatch.tags[3][1] = JSON.stringify({ kind: 9734, pubkey: key(10), tags: [['e', key(1)], ['amount', '1']] });
  assert.equal(parseReceipt(mismatch).ok, false);
  const noSender = receipt(4, 10, 1); noSender.tags = noSender.tags.filter(t => t[0] !== 'P' && t[0] !== 'description');
  assert.equal(parseReceipt(noSender).ok, false);
});
test('receipt interpretation rejects recipient disagreement', () => {
  const event = receipt(1, 10, 1);
  event.tags.push(['p', key(20)]);
  event.tags[3][1] = JSON.stringify({ kind: 9734, pubkey: key(10), tags: [['e', key(1)], ['p', key(30)], ['amount', '1000000']] });
  assert.equal(parseReceipt(event).ok, false);
});
