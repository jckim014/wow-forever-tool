// Forever Market's local server: serves the page (market/public) and a small JSON API over the price database
// (F:\ForeverAuctionData\market.db) and item names (items.json). Listens on 127.0.0.1 only (this PC), and stops by
// itself when no open tab has checked in for 10 minutes, so nothing runs while the app isn't in use.
// Started by launch.mjs (from the Chrome bookmark); can also be run by hand: node market/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { searchItems, shouldStop, itemList } from './lib.mjs';
import { parseRegionSale } from './tsm.mjs';
import { runMethodCheck } from './methodCheck.mjs';
import { spearman } from './validate.mjs';
import { trade, steadiness } from './faction.mjs';

// TSM region sale data (TSM desktop app's file), re-read when TSM rewrites it. null when the file is missing.
const tsmFile = process.env.FOREVER_TSM_FILE || 'F:\\World of Warcraft\\_forever_\\Interface\\AddOns\\TradeSkillMaster_AppHelper\\AppData.lua';
let tsm = null, tsmMtime = 0;
function getTsm() {
  try {
    const m = fs.statSync(tsmFile).mtimeMs;
    if (m !== tsmMtime) { tsm = parseRegionSale(fs.readFileSync(tsmFile, 'utf8')); tsmMtime = m; }
  } catch { /* keep what we have (or null) */ }
  return tsm;
}

export const PORT = Number(process.env.FOREVER_MARKET_PORT) || 5310;
const dataRoot = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const HOUSES = [111, 114]; // Alliance, Horde (Blackwater prices are not shown)

// ---- data ----
let db = null;
function getDb() {
  if (!db) db = new DatabaseSync(path.join(dataRoot, 'market.db'), { readOnly: true });
  return db;
}

let items = [];
let itemsMtime = 0;
const byId = new Map();
/** items.json, re-read when it changes (the name download may still be filling it). */
function getItems() {
  const file = path.join(dataRoot, 'items.json');
  try {
    const m = fs.statSync(file).mtimeMs;
    if (m !== itemsMtime) {
      items = itemList(JSON.parse(fs.readFileSync(file, 'utf8')));
      byId.clear();
      for (const it of items) byId.set(it.id, it);
      itemsMtime = m;
    }
  } catch { /* keep what we have */ }
  return items;
}

/** Latest figures for an item in each of Josh's houses. */
function latest(item) {
  const q = getDb().prepare('SELECT t, cheapest15, lowest, units FROM prices WHERE item = ? AND house = ? ORDER BY t DESC LIMIT 1');
  const out = {};
  for (const h of HOUSES) {
    const r = q.get(item, h);
    out[h] = r ? { t: r.t, cheapest15: r.cheapest15, lowest: r.lowest, units: r.units } : null;
  }
  return out;
}

/**
 * Our sale-rate estimate (collector/departures.mjs) over the last `days`: per house units per day that left the AH
 * early (certain = partial commodity buys; probable = vanished with 2+ h left, not a likely repost), and the hours of
 * snapshot pairs it rests on. null when the departure tables don't exist yet.
 */
function estimate(item, days) {
  const d = getDb();
  if (!d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'departures'").get()) return null;
  const from = Math.floor(Date.now() / 1000) - days * 86400;
  const out = { days };
  for (const h of HOUSES) {
    const hours = d.prepare('SELECT count(*) n FROM departure_pairs WHERE house = ? AND t >= ? AND skipped = 0').get(h, from).n;
    const s = d.prepare('SELECT sum(certain) c, sum(probable) p, sum(reposted) r FROM departures WHERE item = ? AND house = ? AND t >= ?').get(item, h, from);
    const perDay = (v) => (hours ? ((v ?? 0) / hours) * 24 : null);
    out[h] = { hours, certain: perDay(s.c), probable: perDay(s.p), reposted: perDay(s.r) };
  }
  return out;
}

// ---- Method check (methodCheck.mjs): Josh's TSM records vs our estimate. Cached until new data arrives. ----
const tsmAccountFile = process.env.FOREVER_TSM_ACCOUNT_FILE
  || 'F:\\World of Warcraft\\_forever_\\WTF\\Account\\1120039#2\\SavedVariables\\TradeSkillMaster.lua';
let checkCache = null;
function methodCheck() {
  const latestT = getDb().prepare('SELECT max(t) t FROM snapshots').get().t;
  const key = `${latestT}:${fs.statSync(tsmAccountFile).mtimeMs}`;
  if (checkCache?.key === key) return checkCache.value;
  const r = runMethodCheck(dataRoot, tsmAccountFile);
  getItems();
  for (const x of r.results) x.name = byId.get(x.item)?.name ?? `Item ${x.item}`;
  // sanity: our estimate (both factions, per day, over all data) against TSM's region sold per day, per item
  const d = getDb();
  const hours = Math.max(1, d.prepare('SELECT count(*) n FROM departure_pairs WHERE house = 111 AND skipped = 0').get().n);
  const t = getTsm();
  const points = [];
  for (const row of d.prepare('SELECT item, sum(certain) + sum(probable) u FROM departures GROUP BY item').all()) {
    const tsmDay = t?.items.get(row.item)?.soldPerDay;
    if (tsmDay > 0 && row.u > 0) points.push([row.item, (row.u / hours) * 24, tsmDay, byId.get(row.item)?.name ?? `Item ${row.item}`]);
  }
  const value = {
    ...r, hours, history: JSON.parse(fs.readFileSync(path.join(here, 'method-history.json'), 'utf8')),
    agreement: spearman(points.map((p) => p[1]), points.map((p) => p[2])), points,
  };
  checkCache = { key, value };
  return value;
}

// ---- Faction tab (faction.mjs): every item, both directions, from the latest snapshot; steadiness over 3 days ----
const STEADY_DAYS = 3;
let factionCache = null;
function faction() {
  const d = getDb();
  const lastT = (h) => d.prepare('SELECT max(t) t FROM snapshot_houses WHERE house = ?').get(h).t;
  const latestA = lastT(111), latestH = lastT(114);
  const t = getTsm();
  const key = `${latestA}:${latestH}:${tsmMtime}`;
  if (factionCache?.key === key) return factionCache.value;
  const from = Math.max(latestA, latestH) - STEADY_DAYS * 86400;
  const q = d.prepare('SELECT item, t, lowest, cheapest15, units, listings FROM prices WHERE house = ? AND t >= ?');
  const series = new Map(); // item -> Map(t -> { 111: row, 114: row })
  const latest = { 111: new Map(), 114: new Map() };
  for (const [h, lt] of [[111, latestA], [114, latestH]]) {
    for (const r of q.all(h, from)) {
      let m = series.get(r.item);
      if (!m) series.set(r.item, (m = new Map()));
      let s = m.get(r.t);
      if (!s) m.set(r.t, (s = {}));
      s[h] = r;
      if (r.t === lt) latest[h].set(r.item, r);
    }
  }
  // our estimate on the dear side, per day over the same window
  const hasDep = d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'departures'").get();
  const ours = {};
  for (const h of HOUSES) {
    const hours = hasDep ? d.prepare('SELECT count(*) n FROM departure_pairs WHERE house = ? AND t >= ? AND skipped = 0').get(h, from).n : 0;
    ours[h] = new Map();
    if (!hours) continue;
    for (const r of d.prepare('SELECT item, sum(certain) + sum(probable) u FROM departures WHERE house = ? AND t >= ? GROUP BY item').all(h, from)) {
      ours[h].set(r.item, (r.u / hours) * 24);
    }
  }
  getItems();
  const rows = [];
  const items = new Set([...latest[111].keys(), ...latest[114].keys()]);
  for (const item of items) {
    for (const [cheapH, dearH] of [[111, 114], [114, 111]]) {
      const cheap = latest[cheapH].get(item), dear = latest[dearH].get(item);
      const r = trade(cheap, dear);
      if (!r || r.profit <= 0) continue;
      const hist = new Map();
      for (const [ts, s] of series.get(item) ?? []) hist.set(ts, { cheap: s[cheapH], dear: s[dearH] });
      const it = byId.get(item);
      rows.push({
        item, name: it?.name ?? `Item ${item}`, quality: it?.quality ?? null, from: cheapH, to: dearH,
        buy: r.buy, sell: r.sell, profit: r.profit, margin: r.margin, outlier: r.outlier, thin: r.thin,
        cheapUnits: cheap.units, dearListings: dear.listings, dearUnits: dear.units,
        oursPerDay: ours[dearH].get(item) ?? null, tsmPerDay: t?.items.get(item)?.soldPerDay ?? null,
        steady: steadiness(hist),
      });
    }
  }
  const snapsInWindow = d.prepare('SELECT count(*) n FROM snapshots WHERE t >= ?').get(from).n;
  const value = { latest: Math.max(latestA, latestH), days: STEADY_DAYS, snapshots: snapsInWindow, rows };
  factionCache = { key, value };
  return value;
}

// ---- API ----
const api = {
  '/api/status': () => {
    const d = getDb();
    const one = (sql) => d.prepare(sql).get();
    const ids = one('SELECT count(*) n FROM item_ids').n;
    return {
      snapshots: one('SELECT count(*) n FROM snapshots').n,
      first: one('SELECT min(t) t FROM snapshots').t,
      latest: one('SELECT max(t) t FROM snapshots').t,
      itemIds: ids,
      named: getItems().length,
    };
  },
  '/api/search': (params) => {
    getItems();
    const q = (params.get('q') ?? '').trim();
    const found = searchItems(items, q, 50);
    // An item number always finds its item, even before it has a name (if it has ever been on the AH).
    if (/^\d+$/.test(q) && !found.some((it) => it.id === Number(q))
      && getDb().prepare('SELECT 1 FROM item_ids WHERE item = ?').get(Number(q))) {
      found.unshift({ id: Number(q), name: `Item ${q}`, quality: null, icon: null });
    }
    return found.map((it) => ({ ...it, latest: latest(it.id) }));
  },
  /**
   * Price history of one item in Alliance and Horde: per house [[t, lowest, median, cheapest15, units, listings], ...].
   * Range: days=N (last N days; 0 = all), or from= / to= in Unix seconds (a custom range).
   */
  '/api/history': (params) => {
    const id = Number(params.get('id'));
    const days = Number(params.get('days')) || 0;
    const from = params.has('from') ? Number(params.get('from')) : days ? Math.floor(Date.now() / 1000) - days * 86400 : 0;
    const to = params.has('to') ? Number(params.get('to')) : 4e9;
    const q = getDb().prepare('SELECT t, lowest, median, cheapest15, units, listings FROM prices WHERE item = ? AND house = ? AND t >= ? AND t <= ? ORDER BY t');
    const houses = {};
    for (const h of HOUSES) houses[h] = q.all(id, h, from, to).map((r) => [r.t, r.lowest, r.median, r.cheapest15, r.units, r.listings]);
    // Snapshot times in range (so a gap in an item's line means "not listed", not "no data")
    const snaps = getDb().prepare('SELECT t FROM snapshots WHERE t >= ? AND t <= ? ORDER BY t').all(from, to).map((r) => r.t);
    return { id, from, to, snapshots: snaps, houses };
  },
  '/api/method-check': () => methodCheck(),
  '/api/faction': () => faction(),
  '/api/item': (params) => {
    getItems();
    const id = Number(params.get('id'));
    const t = getTsm();
    return {
      ...(byId.get(id) ?? { id, name: `Item ${id}`, quality: null, icon: null }), latest: latest(id), estimate: estimate(id, 7),
      tsm: t ? { ...(t.items.get(id) ?? { saleAvg: null, soldPerDay: null, saleRate: null }), region: t.region, downloadTime: t.downloadTime } : null,
    };
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let lastSeen = Date.now();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  try {
    if (url.pathname === '/api/heartbeat') {
      lastSeen = Date.now();
      return send(204, '');
    }
    if (api[url.pathname]) {
      lastSeen = Date.now();
      return send(200, JSON.stringify(api[url.pathname](url.searchParams)));
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return send(404, 'not found', 'text/plain');
    return send(200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream');
  } catch (e) {
    return send(500, JSON.stringify({ error: e.message }));
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is in use (Forever Market already running?)` : e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Forever Market on http://localhost:${PORT}/`));

setInterval(() => {
  if (shouldStop(lastSeen, Date.now(), Number(process.env.FOREVER_MARKET_IDLE_MS) || undefined)) {
    console.log('no open tab for 10 minutes: stopping');
    try { db?.close(); } catch { /* ignore */ }
    process.exit(0);
  }
}, Math.min(30 * 1000, Number(process.env.FOREVER_MARKET_IDLE_MS) || 30 * 1000)).unref?.();
