/** Transport observations describe work and resource use, never certify coverage. */
export type RelayObservation =
  | { type: 'socket-owned' | 'socket-released' | 'connection-reuse' | 'connection-retired'; relay: string; ownedSockets: number }
  | { type: 'connection'; relay: string; connectionMs: number; ok: boolean }
  | { type: 'subscriptions'; relay: string; active: number; queued: number }
  | { type: 'admission'; relay: string; queuedMs: number; active: number; queued: number; admitted: boolean }
  | { type: 'page'; relay: string; responseMs: number; ok: boolean; subscriptions: number; ongoingOperations: number }
  | { type: 'query'; relay: string; history: 'initial' | 'incremental' | 'ids'; outcome: 'complete' | 'incomplete' | 'failed' };
export interface RelayObserver { report(observation: RelayObservation): void }
