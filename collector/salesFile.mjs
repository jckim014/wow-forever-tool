// sales.json in the auction data folder: our sale-rate estimate per item for the shuffle app (which can read the
// folder but not market.db). Same figure as Forever Market's item page: certain + probable units over the last
// `days`, scaled to 24 h by the hourly snapshot pairs present (departures.mjs). Written by the sync after each
// departures update, and by `node collector/write_sales.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { DEPARTURE_HOUSES, ensureDepartureTables } from './departuresUpdate.mjs';

export const SALES_DAYS = 7;

/** Pure: rows [{ item, u }] over `hours` of snapshot pairs -> { item: units per day } (2 decimals; none without hours). */
export function perDay(rows, hours) {
  const out = {};
  if (!hours) return out;
  for (const r of rows) {
    const v = Math.round(((r.u ?? 0) / hours) * 24 * 100) / 100;
    if (v > 0) out[r.item] = v;
  }
  return out;
}

export function salesDoc(db, now = Date.now(), days = SALES_DAYS) {
  ensureDepartureTables(db);
  const from = Math.floor(now / 1000) - days * 86400;
  const houses = {};
  for (const h of DEPARTURE_HOUSES) {
    const hours = db.prepare('SELECT count(*) n FROM departure_pairs WHERE house = ? AND t >= ? AND skipped = 0').get(h, from).n;
    const rows = db.prepare('SELECT item, sum(certain) + sum(probable) u FROM departures WHERE house = ? AND t >= ? GROUP BY item').all(h, from);
    houses[h] = { hours, items: perDay(rows, hours) };
  }
  return { format: 'forever-sales', version: 1, at: new Date(now).toISOString(), days, houses };
}

/** Writes <root>/sales.json (atomically). Returns the number of items with sales per house. */
export function writeSalesFile(db, root, now = Date.now()) {
  const doc = salesDoc(db, now);
  const file = path.join(root, 'sales.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc));
  fs.renameSync(file + '.tmp', file);
  return Object.fromEntries(Object.entries(doc.houses).map(([h, v]) => [h, Object.keys(v.items).length]));
}
