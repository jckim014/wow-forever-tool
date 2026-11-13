// Computes the departure estimate (departures.mjs) for every raw snapshot pair on F: not done yet, then prints counts.
// Run once after adding the estimate, or after changing the method (clear the departure tables first).
// Usage: node collector/build_departures.mjs      (FOREVER_DATA_ROOT overrides the data folder)
import path from 'node:path';
import { openDb } from './marketDb.mjs';
import { updateDepartures } from './departuresUpdate.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const db = openDb(path.join(root, 'market.db'));
const t0 = Date.now();
const r = updateDepartures(db, root, (m) => console.log(m));
const c = (sql) => db.prepare(sql).get().n;
console.log(`compared ${r.pairs} pairs (${r.skipped} skipped for gaps), ${r.rows.toLocaleString()} item rows, ${((Date.now() - t0) / 1000).toFixed(1)} s, `
  + `peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
console.log(`database: ${c('SELECT count(*) n FROM departure_pairs')} pairs, ${c('SELECT count(*) n FROM departures').toLocaleString()} departure rows`);
db.close();
