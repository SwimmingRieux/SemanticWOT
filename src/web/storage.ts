import Database from 'better-sqlite3';
import type { IndexError, Result } from '../index.js';
import type { FeedJob, FeedStateWriter, SavedFeed, StoredFeedState } from './types.js';

/** Saved output is independent of rankings/cache invalidation. Each write is one atomic SQLite statement. */
export function openWebState(path: string): Result<{ initial: StoredFeedState[]; writer: FeedStateWriter; close(): void }, IndexError> {
  let database: Database.Database | undefined;
  try {
    database = new Database(path);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = FULL');
    database.exec('CREATE TABLE IF NOT EXISTS web_feeds (viewer TEXT PRIMARY KEY, job TEXT NOT NULL, saved TEXT)');
    const initial = (database.prepare('SELECT job, saved FROM web_feeds').all() as { job: string; saved: string | null }[])
      .map(row => ({ job: JSON.parse(row.job) as FeedJob, ...(row.saved ? { saved: JSON.parse(row.saved) as SavedFeed } : {}) }));
    const write = database.prepare('INSERT INTO web_feeds (viewer, job, saved) VALUES (?, ?, ?) ON CONFLICT(viewer) DO UPDATE SET job = excluded.job, saved = COALESCE(excluded.saved, web_feeds.saved)');
    const connection = database;
    return { ok: true, value: { initial, writer: { write(state) {
      try { write.run(state.job.viewer, JSON.stringify(state.job), state.saved ? JSON.stringify(state.saved) : null); return { ok: true, value: undefined }; }
      catch { return { ok: false, error: { code: 'cache-failure', message: 'Cannot persist the saved feed. Check the server data directory.' } }; }
    } }, close() { connection.close(); } } };
  } catch {
    database?.close();
    return { ok: false, error: { code: 'cache-failure', message: 'Cannot open saved feeds. Check the server data directory.' } };
  }
}
