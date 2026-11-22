// Josh's own in-game scans (BavvbScan's /bscan) as a price source for the Plan tab (Josh, 2026-11-21). Every account's
// BavvbScan.lua under the WTF\Account folder is read (only read; re-read when the file changes); the newest saved scan
// of each faction gives that faction's prices, worked out exactly as the hourly summaries are (summarizeUnits: lowest,
// median, cheapest 15% with the wall cutoff, units, listings). Which of the two the Plan uses is decided in server.mjs:
// the newer of the scan and the latest hourly snapshot, per faction.
import fs from 'node:fs';
import path from 'node:path';
import { parseSavedVariables } from '../collector/ledger.mjs';
import { summarizeUnits } from '../collector/syncLib.mjs';

export const FACTION_HOUSE = { Alliance: 111, Horde: 114 };

/**
 * One parsed BavvbScan.lua -> { house, faction, t, auctions, items: Map(id -> [lowest, median, cheapest15, units,
 * listings]) }, or null when it holds no usable scan (none yet, another format, a faction other than Alliance/Horde).
 */
export function scanPrices(saved) {
  const s = saved?.BavvbScanDB?.scan;
  if (!s || s.format !== 'bavvbscan' || s.version !== 1 || typeof s.time !== 'number') return null;
  const house = FACTION_HOUSE[s.faction];
  if (!house) return null;
  const byItem = new Map();
  for (const [id, v] of Object.entries(s.items ?? {})) {
    const item = Number(id);
    if (!Number.isInteger(item) || typeof v !== 'string') continue;
    for (const pair of v.split(',')) {
      const [count, buyout] = pair.split(':').map(Number);
      if (!(count > 0 && buyout > 0)) continue; // bid-only or malformed
      if (!byItem.has(item)) byItem.set(item, []);
      byItem.get(item).push([buyout / count, count]);
    }
  }
  if (!byItem.size) return null;
  const sum = summarizeUnits(byItem);
  return { house, faction: s.faction, t: s.time, auctions: s.auctions ?? null, items: new Map(Object.entries(sum).map(([k, v]) => [Number(k), v])) };
}

/** Of several scans (nulls allowed), the newest per house: { 111: scan | undefined, 114: ... }. */
export function newestPerHouse(scans) {
  const out = {};
  for (const s of scans) if (s && (!out[s.house] || s.t > out[s.house].t)) out[s.house] = { ...s };
  return out;
}

/** Reads every account's BavvbScan.lua under wtfAccountDir, parsing a file again only when it changed. */
export function scanReader(wtfAccountDir) {
  const cache = new Map(); // file -> { mtime, scan }
  return function read() {
    let accounts = [];
    try {
      accounts = fs.readdirSync(wtfAccountDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { return {}; } // no WoW folder: no scans
    const scans = [];
    for (const a of accounts) {
      const f = path.join(wtfAccountDir, a, 'SavedVariables', 'BavvbScan.lua');
      let mtime;
      try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
      let c = cache.get(f);
      if (!c || c.mtime !== mtime) {
        let scan = null;
        try { scan = scanPrices(parseSavedVariables(fs.readFileSync(f, 'latin1'))); } catch { /* being written, or unreadable: no scan from it */ }
        c = { mtime, scan: scan && { ...scan, account: a } };
        cache.set(f, c);
      }
      scans.push(c.scan);
    }
    return newestPerHouse(scans);
  };
}
