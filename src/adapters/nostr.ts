import { bech32 } from '@scure/base';
import { nip19, verifyEvent } from 'nostr-tools';
import type { Diagnostic, NostrEvent, Result, Zap } from '../core/types.js';
const hex = /^[0-9a-f]{64}$/;
export function parsePublicKey(value: string): Result<string, { code: 'invalid-input'; message: string }> {
  if (hex.test(value)) return { ok: true, value };
  try { const decoded = nip19.decode(value); if (decoded.type === 'npub') return { ok: true, value: decoded.data }; } catch { /* invalid input */ }
  return { ok: false, error: { code: 'invalid-input', message: 'Expected a 64-character lowercase hex public key or npub.' } };
}
export function parseReceipt(event: NostrEvent): Result<Zap, Diagnostic> {
  const fail = (message: string): Result<Zap, Diagnostic> => ({ ok: false, error: { code: 'unusable-receipt', message, eventId: event.id } });
  const tags = (name: string) => event.tags.filter(t => t[0] === name).map(t => t[1]);
  if (event.kind !== 9735 || !hex.test(event.id) || !Number.isSafeInteger(event.created_at) || event.created_at < 0) return fail('Invalid receipt event.');
  const targets = tags('e');
  if (targets.length !== 1 || !hex.test(targets[0])) return fail('Receipt must target exactly one note; profile zaps are excluded.');
  if (tags('P').length > 1 || tags('description').length > 1 || tags('bolt11').length !== 1) return fail('Ambiguous receipt evidence.');
  let request: { kind?: number; pubkey?: string; tags?: string[][] } | undefined;
  if (tags('description').length) {
    try { request = JSON.parse(tags('description')[0]); } catch { return fail('Malformed embedded zap request.'); }
    if (!request || request.kind !== 9734 || !hex.test(request.pubkey ?? '') || !Array.isArray(request.tags) || !request.tags.every(t => Array.isArray(t) && t.every(v => typeof v === 'string'))) return fail('Invalid embedded zap request.');
    const requestTargets = request.tags.filter(t => t[0] === 'e').map(t => t[1]);
    if (requestTargets.length !== 1 || requestTargets[0] !== targets[0]) return fail('Receipt and request note targets disagree.');
    const recipients = tags('p'), requestRecipients = request.tags.filter(t => t[0] === 'p').map(t => t[1]);
    if (recipients.length > 1 || requestRecipients.length > 1 || (recipients.length && requestRecipients.length && recipients[0] !== requestRecipients[0])) return fail('Receipt and request recipients disagree.');
  }
  const sender = tags('P')[0] ?? request?.pubkey;
  if (!sender || !hex.test(sender) || (request && request.pubkey !== sender)) return fail('Missing or conflicting sender evidence. Wallet signer is not sender evidence.');
  let amountMsat: bigint;
  let paymentHash: string | undefined;
  try {
    const decoded = bech32.decode(tags('bolt11')[0] as `${string}1${string}`, false);
    if (decoded.words.length < 111) return fail('Invoice body is incomplete.');
    for (let offset = 7; offset + 3 <= decoded.words.length - 104;) {
      const type = decoded.words[offset], length = decoded.words[offset + 1] * 32 + decoded.words[offset + 2];
      offset += 3;
      if (offset + length > decoded.words.length - 104) return fail('Invoice tagged field is truncated.');
      if (type === 1) {
        if (paymentHash || length !== 52) return fail('Invoice payment hash is ambiguous or malformed.');
        paymentHash = Buffer.from(bech32.fromWords(decoded.words.slice(offset, offset + length))).toString('hex');
      }
      offset += length;
    }
    const match = /^ln(?:bcrt|bc|tb|sb)(\d+)([munp]?)$/.exec(decoded.prefix);
    if (!match) return fail('Invoice has no usable amount.');
    const exponent: Record<string, number> = { '': 12, m: 9, u: 6, n: 3, p: 0 };
    const tenths = BigInt(match[1]) * 10n ** BigInt(exponent[match[2]]);
    if (tenths <= 0n || tenths % 10n !== 0n) return fail('Invoice amount must be a positive whole millisatoshi.');
    amountMsat = tenths / 10n;
    if (!Number.isFinite(Number(amountMsat))) return fail('Invoice amount exceeds the supported scoring range.');
  } catch { return fail('Invoice checksum or encoding is invalid.'); }
  const amounts = request?.tags?.filter(t => t[0] === 'amount').map(t => t[1]) ?? [];
  if (amounts.length > 1 || (amounts.length && (!/^\d+$/.test(amounts[0]) || BigInt(amounts[0]) !== amountMsat))) return fail('Invoice and request amounts disagree.');
  return { ok: true, value: { paymentId: paymentHash ? `payment-hash:${paymentHash}` : `${sender}:${targets[0]}:${tags('bolt11')[0].toLowerCase()}`, kind: 9735, id: event.id, sender, target: targets[0], amountMsat, createdAt: event.created_at } };
}

/** Production ingestion policy. Invoice authenticity/wallet authority are explicitly unverified. */
export function verifyIndexedEvent(event: NostrEvent): Result<boolean, Diagnostic> {
  const fail = (message: string): Result<boolean, Diagnostic> => ({ ok: false, error: { code: 'invalid-event', eventId: event.id, message } });
  try {
    if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) return fail('Invalid Nostr event ID or signature.');
    if (event.kind === 9735) {
      const descriptions = event.tags.filter(t => t[0] === 'description');
      if (descriptions.length > 1) return fail('Multiple embedded requests.');
      if (descriptions.length) {
        const request = JSON.parse(descriptions[0][1]) as NostrEvent;
        if (request.kind !== 9734 || !verifyEvent(request as Parameters<typeof verifyEvent>[0])) return fail('Embedded request ID or signature is invalid.');
        const recipients = (e: NostrEvent) => e.tags.filter(t => t[0] === 'p').map(t => t[1]);
        const outer = recipients(event), inner = recipients(request);
        if (outer.length !== 1 || inner.length !== 1 || outer[0] !== inner[0]) return fail('Receipt and embedded request recipients disagree or are missing.');
      }
    }
    return { ok: true, value: true };
  } catch { return fail('Malformed event or embedded request.'); }
}
