// Runs the Method check (validate.mjs) over the raw snapshots on F:. One pass over consecutive snapshot pairs per house,
// keeping only listings of items that appear in Josh's TSM records, then each record is matched in memory.
import fs from 'node:fs';
import { rawSnapshots, loadHouse } from '../collector/departuresUpdate.mjs';
import { classify, newListingsByKey, MAX_GAP_S, METHOD_VERSION } from '../collector/departures.mjs';
import { parseTsmRecords, candidates, summarize, EXPECT, ownPricesByItem, pairWindow } from './validate.mjs';

const HOUSES = [111, 114];

/** Returns { method, records, from, to, summary, results } (results without names). */
export function runMethodCheck(dataRoot, tsmAccountFile) {
  const snaps = rawSnapshots(dataRoot);
  if (snaps.length < 2) return { method: METHOD_VERSION, records: 0, summary: {}, results: [] };
  const from = snaps[0].t, to = snaps.at(-1).t;
  const all = parseTsmRecords(fs.readFileSync(tsmAccountFile, 'utf8'));
  const records = all.filter((r) => r.time >= from && r.time <= to);
  const items = new Set(records.map((r) => r.item));

  // pairs[house] = [{ t, prevT, gap, prev: Map(id -> listing) for record items, kinds: Map(id -> classify result) }]
  const pairs = {};
  for (const house of HOUSES) {
    pairs[house] = [];
    let prev = null;
    for (const s of snaps) {
      const cur = loadHouse(s.dir, house);
      if (!cur) continue;
      if (prev) {
        const gap = s.t - prev.t;
        const keep = new Map(), kinds = new Map();
        if (gap <= MAX_GAP_S) {
          const newByKey = newListingsByKey(prev.listings, cur);
          for (const [id, l] of prev.listings) {
            if (!items.has(l.item)) continue;
            keep.set(id, l);
            kinds.set(id, classify(id, l, cur, newByKey));
          }
        }
        pairs[house].push({ t: s.t, prevT: prev.t, gap, prev: keep, kinds });
      }
      prev = { t: s.t, listings: cur };
    }
  }

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
