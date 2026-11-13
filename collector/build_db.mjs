// Fills F:\ForeverAuctionData\market.db from the summaries already on F: (skipping snapshots it has), then prints
// counts. Run once after setting up the database, or any time to catch up (e.g. if the sync couldn't write to it).
// Usage: node collector/build_db.mjs          (FOREVER_DATA_ROOT overrides the data folder)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb, insertSummary, storedSnapshotIds } from './marketDb.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const db = openDb(path.join(root, 'market.db'));
const have = storedSnapshotIds(db);

const files = [];
const walk = (d) => {
  for (const n of fs.readdirSync(d).sort()) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.json.gz')) files.push(p);
  }
};
walk(path.join(root, 'summary'));

const t0 = Date.now();
let added = 0, rows = 0;
for (const f of files) {
  const id = path.basename(f, '.json.gz');
  if (have.has(id)) continue;
  rows += insertSummary(db, JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')));
  added++;
}
// Databases made before item_ids existed: fill it once from the prices.
if (db.prepare('SELECT count(*) n FROM item_ids').get().n === 0) db.exec('INSERT OR IGNORE INTO item_ids SELECT item, min(t) FROM prices GROUP BY item');
const c = (sql) => db.prepare(sql).get().n;
console.log(`summary files: ${files.length}, added now: ${added} (${rows.toLocaleString()} rows, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log(`database: ${c('SELECT count(*) n FROM snapshots')} snapshots, ${c('SELECT count(*) n FROM snapshot_houses')} house snapshots, `
  + `${c('SELECT count(*) n FROM prices').toLocaleString()} price rows, ${c('SELECT count(*) n FROM item_ids').toLocaleString()} items`);
db.close();
const size = fs.statSync(path.join(root, 'market.db')).size + (fs.existsSync(path.join(root, 'market.db-wal')) ? fs.statSync(path.join(root, 'market.db-wal')).size : 0);
console.log(`size on disk: ${(size / 1e6).toFixed(1)} MB`);
