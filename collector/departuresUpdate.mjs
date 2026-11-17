// Fills the price database's departure tables from the raw snapshots on F: (rules in departures.mjs). Processes every
// consecutive pair of snapshots not yet done, per house, so it serves both the one-off backfill (build_departures.mjs)
// and the hourly sync. Only Josh's two faction houses: Blackwater is just the transfer route.
// A snapshot stored late (its download failed and was retried after later ones were stored) falls inside a pair that
// was already compared across it, usually as a gap: those pairs are removed and redone with it (lateRedoFrom).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { indexListings, compareSnapshots, MAX_GAP_S, METHOD_VERSION } from './departures.mjs';
import { snapshotSeconds } from './marketDb.mjs';

export const DEPARTURE_HOUSES = [111, 114];

export function ensureDepartureTables(db) {
  db.exec(`
    -- pairs of snapshots compared per house (prev_t -> t); skipped = 1 when they were too far apart to compare
    CREATE TABLE IF NOT EXISTS departure_pairs (house INTEGER NOT NULL, t INTEGER NOT NULL, prev_t INTEGER NOT NULL,
      skipped INTEGER NOT NULL DEFAULT 0, method INTEGER NOT NULL, PRIMARY KEY (house, t)) WITHOUT ROWID;
    -- units that left early between prev_t and t (only items with any)
    CREATE TABLE IF NOT EXISTS departures (item INTEGER NOT NULL, house INTEGER NOT NULL, t INTEGER NOT NULL,
      certain INTEGER, probable INTEGER, reposted INTEGER, unclear INTEGER, PRIMARY KEY (item, house, t)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS departures_by_time ON departures (house, t);
  `);
}

/** Raw snapshot folders, oldest first: [{ id, t, dir }]. */
export function rawSnapshots(root) {
  const out = [];
  const walk = (d, depth) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (!fs.statSync(p).isDirectory() || n.endsWith('.partial')) continue;
      if (depth < 3) walk(p, depth + 1);
      else { const t = snapshotSeconds(n); if (t !== null) out.push({ id: n, t, dir: p }); }
    }
  };
  const rawDir = path.join(root, 'raw');
  if (fs.existsSync(rawDir)) walk(rawDir, 0);
  return out.sort((a, b) => a.t - b.t);
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) : null;
}

/** One house's listings in a raw snapshot folder, or null if the folder has neither file for it. */
export function loadHouse(dir, house) {
  const a = readJson(path.join(dir, `house-${house}-auctions.json.gz`));
  const c = readJson(path.join(dir, `house-${house}-commodities.json.gz`));
  return a || c ? indexListings(a, c) : null;
}

function hasHouseFiles(dir, house) {
  return fs.existsSync(path.join(dir, `house-${house}-auctions.json.gz`))
    || fs.existsSync(path.join(dir, `house-${house}-commodities.json.gz`));
}

/**
 * For snapshots that arrived late: the time to redo a house's pairs from (the prev_t of the stored pair that spans the
 * earliest late snapshot), or null if none. pairs = [{ t, prev_t }] stored for the house; snaps = rawSnapshots();
 * has(snap) = the snapshot holds this house's listings (folders without it are crossed on purpose, never "late").
 */
export function lateRedoFrom(pairs, snaps, has) {
  if (!pairs.length) return null;
  const known = new Set();
  for (const p of pairs) { known.add(p.t); known.add(p.prev_t); }
  const first = Math.min(...pairs.map((p) => p.prev_t));
  const last = Math.max(...pairs.map((p) => p.t));
  const late = snaps.find((s) => s.t > first && s.t < last && !known.has(s.t) && has(s));
  if (!late) return null;
  const span = pairs.filter((p) => p.prev_t < late.t && p.t > late.t).sort((a, b) => a.t - b.t)[0];
  return span ? span.prev_t : null;
}

/** Compares every not-yet-done consecutive pair. Returns { pairs, skipped, rows, redone }. */
export function updateDepartures(db, root, log = () => {}) {
  ensureDepartureTables(db);
  const snaps = rawSnapshots(root);
  const pairIns = db.prepare('INSERT OR REPLACE INTO departure_pairs (house, t, prev_t, skipped, method) VALUES (?, ?, ?, ?, ?)');
  const rowIns = db.prepare('INSERT OR REPLACE INTO departures (item, house, t, certain, probable, reposted, unclear) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let pairs = 0, skipped = 0, rows = 0, redone = 0;
  for (const house of DEPARTURE_HOUSES) {
    const stored = db.prepare('SELECT t, prev_t FROM departure_pairs WHERE house = ?').all(house);
    const redo = lateRedoFrom(stored, snaps, (s) => hasHouseFiles(s.dir, house));
    if (redo !== null) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM departures WHERE house = ? AND t > ?').run(house, redo);
        redone += db.prepare('DELETE FROM departure_pairs WHERE house = ? AND t > ?').run(house, redo).changes;
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      log(`departures: house ${house} snapshot stored late, redoing pairs after ${redo}`);
    }
    const last = db.prepare('SELECT max(t) t FROM departure_pairs WHERE house = ?').get(house).t ?? null;
    const todo = snaps.filter((s) => last === null || s.t >= last);
    let prev = null;
    for (const s of todo) {
      const cur = loadHouse(s.dir, house);
      if (!cur) continue; // house unchanged in that snapshot: compare across it next time (or skip if too far)
      if (prev && (last === null || s.t > last)) {
        const gap = s.t - prev.t;
        db.exec('BEGIN');
        try {
          if (gap > MAX_GAP_S) {
            pairIns.run(house, s.t, prev.t, 1, METHOD_VERSION);
            skipped++;
          } else {
            for (const [item, r] of compareSnapshots(prev.listings, cur)) {
              rowIns.run(item, house, s.t, r.certain, r.probable, r.reposted, r.unclear);
              rows++;
            }
            pairIns.run(house, s.t, prev.t, 0, METHOD_VERSION);
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        pairs++;
        log(`departures: house ${house} ${prev.t} -> ${s.t}${gap > MAX_GAP_S ? ' (skipped: gap)' : ''}`);
      }
      prev = { t: s.t, listings: cur };
    }
  }
  return { pairs, skipped, rows, redone };
}
