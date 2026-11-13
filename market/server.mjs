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

export const PORT = Number(process.env.FOREVER_MARKET_PORT) || 5310;
const dataRoot = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const HOUSES = [111, 114, 117];

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
    return searchItems(items, params.get('q') ?? '', 50).map((it) => ({ ...it, latest: latest(it.id) }));
  },
  '/api/item': (params) => {
    getItems();
    const id = Number(params.get('id'));
    return { ...(byId.get(id) ?? { id, name: `Item ${id}`, quality: null, icon: null }), latest: latest(id) };
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
