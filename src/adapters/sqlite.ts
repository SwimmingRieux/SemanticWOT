import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import type { Coverage, IndexCompletionWriter, IndexStateReader, IndexRecord, IndexRecordWriter } from '../application/indexing.js';
import type { RankingReader, RankingWriter, RankingRecord, SnapshotReader } from '../application/feed.js';
import type { CachePruner, CacheStats, CacheStatsReader, EmbeddingReader, EmbeddingWriter, EventReader, EventWriter, IndexedAtWriter } from '../application/cache.js';
import { defaultConfiguration } from '../application/config.js';
import type { ChunkEmbedding, FeedError, NostrEvent, Result, Snapshot } from '../core/types.js';
export interface SqliteCacheOptions { path: string; readonly?: boolean; fileMustExist?: boolean }
export interface SqliteCache {
  rankingReader: RankingReader; rankingWriter: RankingWriter; indexStateReader: IndexStateReader; indexCompletionWriter: IndexCompletionWriter; snapshotReader: SnapshotReader; feedSnapshotReader: SnapshotReader; eventReader: EventReader; eventWriter: EventWriter; embeddingReader: EmbeddingReader; embeddingWriter: EmbeddingWriter; indexedAtWriter: IndexedAtWriter; indexRecordWriter: IndexRecordWriter; statsReader: CacheStatsReader; cachePruner: CachePruner; close(): void;
}
const failure = (error: unknown): { ok: false; error: FeedError } => ({ ok: false, error: { code: 'cache-failure', message: `SQLite cache error: ${error instanceof Error ? error.message : String(error)}` } });
export function openSqliteCache(options: SqliteCacheOptions): Result<SqliteCache, FeedError> {
  let db: Database.Database;
  try {
    db = new Database(options.path, { readonly: options.readonly ?? false, fileMustExist: options.fileMustExist ?? options.readonly ?? false });
    if (!options.readonly) { db.exec(`
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, event_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (note_id TEXT NOT NULL, model TEXT NOT NULL, vectors_json TEXT NOT NULL, cache_key TEXT, model_version TEXT, PRIMARY KEY(note_id, model));
      CREATE TABLE IF NOT EXISTS index_records (record_json TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS rankings (viewer TEXT NOT NULL, params_hash TEXT NOT NULL, graph_version TEXT NOT NULL, graph_params_hash TEXT NOT NULL, generated_at INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(viewer, params_hash, graph_version));
      CREATE TABLE IF NOT EXISTS coverage (relay TEXT NOT NULL, scope TEXT NOT NULL, through INTEGER NOT NULL, PRIMARY KEY(relay, scope));
      CREATE TABLE IF NOT EXISTS viewer_indexes (viewer TEXT PRIMARY KEY, indexed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
      const columns = db.prepare('PRAGMA table_info(embeddings)').all() as { name: string }[];
      if (!columns.some(column => column.name === 'cache_key')) db.exec('ALTER TABLE embeddings ADD COLUMN cache_key TEXT');
      if (!columns.some(column => column.name === 'model_version')) db.exec('ALTER TABLE embeddings ADD COLUMN model_version TEXT');
      for (const table of ['events', 'embeddings']) {
        const accessColumns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!accessColumns.some(column => column.name === 'last_used')) db.exec(`ALTER TABLE ${table} ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0`);
        db.exec(`CREATE INDEX IF NOT EXISTS ${table}_last_used ON ${table}(last_used)`);
      }
    }
  } catch (error) { return failure(error); }
  const safeWrite = <T>(write: () => T): Result<T, FeedError> => { try { return { ok: true, value: write() }; } catch (error) { return failure(error); } };
  const nextAccess = (): number => Number((db.prepare('SELECT max(last_used) AS used FROM (SELECT max(last_used) AS last_used FROM events UNION ALL SELECT max(last_used) FROM embeddings)').get() as { used: number | null }).used ?? 0) + 1;
  const touchAll = (table: 'events' | 'embeddings'): void => { if (!options.readonly) db.prepare(`UPDATE ${table} SET last_used = ?`).run(nextAccess()); };
  const stats = (): CacheStats => {
    const tables: CacheStats['tables'] = {};
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    for (const { name } of names) {
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string }[];
      const payload = columns.filter(column => column.name !== 'last_used').map(column => `COALESCE(length(CAST("${column.name.replaceAll('"', '""')}" AS BLOB)), 0)`).join(' + ');
      tables[name] = db.prepare(`SELECT count(*) AS rows, COALESCE(sum(${payload}), 0) AS bytes FROM ${quoted}`).get() as { rows: number; bytes: number };
    }
    const databaseBytes = Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true }));
    const fileSize = (path: string): number => { try { return statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; } };
    return { tables, totalBytes: Object.values(tables).reduce((sum, table) => sum + table.bytes, 0),
      immutableBytes: (tables.events?.bytes ?? 0) + (tables.embeddings?.bytes ?? 0), databaseBytes,
      allocatedBytes: options.path === ':memory:' ? databaseBytes : fileSize(options.path) + fileSize(options.path + '-wal') + fileSize(options.path + '-shm') };
  };
  const readEmbeddings = (): ChunkEmbedding[] => {
    const columns = db.prepare('PRAGMA table_info(embeddings)').all() as { name: string }[];
    const identity = columns.some(column => column.name === 'cache_key') ? 'cache_key, model_version' : 'NULL AS cache_key, NULL AS model_version';
    const embeddings = (db.prepare(`SELECT note_id, model, vectors_json, ${identity} FROM embeddings ORDER BY note_id, model`).all() as { note_id: string; model: string; vectors_json: string; cache_key: string | null; model_version: string | null }[])
      .map(row => ({ noteId: row.note_id, model: row.model, vectors: JSON.parse(row.vectors_json) as number[][],
        ...(row.cache_key ? { cacheKey: row.cache_key } : {}), ...(row.model_version ? { modelVersion: row.model_version } : {}) }));
    touchAll('embeddings');
    return embeddings;
  };
  const hasTable = (name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const invalidateGraph = (): void => {
    db.prepare("INSERT INTO metadata(key, value) VALUES ('graphVersion', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
    db.exec('DELETE FROM rankings');
  };
  const graphVersion = (): string => String((db.prepare("SELECT value FROM metadata WHERE key = 'graphVersion'").get() as { value: string } | undefined)?.value ?? '0');
  const readEvents = (): NostrEvent[] => (db.prepare('SELECT event_json FROM events ORDER BY id').all() as { event_json: string }[]).map(row => JSON.parse(row.event_json) as NostrEvent);
  const readFeedSnapshot = (viewer: string): Result<Snapshot, FeedError> => {
    const viewerMarker = hasTable('viewer_indexes') ? db.prepare('SELECT indexed_at FROM viewer_indexes WHERE viewer = ?').get(viewer) as { indexed_at: number } | undefined : undefined;
    // The deprecated writer remains an explicit legacy snapshot import convention.
    const legacy = db.prepare("SELECT value FROM metadata WHERE key = 'indexedAt'").get() as { value: string } | undefined;
    const indexedAt = viewerMarker?.indexed_at ?? (legacy ? Number(legacy.value) : undefined);
    if (indexedAt === undefined) return { ok: false, error: { code: 'missing-cache', message: 'Cache has not been indexed. Run wot index for this viewer.' } };
    const events = readEvents();
    touchAll('events');
    const embeddings = readEmbeddings();
    return { ok: true, value: { events, embeddings, indexedAt, graphVersion: graphVersion() } };
  };
  return { ok: true, value: {
    rankingReader: { async get(input) { return safeWrite(() => {
      if (!hasTable('rankings')) return undefined;
      const row = db.prepare('SELECT record_json FROM rankings WHERE viewer = ? AND graph_version = ? AND graph_params_hash = ? ORDER BY (params_hash = ?) DESC, generated_at DESC, params_hash LIMIT 1').get(input.viewer, input.graphVersion, input.graphParamsHash, input.paramsHash) as { record_json: string } | undefined;
      return row ? JSON.parse(row.record_json) as RankingRecord : undefined;
    }); } },
    rankingWriter: { async put(input) { return safeWrite(() => db.transaction(() => {
      if (input.graphVersion !== graphVersion()) return 0;
      return db.prepare('INSERT INTO rankings(viewer, params_hash, graph_version, graph_params_hash, generated_at, record_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(viewer, params_hash, graph_version) DO UPDATE SET graph_params_hash = excluded.graph_params_hash, generated_at = excluded.generated_at, record_json = excluded.record_json').run(input.viewer, input.paramsHash, input.graphVersion, input.graphParamsHash, input.prepared.output.generatedAt, JSON.stringify(input)).changes;
    })()); } },
    indexStateReader: { async get() { return safeWrite(() => db.transaction(() => ({ events: readEvents(), coverage: hasTable('coverage') ? db.prepare('SELECT relay, scope, through FROM coverage ORDER BY relay, scope').all() as Coverage[] : [] }))()); } },
    indexCompletionWriter: { async put(input) { return safeWrite(() => db.transaction(() => {
      const put = db.prepare('INSERT INTO coverage(relay, scope, through) VALUES (?, ?, ?) ON CONFLICT(relay, scope) DO UPDATE SET through = max(coverage.through, excluded.through)');
      for (const item of input.coverage) put.run(item.relay, item.scope, item.through);
      db.prepare("DELETE FROM metadata WHERE key = 'indexedAt'").run();
      db.prepare('INSERT INTO viewer_indexes(viewer, indexed_at) VALUES (?, ?) ON CONFLICT(viewer) DO UPDATE SET indexed_at = max(viewer_indexes.indexed_at, excluded.indexed_at)').run(input.viewer, input.indexedAt);
      return input.indexedAt;
    })()); } },
    indexRecordWriter: { async put(records) { return safeWrite(() => db.transaction(() => { const stmt = db.prepare('INSERT OR IGNORE INTO index_records(record_json) VALUES (?)'); let count = 0; for (const record of records) count += stmt.run(JSON.stringify(record)).changes; return count; })()); } },
    statsReader: { async get() { return safeWrite(stats); } },
    eventReader: { async get(ids) { return safeWrite(() => db.transaction(() => {
      const select = db.prepare('SELECT event_json FROM events WHERE id = ?');
      const touch = options.readonly ? undefined : db.prepare('UPDATE events SET last_used = ? WHERE id = ?');
      const access = options.readonly ? 0 : nextAccess();
      const events: NostrEvent[] = [];
      for (const id of [...new Set(ids)].sort()) {
        const row = select.get(id) as { event_json: string } | undefined;
        if (row) { events.push(JSON.parse(row.event_json) as NostrEvent); touch?.run(access, id); }
      }
      return events;
    })()); } },
    cachePruner: { async prune(input) {
      const maxBytes = input.maxBytes ?? defaultConfiguration.cacheMaxBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false, error: { code: 'invalid-input', message: 'Cache size cap must be a nonnegative safe integer byte count.' } };
      return safeWrite(() => {
        const before = stats(), evicted = { events: 0, embeddings: 0 };
        db.transaction(() => {
          const embeddingBytes = 'length(CAST(note_id AS BLOB)) + length(CAST(model AS BLOB)) + length(CAST(vectors_json AS BLOB)) + COALESCE(length(CAST(cache_key AS BLOB)), 0) + COALESCE(length(CAST(model_version AS BLOB)), 0)';
          const oldest = db.prepare(`SELECT 'events' AS source, id AS id, '' AS model, last_used, length(CAST(id AS BLOB)) + length(CAST(event_json AS BLOB)) AS bytes FROM events
            UNION ALL SELECT 'embeddings', note_id, model, last_used, ${embeddingBytes} FROM embeddings ORDER BY last_used, source, id, model`);
          let retainedBytes = before.immutableBytes;
          for (const row of oldest.all() as { source: string; id: string; model: string; bytes: number }[]) {
            if (retainedBytes <= maxBytes) break;
            if (row.source === 'events') {
              const dependents = db.prepare(`SELECT COALESCE(sum(${embeddingBytes}), 0) AS bytes FROM embeddings WHERE note_id = ?`).get(row.id) as { bytes: number };
              const removed = db.prepare('DELETE FROM events WHERE id = ?').run(row.id).changes;
              evicted.events += removed;
              evicted.embeddings += db.prepare('DELETE FROM embeddings WHERE note_id = ?').run(row.id).changes;
              retainedBytes -= removed * row.bytes + dependents.bytes;
            } else {
              const removed = db.prepare('DELETE FROM embeddings WHERE note_id = ? AND model = ?').run(row.id, row.model).changes;
              evicted.embeddings += removed;
              retainedBytes -= removed * row.bytes;
            }
          }
          if (evicted.events || evicted.embeddings) {
            db.prepare('DELETE FROM metadata').run();
            for (const table of ['index_records', 'coverage', 'viewer_indexes', 'rankings']) if (hasTable(table)) db.exec(`DELETE FROM ${table}`);
          }
        })();
        if (evicted.events || evicted.embeddings) db.exec('VACUUM');
        return { maxBytes, before, after: stats(), evicted, invalidated: Boolean(evicted.events || evicted.embeddings) };
      });
    } },
    feedSnapshotReader: { async get(viewer) {
      try { return db.transaction(() => readFeedSnapshot(viewer))(); }
      catch (error) { return failure(error); }
    } },
    snapshotReader: { async get(viewer) {
      try {
        return db.transaction((): Result<Snapshot, FeedError> => {
          const snapshot = readFeedSnapshot(viewer);
          if (!snapshot.ok) return snapshot;
          const hasRecords = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='index_records'").get();
          const indexRecords = hasRecords ? (db.prepare('SELECT record_json FROM index_records ORDER BY record_json').all() as { record_json: string }[]).map(row => JSON.parse(row.record_json) as IndexRecord) : [];
          return { ok: true, value: { events: snapshot.value.events, embeddings: snapshot.value.embeddings, indexRecords, indexedAt: snapshot.value.indexedAt, graphVersion: snapshot.value.graphVersion } };
        })();
      } catch (error) { return failure(error); }
    } },
    eventWriter: { async put(events) { return safeWrite(() => db.transaction(() => { const stmt = db.prepare('INSERT OR IGNORE INTO events(id, event_json, last_used) VALUES (?, ?, ?)'); const touch = db.prepare('UPDATE events SET last_used = ? WHERE id = ?'); let count = 0; let access = nextAccess(); for (const event of events) { count += stmt.run(event.id, JSON.stringify(event), access).changes; touch.run(access++, event.id); } if (count) invalidateGraph(); return count; })()); } },
    embeddingReader: { async get() { return safeWrite(readEmbeddings); } },
    embeddingWriter: { async put(embeddings) { return safeWrite(() => db.transaction(() => { const stmt = db.prepare('INSERT INTO embeddings(note_id, model, vectors_json, cache_key, model_version, last_used) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(note_id, model) DO UPDATE SET vectors_json = excluded.vectors_json, cache_key = excluded.cache_key, model_version = excluded.model_version, last_used = excluded.last_used'); let access = nextAccess(), changed = false;
      const previous = db.prepare('SELECT vectors_json, cache_key, model_version FROM embeddings WHERE note_id = ? AND model = ?');
      const touch = db.prepare('UPDATE embeddings SET last_used = ? WHERE note_id = ? AND model = ?');
      for (const embedding of embeddings) {
        const vectors = JSON.stringify(embedding.vectors), cacheKey = embedding.cacheKey ?? null, modelVersion = embedding.modelVersion ?? null;
        const old = previous.get(embedding.noteId, embedding.model) as { vectors_json: string; cache_key: string | null; model_version: string | null } | undefined;
        if (old && old.vectors_json === vectors && old.cache_key === cacheKey && old.model_version === modelVersion) {
          touch.run(access++, embedding.noteId, embedding.model);
        } else {
          stmt.run(embedding.noteId, embedding.model, vectors, cacheKey, modelVersion, access++);
          changed = true;
        }
      }
      if (changed) invalidateGraph();
      return embeddings.length; })()); } },
    indexedAtWriter: { async put(timestamp) { return safeWrite(() => { db.prepare("INSERT INTO metadata(key,value) VALUES ('indexedAt', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(timestamp)); return timestamp; }); } },
    close() { db.close(); },
  } };
}
