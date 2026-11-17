// Runs the Method check (validate.mjs) over the raw snapshots on F:. Per house, each consecutive snapshot pair is
// classified once and saved in a small cache file (cache/method-check/ under the data folder) holding only the listings
// of items whose TSM records fall in that pair's time; later checks read only new pairs, or redo a pair when a new
// record needs an item it didn't keep. A late snapshot changes the pairs (prevT is in the file name); a new method
// version redoes everything. Results are identical to reading every snapshot (checked 2026-11-17 on Josh's data).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { rawSnapshots, loadHouse, hasHouseFiles } from '../collector/departuresUpdate.mjs';
import { classify, newListingsByKey, MAX_GAP_S, METHOD_VERSION } from '../collector/departures.mjs';
import { parseTsmRecords, candidates, summarize, EXPECT, ownPricesByItem, pairWindow } from './validate.mjs';

const HOUSES = [111, 114];

function readCache(file) {
  try {
    const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    return c.method === METHOD_VERSION ? c : null;
  } catch { return null; }
}

function writeCache(file, c) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(c)));
  fs.renameSync(tmp, file);
}

/**
 * pairs[house] = [{ t, prevT, gap, prev: Map(id -> listing), kinds: Map(id -> classify result) }], holding listings of
 * the items records need in each pair. Pairs no record needs are left empty and never read. stats counts the work.
 */
export function classifiedPairs(dataRoot, snaps, records, stats = { read: 0, cached: 0 }) {
  const dir = path.join(dataRoot, 'cache', 'method-check');
  fs.mkdirSync(dir, { recursive: true });
  const keepFiles = new Set();
  const windows = records.map((r) => [pairWindow(r), r.item]);
  const pairs = {};
  for (const house of HOUSES) {
    pairs[house] = [];
    const withHouse = snaps.filter((s) => hasHouseFiles(s.dir, house));
    let loaded = null; // { t, listings } of the last snapshot read, reused as the next pair's earlier side
    const load = (s) => (loaded?.t === s.t ? loaded : (stats.read++, loaded = { t: s.t, listings: loadHouse(s.dir, house) }));
    for (let i = 1; i < withHouse.length; i++) {
      const a = withHouse[i - 1], b = withHouse[i];
      const gap = b.t - a.t;
      const pair = { t: b.t, prevT: a.t, gap, prev: new Map(), kinds: new Map() };
      pairs[house].push(pair);
      if (gap > MAX_GAP_S) continue;
      const need = new Set();
      for (const [[w0, w1], item] of windows) if (b.t >= w0 && a.t <= w1) need.add(item);
      if (!need.size) continue;
      const file = path.join(dir, `${house}-${a.t}-${b.t}.json.gz`);
      keepFiles.add(path.basename(file));
      let c = readCache(file);
      if (c && [...need].every((x) => c.items.includes(x))) {
        stats.cached++;
      } else {
        const items = new Set([...(c?.items ?? []), ...need]);
        const prevL = load(a).listings, cur = load(b).listings;
        const newByKey = newListingsByKey(prevL, cur);
        const prev = [], kinds = [];
        for (const [id, l] of prevL) {
          if (!items.has(l.item)) continue;
          prev.push([id, l]);
          kinds.push([id, classify(id, l, cur, newByKey)]);
        }
        c = { method: METHOD_VERSION, items: [...items], prev, kinds };
        writeCache(file, c);
      }
      pair.prev = new Map(c.prev);
      pair.kinds = new Map(c.kinds);
    }
  }
  // files of pairs that no longer exist (a late snapshot split them) or no record needs
  for (const f of fs.readdirSync(dir)) if (!keepFiles.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  return pairs;
}

/** Returns { method, records, from, to, summary, results } (results without names). */
export function runMethodCheck(dataRoot, tsmAccountFile, stats) {
  const snaps = rawSnapshots(dataRoot);
  if (snaps.length < 2) return { method: METHOD_VERSION, records: 0, summary: {}, results: [] };
  const from = snaps[0].t, to = snaps.at(-1).t;
  const all = parseTsmRecords(fs.readFileSync(tsmAccountFile, 'utf8'));
  const records = all.filter((r) => r.time >= from && r.time <= to);
  const pairs = classifiedPairs(dataRoot, snaps, records, stats);

  const results = [];
  for (const rec of records) {
    let found = null, sawCandidate = false, anyData = false;
    // the pairs that can hold the event (a pair covers prevT..t), latest first; a pair with a missed hour = no data
    const [w0, w1] = pairWindow(rec);
    const own = rec.price === null ? ownPricesByItem(all, rec.time).get(rec.item) ?? null : null;
    const inWindow = HOUSES.flatMap((h) => pairs[h].filter((p) => p.t >= w0 && p.prevT <= w1).map((x) => ({ ...x, house: h })));
    outer: for (const p of inWindow.sort((a, b) => b.t - a.t)) {
      if (p.gap > MAX_GAP_S) continue;
      anyData = true;
      const cands = candidates(rec, p.prev, own);
      if (cands.length) sawCandidate = true;
      const changed = cands.filter((id) => p.kinds.get(id)?.kind !== 'still');
      if (!changed.length) continue;
      const tally = {};
      for (const id of changed) { const k = p.kinds.get(id).kind; tally[k] = (tally[k] ?? 0) + 1; }
      const outcome = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
      found = { house: p.house, pairT: p.t, outcome, ambiguous: changed.length > 1 };
      break outer;
    }
    const outcome = found?.outcome ?? (sawCandidate ? 'unmatched' : anyData ? 'invisible' : 'no-data');
    results.push({ kind: rec.kind, item: rec.item, stack: rec.stack, count: rec.count, price: rec.price, time: rec.time,
      ...(found ?? {}), outcome, right: EXPECT[rec.kind].right.includes(outcome) });
  }
  return { method: METHOD_VERSION, records: records.length, from, to, summary: summarize(results), results };
}
