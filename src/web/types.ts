import type { FeedOutput, IndexProgress, IndexError, IndexWorkflowOutput, Result } from '../index.js';

export interface SavedFeed { feed: FeedOutput; completedAt: number; warnings: string[]; emptyReason?: 'no-seeds' | 'sparse-evidence' }
export interface FeedJob {
  id: string; viewer: string; status: 'running' | 'completed' | 'failed' | 'interrupted';
  startedAt: number; finishedAt?: number; progress?: Pick<IndexProgress, 'phase' | 'completed' | 'total'>;
  error?: IndexError;
}
export interface FeedState { viewer: string; disposition: 'accepted' | 'existing' | 'saved' | 'busy' | 'idle'; job?: FeedJob; saved?: SavedFeed }
export interface RunFeed { run(viewer: string, report: (update: IndexProgress) => void): Promise<Result<IndexWorkflowOutput, IndexError>> }
export interface SubmitFeed { submit(viewer: string, refresh?: boolean): FeedState }
export interface ReadFeedState { read(viewer: string): FeedState }
export interface CloseWebRuntime { close(): Promise<void> }
export type WebRuntime = SubmitFeed & ReadFeedState & CloseWebRuntime;

/** Wrapper state is independent of the reusable library cache. */
export interface StoredFeedState { job: FeedJob; saved?: SavedFeed }
export interface FeedStateWriter { write(state: StoredFeedState): Result<void, IndexError> }
