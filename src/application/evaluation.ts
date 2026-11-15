import { readCachedFeed, type ReceiptParser } from './feed.js';
import { validateRankingConfig } from './feed.js';
import { eligibleCandidates } from '../core/feed.js';
import { interpretReceipts } from './receipts.js';
import { compareIds, defaultRankingConfig, type FeedError, type FeedOutput, type RankingConfig, type Result, type Snapshot } from '../core/types.js';

export interface EvaluationInput { viewers: string[]; snapshot: Snapshot; evaluationTime: number; config?: Partial<RankingConfig>; baseline?: 'zap' | 'chrono' }
export interface EvaluationCounts { seeds: number; coZappers: number; candidates: number; edges: number; embeddings: number; pushes: number }
export interface ViewerEvaluation {
  viewer: string; feed: FeedOutput; counts: EvaluationCounts;
  baseline?: { kind: 'zap' | 'chrono'; items: { id: string; createdAt: number; zapAmountMsat?: string }[] };
  collection: { status: 'unavailable'; reason: string };
}
export interface EvaluationOutput { version: 1; evaluationTime: number; parameters: RankingConfig; viewers: ViewerEvaluation[] }
/** Fixed snapshots reuse the cached-feed application pipeline; no external reads are needed. */
export async function evaluateFrozenSnapshot(input: EvaluationInput, ports: { receiptParser: ReceiptParser }): Promise<Result<EvaluationOutput, FeedError>> {
  const checked = validateRankingConfig({ ...defaultRankingConfig, ...input.config });
  if (!checked.ok) return checked;
  if (!Number.isSafeInteger(input.evaluationTime) || input.evaluationTime < 0 || !input.viewers.length) return { ok: false, error: { code: 'invalid-input', message: 'Evaluation requires viewers and a nonnegative integer evaluationTime.' } };
  const snapshot = { ...input.snapshot, events: [...input.snapshot.events].sort((a, b) => compareIds(a.id, b.id) || compareIds(JSON.stringify(a), JSON.stringify(b))) };
  snapshot.events = snapshot.events.filter((event, i, all) => !i || event.id !== all[i - 1].id);
  const { zaps } = interpretReceipts(snapshot.events, ports.receiptParser);
  const viewers: ViewerEvaluation[] = [];
  for (const viewer of [...new Set(input.viewers)].sort(compareIds)) {
    const feed = await readCachedFeed({ viewer, config: checked.value }, { ...ports, snapshotReader: { get: async () => ({ ok: true, value: snapshot }) }, clock: { now: () => input.evaluationTime } });
    if (!feed.ok) return feed;
    const { notes, seeds } = eligibleCandidates({ viewer, snapshot, zaps, now: input.evaluationTime, config: checked.value });
    const seedIds = new Set(Object.keys(seeds));
    const coZappers = new Set(zaps.filter(zap => zap.sender !== viewer && seedIds.has(zap.target)).map(zap => zap.sender));
    const amounts = new Map<string, bigint>();
    for (const zap of zaps) amounts.set(zap.target, (amounts.get(zap.target) ?? 0n) + zap.amountMsat);
    const zapOrder = [...notes].sort((a, b) => {
      const difference = (amounts.get(b.id) ?? 0n) - (amounts.get(a.id) ?? 0n);
      return difference > 0n ? 1 : difference < 0n ? -1 : compareIds(a.id, b.id);
    });
    const chronoOrder = [...notes].sort((a, b) => b.created_at - a.created_at || compareIds(a.id, b.id));
    const baseline = input.baseline === undefined ? {} : { baseline: { kind: input.baseline,
      items: (input.baseline === 'zap' ? zapOrder : chronoOrder).slice(0, checked.value.limit).map(note => ({ id: note.id, createdAt: note.created_at,
        ...(input.baseline === 'zap' ? { zapAmountMsat: String(amounts.get(note.id) ?? 0n) } : {}) })) } };
    viewers.push({ viewer, ...baseline, feed: feed.value, counts: { seeds: feed.value.counts.seeds, coZappers: coZappers.size, candidates: notes.length,
      edges: feed.value.counts.edges, embeddings: feed.value.counts.embeddings, pushes: feed.value.walk.pushes },
      collection: { status: 'unavailable', reason: 'Frozen snapshot; relay coverage and discovery rates were not measured.' } });
  }
  return { ok: true, value: { version: 1, evaluationTime: input.evaluationTime, parameters: checked.value, viewers } };
}
export function serializeEvaluation(output: EvaluationOutput, compact = false): string { return JSON.stringify(output, null, compact ? undefined : 2) + '\n'; }

export interface EvaluationMismatch { viewer: string; path: string; expected: string; actual: string }
export interface EvaluationCheck { ok: boolean; mismatches: EvaluationMismatch[] }
function firstDifference(expected: unknown, actual: unknown, path: string): Omit<EvaluationMismatch, 'viewer'> | undefined {
  const difference = () => ({ path, expected: JSON.stringify(expected) ?? 'missing expectation', actual: JSON.stringify(actual) ?? 'missing value' });
  if (Object.is(expected, actual)) return undefined;
  if (expected === null || actual === null || typeof expected !== 'object' || typeof actual !== 'object') return difference();
  if (Array.isArray(expected) !== Array.isArray(actual)) return difference();
  const left = expected as Record<string, unknown>, right = actual as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareIds)) {
    const next = Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return { path: next, expected: JSON.stringify(left[key]) ?? 'missing expectation', actual: JSON.stringify(right[key]) ?? 'missing value' };
    const mismatch = firstDifference(left[key], right[key], next); if (mismatch) return mismatch;
  }
  return undefined;
}
/** Expectations are supplied values; checking never writes or updates golden files. */
export function checkEvaluation(output: EvaluationOutput, expectations: Record<string, unknown>): EvaluationCheck {
  const mismatches: EvaluationMismatch[] = [];
  for (const { viewer, feed } of output.viewers) {
    const expected = expectations[viewer];
    const mismatch = firstDifference(expected, feed, '$');
    if (mismatch) mismatches.push({ viewer, ...mismatch });
  }
  return { ok: mismatches.length === 0, mismatches };
}
