import { bech32 } from '@scure/base';
import type { NostrEvent, Snapshot } from '../src/core/types.js';
import { embeddingCacheKey } from '../src/core/embedding.js';
import { defaultConfiguration } from '../src/application/config.js';
export const key = (n: number) => n.toString(16).padStart(64, '0');
export const now = 1800000000;
export function note(n: number, age = 0): NostrEvent { return { id: key(n), pubkey: key(100 + n), kind: 1, created_at: now - age, content: `note ${n}`, tags: [] }; }
export function receipt(id: number, sender: number, target: number, msat = 1000000, age = 0): NostrEvent {
  return { id: key(id), pubkey: key(999), kind: 9735, content: '', created_at: now - age,
    tags: [['P', key(sender)], ['e', key(target)], ['bolt11', bech32.encode(`lnbc${msat * 10}p`, new Array(111).fill(0), false)],
      ['description', JSON.stringify({ kind: 9734, pubkey: key(sender), tags: [['e', key(target)], ['amount', String(msat)]] })]] };
}
export function snapshot(): Snapshot {
  return { events: [note(1), note(2), note(3), receipt(201, 10, 1), receipt(202, 20, 1), receipt(203, 20, 2), receipt(204, 30, 2), receipt(205, 30, 3)],
    embeddings: [1, 2, 3].map(n => ({ noteId: key(n), model: 'test', modelVersion: 'fixture-v1', cacheKey: embeddingCacheKey(note(n).content,
      { ...defaultConfiguration, model: 'test', dimensions: 2, modelVersion: 'fixture-v1' }), vectors: [[1, 0]] })), indexedAt: now };
}
