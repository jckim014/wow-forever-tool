// Recomputes every summary on F: from the raw snapshots and writes the figures into market.db. Run after the
// summary calculation changes (summarizeUnits in syncLib.mjs), e.g. the overpriced-wall cutoff of 2026-11-14.
// Takes the PC sync's lock so the two don't write at the same time. The raw files are only read.
// Usage: node --disable-warning=ExperimentalWarning collector/rebuild_summaries.mjs   (FOREVER_DATA_ROOT overrides)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { summarizeHouse, SUMMARY_COLUMNS, snapshotDayParts } from './syncLib.mjs';
import { openDb, insertSummary } from './marketDb.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const localDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'ForeverAuctionSync');
const lockPath = path.join(localDir, 'lock');
if (fs.existsSync(lockPath) && Date.now() - fs.statSync(lockPath).mtimeMs < 30 * 60 * 1000) {
  console.error('The PC sync is running (lock present); try again in a few minutes.');
  process.exit(1);
}
fs.mkdirSync(localDir, { recursive: true });
fs.writeFileSync(lockPath, String(process.pid));

try {
  const dirs = [];
  const walk = (d, depth) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (!fs.statSync(p).isDirectory()) continue;
      if (depth === 3) { if (/^\d{8}T\d{6}Z$/.test(n)) dirs.push(p); } else walk(p, depth + 1);
    }
  };
  walk(path.join(root, 'raw'), 0);

  const db = openDb(path.join(root, 'market.db'));
  const t0 = Date.now();
  let changed = 0, rows = 0;
  for (const dir of dirs) {
    const id = path.basename(dir);
    const sumPath = path.join(root, 'summary', ...snapshotDayParts(id), `${id}.json.gz`);
    const old = fs.existsSync(sumPath) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(sumPath)).toString('utf8')) : null;
    const byHouse = new Map();
    for (const n of fs.readdirSync(dir)) {
      const m = /^house-(\d+)-(auctions|commodities)\.json\.gz$/.exec(n);
      if (!m) continue;
      const h = byHouse.get(m[1]) ?? {};
      h[m[2]] = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, n))).toString('utf8'));
      byHouse.set(m[1], h);
    }
    const houses = {};
    for (const [house, h] of [...byHouse].sort((a, b) => a[0] - b[0])) {
      houses[house] = { lastModified: old?.houses?.[house]?.lastModified ?? {}, ...summarizeHouse(h.auctions ?? null, h.commodities ?? null) };
    }
    const summary = {
      ...(old ?? { format: 'forever-auction-summary', version: 1, snapshot: id, collectedAt: null,
        note: 'Per house: per item ID [lowest, median, cheapest15, units, listings], copper per unit; auctions and commodities merged, bid-only left out. Houses missing here did not change in this snapshot.' }),
      columns: SUMMARY_COLUMNS, houses: { ...(old?.houses ?? {}), ...houses },
    };
    fs.mkdirSync(path.dirname(sumPath), { recursive: true });
    fs.writeFileSync(sumPath + '.tmp', zlib.gzipSync(JSON.stringify(summary)));
    fs.renameSync(sumPath + '.tmp', sumPath);
    rows += insertSummary(db, summary);
    for (const [h, v] of Object.entries(houses)) {
      for (const [item, f] of Object.entries(v.items)) if (old?.houses?.[h]?.items?.[item]?.[2] !== f[2]) changed++;
    }
  }
  db.close();
  console.log(`${dirs.length} snapshots recomputed in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${rows.toLocaleString()} rows written; ${changed.toLocaleString()} cheapest-15% figures changed`);
} finally {
  fs.rmSync(lockPath, { force: true });
}
