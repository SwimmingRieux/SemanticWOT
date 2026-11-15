import { untraced } from './tracing.js';
import { indexViewer, type IndexOutput, type IndexError } from './indexing.js';
import { cacheIndexedFeed, type FeedInput, type FeedPorts, type ReceiptParser } from './feed.js';
import { resolveConfiguration } from './config.js';
import type { FeedOutput, Result } from '../core/types.js';
export interface IndexWorkflowOutput { collection: IndexOutput; feed: FeedOutput }
/** Both index and feed --refresh use this collection/embedding/ranking writer workflow. */
export async function runIndexWorkflow(input: FeedInput, ports: FeedPorts & { receiptParser: ReceiptParser }): Promise<Result<IndexWorkflowOutput, IndexError>> {
  const checked = resolveConfiguration({ file: input.config });
  if (!checked.ok) return { ok: false, error: { code: 'invalid-input', message: checked.error.message } };
  if (!ports.indexPorts) return { ok: false, error: { code: 'invalid-input', message: 'Refresh requires indexing ports. Supply indexPorts or run wot index.' } };
  const collection = await (ports.indexPorts.trace ?? untraced).run('index.collect', {}, () => indexViewer({ ...input, config: checked.value }, ports.indexPorts!));
  if (!collection.ok) return collection;
  const feed = await (ports.indexPorts.trace ?? untraced).run('feed.prepare', {}, () => cacheIndexedFeed({ ...input, config: { ...checked.value, refresh: false } }, ports));
  return feed.ok ? { ok: true, value: { collection: collection.value, feed: feed.value } } : feed;
}
