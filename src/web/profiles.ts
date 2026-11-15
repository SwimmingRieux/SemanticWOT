import { verifyEvent } from 'nostr-tools';
import { createRelayPageReader } from '../adapters/relay.js';

export interface PublicProfile { pubkey: string; name?: string; picture?: string }
export interface ProfileReader { read(authors: string[]): Promise<PublicProfile[]> }

function pictureUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* Invalid metadata is optional. */ }
}
/** Disposable, bounded presentation cache. It never enters library snapshots or ranking. */
export function createProfileReader(options: { relays: readonly string[]; timeoutMs?: number; now?: () => number }): ProfileReader {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { profile: PublicProfile; expires: number }>();
  const pending = new Map<string, Promise<PublicProfile>>();
  const reader = createRelayPageReader();
  async function lookup(authors: string[]): Promise<PublicProfile[]> {
    const filter = { kinds: [0], authors };
    const results = await Promise.all(options.relays.slice(0, 3).map(relay => reader.read({ relay, filter, pageSize: Math.min(500, authors.length * 5), maxPages: 1, maxEvents: 500, timeoutMs: options.timeoutMs ?? 1500 })));
    const events = results.flatMap(result => result.ok ? result.value : []).filter(event => event.kind === 0 && authors.includes(event.pubkey) && verifyEvent({ ...event, sig: event.sig ?? '' })).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
    return authors.map(pubkey => {
      const profile: PublicProfile = { pubkey };
      const event = events.find(event => event.pubkey === pubkey);
      if (!event || event.content.length > 65536) return profile;
      try {
        const fields = JSON.parse(event.content) as Record<string, unknown>;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return profile;
        const name = [fields.display_name, fields.name].find(value => typeof value === 'string' && value.trim());
        if (typeof name === 'string') profile.name = name.trim().slice(0, 100);
        const picture = pictureUrl(fields.picture); if (picture) profile.picture = picture;
      } catch { /* A malformed profile must leave the note readable. */ }
      return profile;
    });
  }
  return { async read(authors) {
    const unique = [...new Set(authors)];
    const missing = unique.filter(author => (cache.get(author)?.expires ?? 0) <= now() && !pending.has(author));
    if (missing.length) {
      const batch: Promise<PublicProfile[]> = lookup(missing).catch(() => missing.map(pubkey => ({ pubkey })));
      for (const author of missing) {
        const request = batch.then(profiles => {
          const profile = profiles.find(profile => profile.pubkey === author) ?? { pubkey: author };
          cache.delete(author); cache.set(author, { profile, expires: now() + (profile.name || profile.picture ? 3600000 : 300000) });
          while (cache.size > 512) cache.delete(cache.keys().next().value!);
          pending.delete(author); return profile;
        });
        pending.set(author, request);
      }
    }
    return Promise.all(authors.map(author => pending.get(author) ?? Promise.resolve(cache.get(author)?.profile ?? { pubkey: author })));
  } };
}
