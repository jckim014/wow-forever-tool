// Item names for every item seen on the auction houses (for Forever Market's search and charts).
// Reads all item IDs in F:\ForeverAuctionData\summary, and for those not yet named fetches the Wowhead Forever tooltip
// (game data: name, quality, icon) one per second; misses fall back to Blizzard's item API (Forever, then Retail data).
// Cache: F:\ForeverAuctionData\items.json  { "<id>": { name, quality, icon, source, at } | { missing: true, at } },
// saved every 50 items and at the end, so it can be stopped and restarted any time. Order: new items, then
// unnamed ones (retried daily), then names older than 30 days (re-checked in case a patch renamed them).
//
// Usage: node collector/fetch_names.mjs [--limit N]       (FOREVER_DATA_ROOT overrides the data folder)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fromWowhead, fromBlizzard, toFetch } from './namesLib.mjs';
import { openDb } from './marketDb.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const cachePath = path.join(root, 'items.json');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const PAUSE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every item ID seen: from the price database's item list when it exists, else by reading every summary. */
function allIds() {
  const dbFile = path.join(root, 'market.db');
  if (fs.existsSync(dbFile)) {
    const db = openDb(dbFile);
    const ids = db.prepare('SELECT item FROM item_ids').all().map((r) => String(r.item));
    db.close();
    if (ids.length) return ids;
  }
  const ids = new Set();
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.json.gz')) {
        const s = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
        for (const h of Object.values(s.houses ?? {})) for (const id of Object.keys(h.items ?? {})) ids.add(id);
      }
    }
  };
  walk(path.join(root, 'summary'));
  return [...ids];
}

// One fetch at a time (the hourly sync starts one for new items): a lock younger than 3 h means another is running.
const lockPath = path.join(root, 'items.json.lock');
try {
  if (Date.now() - fs.statSync(lockPath).mtimeMs < 3 * 60 * 60 * 1000) { console.log('another name fetch is running: skipped'); process.exit(0); }
} catch { /* no lock */ }
fs.writeFileSync(lockPath, String(process.pid));

let cache = {};
try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
const save = () => {
  fs.writeFileSync(cachePath + '.tmp', JSON.stringify(cache));
  fs.renameSync(cachePath + '.tmp', cachePath);
};

// Blizzard fallback (token from data/private/blizzard-api.json, fetched only if needed)
let blizzToken = null;
async function blizzard(id) {
  if (blizzToken === null) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/private/blizzard-api.json'), 'utf8'));
      const r = await fetch('https://oauth.battle.net/token', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
      });
      blizzToken = r.ok ? (await r.json()).access_token : '';
    } catch { blizzToken = ''; }
  }
  if (!blizzToken) return null;
  for (const ns of ['static-forever-us', 'static-us']) {
    await sleep(200);
    const r = await fetch(`https://us.api.blizzard.com/data/wow/item/${id}?locale=en_US`, { headers: { Authorization: `Bearer ${blizzToken}`, 'Battlenet-Namespace': ns } });
    if (r.ok) {
      const v = fromBlizzard(await r.json());
      if (v) return { ...v, source: ns === 'static-us' ? 'blizzard-retail' : 'blizzard-forever' };
    }
  }
  return null;
}

async function wowhead(id) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`https://nether.wowhead.com/forever/tooltip/item/${id}`, { headers: { 'User-Agent': 'wow-forever-shuffle item names' } });
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      const v = fromWowhead(await r.json());
      return v ? { ...v, source: 'wowhead' } : null;
    } catch (e) {
      if (attempt === 1) throw e;
      await sleep(30000); // one slow retry, then give up on this run
    }
  }
  return null;
}

const ids = toFetch(allIds(), cache, Date.now()).slice(0, limit);
console.log(`${Object.keys(cache).length} items cached, ${ids.length} to fetch (about ${Math.ceil(ids.length / 60)} min)`);
let done = 0, named = 0, missing = 0;
try {
  for (const id of ids) {
    const at = new Date().toISOString();
    const v = (await wowhead(id)) ?? (await blizzard(id));
    if (v) { cache[id] = { ...v, at }; named++; }
    else if (cache[id]?.name) cache[id] = { ...cache[id], at }; // a failed monthly re-check keeps the name
    else { cache[id] = { missing: true, at }; missing++; }
    if (++done % 50 === 0) { save(); console.log(`${done}/${ids.length}: ${named} named, ${missing} not found`); }
    await sleep(PAUSE_MS);
  }
} finally {
  save();
  fs.rmSync(lockPath, { force: true });
  console.log(`done: ${done} fetched, ${named} named, ${missing} not found; cache has ${Object.keys(cache).length} items`);
}
