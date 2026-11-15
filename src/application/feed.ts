import { prepareFeed, selectPreparedFeed, type PreparedFeed } from '../core/feed.js';
import type { IndexPorts } from './indexing.js';
import { canonicalParameters, resolveConfiguration, type Configuration } from './config.js';
import { interpretReceipts, type ReceiptParser } from './receipts.js';
export type { ReceiptParser } from './receipts.js';
import { compareIds, type FeedError, type FeedOutput, type RankingConfig, type Result, type Snapshot } from '../core/types.js';
export interface SnapshotReader { get(viewer: string): Promise<Result<Snapshot, FeedError>> }
export interface Clock { now(): number }
export interface FeedInput { viewer: string; config?: Partial<Configuration> }
export interface RankingKey { viewer: string; paramsHash: string; graphParamsHash: string; graphVersion: string }
export interface RankingRecord extends RankingKey { prepared: PreparedFeed }
export interface RankingReader { get(input: RankingKey): Promise<Result<RankingRecord | undefined, FeedError>> }
export interface RankingWriter { put(input: RankingRecord): Promise<Result<number, FeedError>> }
export interface ParameterHasher { hash(config: Configuration): string }
export interface FeedPorts { rankingReader?: RankingReader; rankingWriter?: RankingWriter; parameterHasher?: ParameterHasher; indexPorts?: IndexPorts; snapshotReader: SnapshotReader; clock: Clock }
export function validateRankingConfig(config: RankingConfig): Result<RankingConfig, FeedError> {
  const checked = resolveConfiguration({ file: { ...config } });
  return checked.ok ? checked : { ok: false, error: { code: 'invalid-input', message: checked.error.message } };
}
export async function readCachedFeed(input: FeedInput, ports: FeedPorts & { receiptParser: ReceiptParser }): Promise<Result<FeedOutput, FeedError>> {
  return rankCachedSnapshot(input, ports);
}
/** Only the indexing workflow calls the persistent ranking writer. */
export async function cacheIndexedFeed(input: FeedInput, ports: FeedPorts & { receiptParser: ReceiptParser }): Promise<Result<FeedOutput, FeedError>> {
  return rankCachedSnapshot(input, ports, ports.rankingWriter);
}
async function rankCachedSnapshot(input: FeedInput, ports: FeedPorts & { receiptParser: ReceiptParser }, writer?: RankingWriter): Promise<Result<FeedOutput, FeedError>> {
  const checked = resolveConfiguration({ file: input.config });
  if (!checked.ok) return { ok: false, error: { code: 'invalid-input', message: checked.error.message } };
  const config = checked.value;
  const now = ports.clock.now();
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, error: { code: 'invalid-input', message: 'Clock must return a nonnegative integer Unix timestamp in seconds.' } };
  const cached = await ports.snapshotReader.get(input.viewer);
  if (!cached.ok) return cached;
  const snapshot = { ...cached.value, events: [...cached.value.events].sort((a, b) => compareIds(a.id, b.id) || compareIds(JSON.stringify(a), JSON.stringify(b))) };
  snapshot.events = snapshot.events.filter((event, i, all) => !i || event.id !== all[i - 1].id);
  const hash = ports.parameterHasher?.hash ?? canonicalParameters;
  const key: RankingKey = { viewer: input.viewer, paramsHash: hash(config), graphParamsHash: hash({ ...config, lambda: 0, limit: 0 }), graphVersion: snapshot.graphVersion ?? JSON.stringify([snapshot.events, snapshot.embeddings]) };
  function output(prepared: PreparedFeed): Result<FeedOutput, FeedError> {
    const feed = selectPreparedFeed(prepared, config);
    const diagnostics = [...feed.diagnostics];
    if (now - snapshot.indexedAt > config.collectionTtlSeconds) diagnostics.push({ code: 'stale-cache', message: `Cached collection for ${input.viewer} is ${now - snapshot.indexedAt} seconds old (TTL ${config.collectionTtlSeconds}s). Run wot index or feed --refresh.` });
    return { ok: true, value: { ...feed, indexedAt: snapshot.indexedAt, diagnostics } };
  }
  if (ports.rankingReader) {
    const cachedRanking = await ports.rankingReader.get(key);
    if (!cachedRanking.ok) return cachedRanking;
    const record = cachedRanking.value;
    if (record && record.viewer === key.viewer && record.graphVersion === key.graphVersion && record.graphParamsHash === key.graphParamsHash && now >= record.prepared.output.generatedAt && now - record.prepared.output.generatedAt <= config.rankingTtlSeconds) {
      if (writer && record.paramsHash !== key.paramsHash) {
        const written = await writer.put({ ...key, prepared: record.prepared }); if (!written.ok) return written;
      }
      return output(record.prepared);
    }
  }
  const { zaps, diagnostics } = interpretReceipts(snapshot.events, ports.receiptParser);
  const prepared = prepareFeed({ viewer: input.viewer, snapshot, zaps, diagnostics, now, config });
  if (!prepared.ok) return prepared;
  if (writer) { const written = await writer.put({ ...key, prepared: prepared.value }); if (!written.ok) return written; }
  return output(prepared.value);
}
