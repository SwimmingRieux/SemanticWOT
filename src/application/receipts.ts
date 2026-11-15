import type { Diagnostic, NostrEvent, Result, Zap } from '../core/types.js';

export interface ReceiptParser { parse(event: NostrEvent): Result<Zap, Diagnostic> }
export interface InterpretedReceipts { zaps: Zap[]; diagnostics: Diagnostic[] }
/** Feed ranking and evaluation must use the same payment evidence. */
export function interpretReceipts(events: NostrEvent[], parser: ReceiptParser): InterpretedReceipts {
  const zaps: Zap[] = [], diagnostics: Diagnostic[] = [];
  const payments = new Set<string>();
  for (const event of events) if (event.kind === 9735) {
    const result = parser.parse(event);
    if (result.ok) {
      if (result.value.paymentId && payments.has(result.value.paymentId)) { diagnostics.push({ code: 'duplicate-payment', eventId: event.id, message: 'Duplicate invoice receipt excluded.' }); continue; }
      if (result.value.paymentId) payments.add(result.value.paymentId);
      zaps.push(result.value);
    } else diagnostics.push(result.error);
  }
  return { zaps, diagnostics };
}
