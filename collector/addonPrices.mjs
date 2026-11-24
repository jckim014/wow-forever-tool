// ApiPrices.lua in the BavvbScan addon folder: the newest hourly API prices on Josh's two factions, for the in-game
// favorites panel (BavvbScan uses them where an item is missing from the character's own /bscan, or where they are
// newer). WoW reads the file at login or /reload. Written by the sync after each new snapshot, and by
// `node collector/write_addon_prices.mjs`.
import fs from 'node:fs';
import path from 'node:path';

/** Josh's PvE realm houses, by the faction name UnitFactionGroup() returns. */
export const ADDON_HOUSES = { Alliance: 111, Horde: 114 };
export const ADDON_DIR = process.env.FOREVER_ADDON_DIR || 'F:\\World of Warcraft\\_forever_\\Interface\\AddOns\\BavvbScan';

/** Pure: { faction: { t, rows: [{ item, lowest, median, cheapest15 }] } } -> Lua text. Prices are "lowest:median:cheapest15" in copper. */
export function addonPricesLua(houses, now = Date.now()) {
  const out = [
    '-- Written by the Forever auction sync (collector/addonPrices.mjs). Do not edit: it is replaced every hour.',
    'BavvbScanApi = {',
    '  format = "bavvbapi", version = 1,',
    `  written = ${Math.floor(now / 1000)},`,
  ];
  for (const [faction, h] of Object.entries(houses)) {
    out.push(`  ${faction} = { house = ${h.house}, t = ${h.t}, items = {`);
    for (const r of h.rows) {
      const v = (x) => (x == null ? '' : String(Math.round(x)));
      out.push(`    [${r.item}] = "${v(r.lowest)}:${v(r.median)}:${v(r.cheapest15)}",`);
    }
    out.push('  } },');
  }
  out.push('}', '');
  return out.join('\n');
}

/** Newest snapshot's rows per faction from market.db. */
export function addonPricesFromDb(db) {
  const houses = {};
  for (const [faction, house] of Object.entries(ADDON_HOUSES)) {
    const t = db.prepare('SELECT max(t) t FROM snapshot_houses WHERE house = ?').get(house)?.t;
    if (t == null) continue;
    const rows = db.prepare('SELECT item, lowest, median, cheapest15 FROM prices WHERE house = ? AND t = ? ORDER BY item').all(house, t);
    houses[faction] = { house, t, rows };
  }
  return houses;
}

/** Writes <dir>/ApiPrices.lua atomically. Throws if the addon folder is missing (BavvbScan not installed there). */
export function writeAddonPrices(db, dir = ADDON_DIR, now = Date.now()) {
  if (!fs.existsSync(path.join(dir, 'BavvbScan.toc'))) throw new Error(`BavvbScan not found in ${dir}`);
  const houses = addonPricesFromDb(db);
  const file = path.join(dir, 'ApiPrices.lua');
  fs.writeFileSync(file + '.tmp', addonPricesLua(houses, now));
  fs.renameSync(file + '.tmp', file);
  return Object.fromEntries(Object.entries(houses).map(([f, h]) => [f, h.rows.length]));
}
