import type { Subscription } from 'nostr-tools/abstract-relay';
import type { IndexError } from '../application/indexing.js';
import type { Result } from '../core/types.js';

/** nostr-tools@2.25.5 close() leaves its EOSE timer alive and is not idempotent.
 * Keep the version-specific field access here; exercise it via real wire reads. */
export function closeSubscription(subscription: Subscription, closedBy: 'reader' | 'sdk'): Result<void, IndexError> {
  if (!('eoseTimeoutHandle' in subscription)) return { ok: false, error: { code: 'relay-failure', message: 'Installed relay SDK subscription cleanup contract is incompatible.' } };
  const sdk = subscription as unknown as { eoseTimeoutHandle: ReturnType<typeof setTimeout> };
  clearTimeout(sdk.eoseTimeoutHandle);
  if (closedBy === 'reader') subscription.close();
  return { ok: true, value: undefined };
}
