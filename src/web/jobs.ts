import type { Clock } from '../application/feed.js';
import type { FeedJob, FeedState, RunFeed, SavedFeed, WebRuntime, StoredFeedState, FeedStateWriter } from './types.js';

const storageError = { code: 'cache-failure' as const, message: 'The saved feed could not be written. Check the server data directory and retry.' };
/** Backend-owned work: browser requests only observe or submit, never own cancellation. */
export function createFeedJobs(options: { workflow: RunFeed; clock: Clock; nextId: () => string; initial?: StoredFeedState[]; writer: FeedStateWriter }): WebRuntime {
  const saved = new Map<string, SavedFeed>(), jobs = new Map<string, FeedJob>();
  let active: FeedJob | undefined, pending: Promise<void> | undefined, closing = false;
  for (const state of options.initial ?? []) {
    const job = { ...state.job };
    if (job.status === 'running') {
      job.status = 'interrupted'; job.finishedAt = options.clock.now();
      options.writer.write({ job });
    }
    jobs.set(job.viewer, job);
    if (state.saved) saved.set(job.viewer, state.saved);
  }
  function read(viewer: string): FeedState {
    const job = jobs.get(viewer);
    return { viewer, disposition: saved.has(viewer) ? 'saved' : 'idle', job: job ? { ...job, ...(job.progress ? { progress: { ...job.progress } } : {}) } : undefined, saved: saved.get(viewer) };
  }
  return {
    read,
    submit(viewer, refresh = false) {
      if (active?.viewer === viewer) return { ...read(viewer), disposition: 'existing' };
      if (saved.has(viewer) && !refresh) return read(viewer);
      if (active || closing) return { ...read(viewer), disposition: 'busy' };
      const job: FeedJob = { id: options.nextId(), viewer, status: 'running', startedAt: options.clock.now() };
      jobs.set(viewer, job);
      // Reserve the only writer synchronously, before invoking asynchronous work.
      if (!options.writer.write({ job }).ok) { job.status = 'failed'; job.error = storageError; job.finishedAt = options.clock.now(); return read(viewer); }
      active = job;
      pending = (async () => {
        try {
          const result = await options.workflow.run(viewer, update => {
            if (job.status === 'running') job.progress = { phase: update.phase, completed: update.completed, total: update.total };
          });
          if (job.status !== 'running') return;
          let completed: SavedFeed | undefined;
          if (result.ok) {
            const { feed, collection } = result.value;
            const warnings = collection.relays.filter(relay => relay.status !== 'complete').map(() => 'Some relay evidence was unavailable or capped. Results reflect only the evidence found.');
            if (collection.seeds.missing || collection.candidates.missing) warnings.push('Some referenced notes could not be found on the queried relays.');
            completed = { feed, completedAt: options.clock.now(), warnings: [...new Set(warnings)],
              ...(!feed.items.length ? { emptyReason: collection.seeds.referenced ? 'sparse-evidence' as const : 'no-seeds' as const } : {}) };
            job.status = 'completed';
          } else { job.status = 'failed'; job.error = result.error; }
          job.finishedAt = options.clock.now();
          // Commit the result and final status together; failed work never overwrites saved output.
          if (options.writer.write({ job, saved: completed }).ok) {
            if (completed) saved.set(viewer, completed);
          } else { job.status = 'failed'; job.error = storageError; options.writer.write({ job }); }
        } catch {
          if (job.status === 'running') {
            job.status = 'failed'; job.error = { code: 'cache-failure', message: 'Processing could not finish. Check the server and retry.' };
            job.finishedAt = options.clock.now(); options.writer.write({ job });
          }
        } finally { active = undefined; }
      })();
      return { ...read(viewer), disposition: 'accepted' };
    },
    async close() {
      closing = true;
      if (active?.status === 'running') {
        active.status = 'interrupted'; active.finishedAt = options.clock.now(); options.writer.write({ job: active });
      }
      await pending;
    },
  };
}
