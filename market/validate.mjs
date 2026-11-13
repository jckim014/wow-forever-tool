// Method check for our sale-rate estimate: Josh's own TSM records (sales, buys, cancels, expiries) are ground truth
// for what happened to specific listings. Each record is matched to the listing in the hourly snapshots and the
// estimate's rule (collector/departures.mjs classify) is asked what it made of it. Pure parts here; tested.
// Never keeps or returns player names (TSM rows have the buyer/seller and Josh's character in them).

const KINDS = { csvSales: 'sale', csvBuys: 'buy', csvCancelled: 'cancel', csvExpired: 'expiry' };

/** TSM's TradeSkillMaster.lua -> [{ kind, item, stack, count, price, time }] for auction-house records; no names. */
export function parseTsmRecords(text) {
  const out = [];
  for (const [key, kind] of Object.entries(KINDS)) {
    const re = new RegExp(`\\["[^"]*${key}"\\] = "((?:[^"\\\\]|\\\\.)*)"`, 'g');
    for (const m of text.matchAll(re)) {
      const lines = m[1].split('\\n');
      const cols = lines[0].split(',');
      const at = (row, name) => row[cols.indexOf(name)];
      for (const line of lines.slice(1)) {
        if (!line) continue;
        const row = line.split(',');
        if (cols.includes('source') && at(row, 'source') !== 'Auction') continue;
        const item = /^i:(\d+)/.exec(at(row, 'itemString'))?.[1];
        if (!item) continue;
        const stack = Number(at(row, 'stackSize')), qty = Number(at(row, 'quantity'));
        out.push({
          kind, item: Number(item), stack,
          count: Math.max(1, Math.round(qty / stack)), // TSM merges identical records: number of listings
          price: cols.includes('price') ? Number(at(row, 'price')) : null, // per unit, copper
          time: Number(at(row, 'time')),
        });
      }
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** TSM records a sale at what Josh received: the listed price minus the 5% AH cut. */
export const AH_CUT = 0.05;
export const listedPrice = (rec) => (rec.kind === 'sale' && rec.price !== null ? rec.price / (1 - AH_CUT) : rec.price);

/**
 * Listings in `prev` that could be this record's:
 *  - sale: same item, same stack size, unit price = recorded price / 0.95 (TSM records the money received);
 *  - buy of a commodity: any listing of the item at or below the price paid (a buy takes units from several stacks);
 *  - other buy: same item, stack size and unit price;
 *  - cancel / expiry (TSM has no price): same item and stack size, and when Josh's own listing prices for the item
 *    are known (`ownPrices`, from his sales around then), only listings at those prices.
 */
export function candidates(rec, prev, ownPrices = null) {
  const out = [];
  const want = listedPrice(rec);
  for (const [id, l] of prev) {
    if (l.item !== rec.item) continue;
    if (rec.kind === 'buy' && l.commodity) {
      if (l.unit !== null && l.unit <= want + 0.5) out.push(id);
      continue;
    }
    if (l.qty !== rec.stack) continue;
    if (want !== null) { if (l.unit !== null && Math.abs(l.unit - want) <= 1) out.push(id); continue; }
    if (ownPrices?.size && (l.unit === null || ![...ownPrices].some((p) => Math.abs(l.unit - p) <= 1))) continue;
    out.push(id);
  }
  return out;
}

/** Josh's listing prices per item from his sales (price / 0.95), to narrow down price-less cancels and expiries. */
export function ownPricesByItem(records, aroundTime, withinS = 2 * 86400) {
  const out = new Map();
  for (const r of records) {
    if (r.kind !== 'sale' || Math.abs(r.time - aroundTime) > withinS) continue;
    if (!out.has(r.item)) out.set(r.item, new Set());
    out.get(r.item).add(listedPrice(r));
  }
  return out;
}

/** Which snapshot pairs may hold the event: sales up to 2 h before the record (mail delay), others the pair around it. */
export function pairWindow(rec) {
  return rec.kind === 'sale' ? [rec.time - 2 * 3600, rec.time + 300] : [rec.time, rec.time + 300];
}

/** What the record should look like to the estimate, and what counts as right. */
export const EXPECT = {
  sale: { right: ['certain', 'probable'], label: 'detected' },
  buy: { right: ['certain', 'probable'], label: 'detected' },
  cancel: { right: ['reposted', 'unclear'], label: 'not counted' },
  expiry: { right: ['unclear'], label: 'not counted' },
};

/** Totals per kind: { kind: { total, right, wrong, invisible, noData, byOutcome } } from matched results. */
export function summarize(results) {
  const out = {};
  for (const r of results) {
    const s = (out[r.kind] ??= { total: 0, right: 0, wrong: 0, invisible: 0, unmatched: 0, noData: 0, byOutcome: {} });
    s.total += r.count;
    s.byOutcome[r.outcome] = (s.byOutcome[r.outcome] ?? 0) + r.count;
    if (r.outcome === 'invisible') s.invisible += r.count;
    else if (r.outcome === 'no-data') s.noData += r.count;
    else if (r.outcome === 'unmatched') s.unmatched += r.count; // a matching listing was there but never changed
    else if (EXPECT[r.kind].right.includes(r.outcome)) s.right += r.count;
    else s.wrong += r.count;
  }
  return out;
}

/** Spearman rank correlation of two equal-length arrays (ties get average ranks). */
export function spearman(a, b) {
  const rank = (v) => {
    const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    for (let i = 0; i < o.length;) {
      let j = i;
      while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++;
      for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length;
  if (n < 3) return null;
  const ma = ra.reduce((s, x) => s + x, 0) / n, mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return num / Math.sqrt(da * db);
}
