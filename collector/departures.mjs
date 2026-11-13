// Our own sale-rate estimate: what left an auction house early between two consecutive hourly snapshots.
// The API has no sales and no sellers; each listing has an ID, a quantity and a time-left bucket
// (SHORT < 30 min, MEDIUM 30 min-2 h, LONG 2-12 h, VERY_LONG 12-48 h). Rules (revisable; history below):
//  - certain:  a commodity listing still there with a lower quantity (part of it was bought; can't be cancelled).
//  - probable: a listing that vanished while it had LONG or VERY_LONG left (can't have expired within the hour),
//              so it was bought or cancelled ...
//  - reposted: ... unless a new listing of the same item and quantity at a lower unit price appeared (likely a
//              cancel-and-undercut), which is not counted. Each new listing explains at most one vanished one (v2).
//  - unclear:  vanished with SHORT or MEDIUM left (may simply have expired): not counted.
// Snapshots more than MAX_GAP apart are not compared (a missed hour would blur everything). Pure; tested.
// v1 2026-11-13: first version. v2 2026-11-13: one new cheaper listing no longer marks every vanished listing of the
//   same item and quantity as a repost (the Method check found 15 of Josh's 83 buys written off that way).

export const METHOD_VERSION = 2;
export const MAX_GAP_S = 90 * 60;
const CAN_EXPIRE = new Set(['SHORT', 'MEDIUM']);

/** One house's listings from its two API responses -> Map(auctionId -> { item, qty, timeLeft, unit, commodity }). */
export function indexListings(auctionsJson, commoditiesJson) {
  const m = new Map();
  for (const a of auctionsJson?.auctions ?? []) {
    const unit = a.buyout > 0 ? a.buyout / a.quantity : null; // bid-only listings have no unit price
    m.set(a.id, { item: a.item.id, qty: a.quantity, timeLeft: a.time_left, unit, commodity: false });
  }
  for (const a of commoditiesJson?.auctions ?? []) {
    m.set(a.id, { item: a.item.id, qty: a.quantity, timeLeft: a.time_left, unit: a.unit_price, commodity: true });
  }
  return m;
}

/**
 * What happened to one listing of `prev` by `next`: 'still' (unchanged), 'certain' (with the units bought),
 * 'probable', 'reposted' or 'unclear'. `newByKey` is built by newListingsByKey(prev, next).
 */
export function classify(id, before, next, newByKey) {
  const after = next.get(id);
  if (after) {
    if (before.commodity && after.qty < before.qty) return { kind: 'certain', units: before.qty - after.qty };
    return { kind: 'still', units: 0 };
  }
  if (CAN_EXPIRE.has(before.timeLeft)) return { kind: 'unclear', units: before.qty };
  const fresh = newByKey.get(`${before.item}:${before.qty}`);
  if (fresh && before.unit !== null) {
    // the dearest new listing still below this one's price explains it; that listing is then used up
    let best = -1;
    fresh.forEach((u, i) => { if (u !== null && u < before.unit && (best < 0 || u > fresh[best])) best = i; });
    if (best >= 0) { fresh.splice(best, 1); return { kind: 'reposted', units: before.qty }; }
  }
  return { kind: 'probable', units: before.qty };
}

/** Listings in `next` that weren't in `prev`, by "item:qty" -> [unit prices]. classify() uses entries up, so build it
 *  afresh for each pair and classify that pair's listings in one pass. */
export function newListingsByKey(prev, next) {
  const out = new Map();
  for (const [id, l] of next) {
    if (prev.has(id)) continue;
    const k = `${l.item}:${l.qty}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(l.unit);
  }
  return out;
}

/** Per item: { certain, probable, reposted, unclear } units between two snapshots of one house. */
export function compareSnapshots(prev, next) {
  const newByKey = newListingsByKey(prev, next);
  const per = new Map();
  for (const [id, before] of prev) {
    const c = classify(id, before, next, newByKey);
    if (c.kind === 'still') continue;
    let r = per.get(before.item);
    if (!r) per.set(before.item, (r = { certain: 0, probable: 0, reposted: 0, unclear: 0 }));
    r[c.kind] += c.units;
  }
  return per;
}
