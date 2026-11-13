// The price history database for Forever Market: F:\ForeverAuctionData\market.db (SQLite, Node's built-in node:sqlite).
// One row per item, house and snapshot with the summary figures (copper per unit). Filled from the per-snapshot
// summaries: build_db.mjs once for what is already on F:, then sync.mjs after each snapshot it stores.
// Item names are not in here: they stay in items.json (fetch_names.mjs), which the app loads whole.
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

/** Opens (creating if needed) the database. WAL lets the app read while the sync writes. */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA journal_size_limit = 4194304; -- shrink the write-ahead log back to 4 MB after use
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    -- t = the snapshot's data time (Unix seconds, from its id, e.g. 20261113T042242Z)
    CREATE TABLE IF NOT EXISTS snapshots (t INTEGER PRIMARY KEY, id TEXT NOT NULL, collected_at TEXT);
    CREATE TABLE IF NOT EXISTS snapshot_houses (
      house INTEGER NOT NULL, t INTEGER NOT NULL, listings INTEGER, bid_only INTEGER, items INTEGER,
      PRIMARY KEY (house, t)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS prices (
      item INTEGER NOT NULL, house INTEGER NOT NULL, t INTEGER NOT NULL,
      lowest INTEGER, median INTEGER, cheapest15 INTEGER, units INTEGER, listings INTEGER,
      PRIMARY KEY (item, house, t)) WITHOUT ROWID;
    -- every item ID ever seen, so naming new items doesn't need a scan of prices
    CREATE TABLE IF NOT EXISTS item_ids (item INTEGER PRIMARY KEY, first_t INTEGER);
    -- all items of a house at given times (Forever Market Faction tab: latest snapshot, last 3 days)
    CREATE INDEX IF NOT EXISTS prices_by_time ON prices (house, t);
  `);
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
  return db;
}

/** "20261113T042242Z" -> Unix seconds, or null. */
export function snapshotSeconds(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : null;
}

/**
 * Adds one collector summary (format forever-auction-summary v1) in one transaction. Rows already stored for the same
 * item, house and snapshot are replaced (a summary re-written with more houses just fills in). Returns the row count.
 */
export function insertSummary(db, summary) {
  if (summary?.format !== 'forever-auction-summary' || summary.version !== 1) throw new Error('not a forever-auction-summary v1');
  const t = snapshotSeconds(summary.snapshot);
  if (t === null) throw new Error(`bad snapshot id ${summary.snapshot}`);
  const snap = db.prepare('INSERT OR REPLACE INTO snapshots (t, id, collected_at) VALUES (?, ?, ?)');
  const house = db.prepare('INSERT OR REPLACE INTO snapshot_houses (house, t, listings, bid_only, items) VALUES (?, ?, ?, ?, ?)');
  const seen = db.prepare('INSERT OR IGNORE INTO item_ids (item, first_t) VALUES (?, ?)');
  const row = db.prepare('INSERT OR REPLACE INTO prices (item, house, t, lowest, median, cheapest15, units, listings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let rows = 0;
  db.exec('BEGIN');
  try {
    snap.run(t, summary.snapshot, summary.collectedAt ?? null);
    for (const [h, data] of Object.entries(summary.houses ?? {})) {
      const items = Object.entries(data.items ?? {});
      const hid = Number(h);
      house.run(hid, t, data.listings ?? null, data.bidOnly ?? null, items.length);
      for (const [id, v] of items) {
        row.run(Number(id), hid, t, v[0] ?? null, v[1] ?? null, v[2] ?? null, v[3] ?? null, v[4] ?? null);
        seen.run(Number(id), t);
        rows++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows;
}

/** Snapshot ids already in the database (to skip during a backfill). */
export function storedSnapshotIds(db) {
  return new Set(db.prepare('SELECT id FROM snapshots').all().map((r) => r.id));
}
