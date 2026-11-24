// sales.json in the auction data folder: our sale-rate estimate per item for the shuffle app (which can read the
// folder but not market.db). Same figure as Forever Market's item page: certain + probable units over the last
// `days`, scaled to 24 h by the hourly snapshot pairs present (departures.mjs). Written by the sync after each
// departures update, and by `node collector/write_sales.mjs`. Also carries TSM's region sold/day per item (pooled TSM
// users' sales across Forever-US, from the TSM desktop app's AppData.lua) so the app can show both.
import fs from 'node:fs';
import path from 'node:path';
import { DEPARTURE_HOUSES, ensureDepartureTables } from './departuresUpdate.mjs';
import { parseRegionSale } from './tsmRegion.mjs';

export const TSM_FILE = process.env.FOREVER_TSM_FILE || 'F:\\World of Warcraft\\_forever_\\Interface\\AddOns\\TradeSkillMaster_AppHelper\\AppData.lua';

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

/** Pure: parseRegionSale's result -> { downloadTime, items: { id: sold per day } } (items selling at all only). */
export function tsmPart(regionSale) {
  if (!regionSale) return null;
  const items = {};
  for (const [id, v] of regionSale.items) if (v.soldPerDay > 0) items[id] = v.soldPerDay;
  return { region: regionSale.region, downloadTime: regionSale.downloadTime, items };
}

/** TSM's region sale data, or null when the file is missing or unreadable (sales.json is written without it). */
export function readTsmSales(file = TSM_FILE) {
  try {
    return tsmPart(parseRegionSale(fs.readFileSync(file, 'latin1')));
  } catch {
    return null;
  }
}

export function salesDoc(db, now = Date.now(), days = SALES_DAYS, tsm = undefined) {
  ensureDepartureTables(db);
  const from = Math.floor(now / 1000) - days * 86400;
  const houses = {};
  for (const h of DEPARTURE_HOUSES) {
    const hours = db.prepare('SELECT count(*) n FROM departure_pairs WHERE house = ? AND t >= ? AND skipped = 0').get(h, from).n;
    const rows = db.prepare('SELECT item, sum(certain) + sum(probable) u FROM departures WHERE house = ? AND t >= ? GROUP BY item').all(h, from);
    houses[h] = { hours, items: perDay(rows, hours) };
  }
  const doc = { format: 'forever-sales', version: 1, at: new Date(now).toISOString(), days, houses };
  const t = tsm === undefined ? readTsmSales() : tsm;
  if (t) doc.tsm = t;
  return doc;
}

/** Writes <root>/sales.json (atomically). Returns the number of items with sales per house. */
export function writeSalesFile(db, root, now = Date.now()) {
  const doc = salesDoc(db, now);
  const file = path.join(root, 'sales.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc));
  fs.renameSync(file + '.tmp', file);
  const n = Object.fromEntries(Object.entries(doc.houses).map(([h, v]) => [h, Object.keys(v.items).length]));
  n.tsm = doc.tsm ? Object.keys(doc.tsm.items).length : 0;
  return n;
}
