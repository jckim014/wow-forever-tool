// Item names for every item seen on the auction houses (for Forever Market's search and charts).
// Reads all item IDs in F:\ForeverAuctionData\summary, and for those not yet named fetches the Wowhead Forever tooltip
// (game data: name, quality, icon) one per second; misses fall back to Blizzard's item API (Forever, then Retail data).
// Cache: F:\ForeverAuctionData\items.json  { "<id>": { name, quality, icon, source, at } | { missing: true, at } },
// saved every 50 items and at the end, so it can be stopped and restarted any time.
//
// Usage: node collector/fetch_names.mjs [--limit N]       (FOREVER_DATA_ROOT overrides the data folder)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fromWowhead, fromBlizzard, toFetch } from './namesLib.mjs';

const root = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const cachePath = path.join(root, 'items.json');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;
const PAUSE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function allIds() {
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
    if (v) { cache[id] = { ...v, at }; named++; } else { cache[id] = { missing: true, at }; missing++; }
    if (++done % 50 === 0) { save(); console.log(`${done}/${ids.length}: ${named} named, ${missing} not found`); }
    await sleep(PAUSE_MS);
  }
} finally {
  save();
  console.log(`done: ${done} fetched, ${named} named, ${missing} not found; cache has ${Object.keys(cache).length} items`);
}
