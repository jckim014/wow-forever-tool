// Portfolio tab's pure logic (no DOM): Josh's holdings laid out like a plan's tree. Descriptive only (Josh,
// 2026-11-23): what he holds, what he paid, what it's worth; no targets or advice. Tested in market/portfolioLib.test.mjs.

export const lookupName = (n) => n.item ?? n.name;
export const FACTION_OF = { 111: 'Alliance', 114: 'Horde' };

/** The value measure for an /api/prices entry: its 7-day reference price on that house, else its latest cheapest 15%. */
export const refPriceOf = (p, house) => p?.ref?.[house] ?? p?.latest?.[house]?.cheapest15 ?? null;

/**
 * One plan -> rows depth-first: { node, depth, group, key, held, tsm, bought, avgPaid, price, value, flag, missingPrice }.
 * holdings: { "Faction:itemID": { tsm, shown, bought, paid, flag } } (/api/holdings); prices: name -> { id, latest:
 * { 111: { cheapest15 }, 114: ... }, ref: { 111: copper, 114: ... } } | null (/api/prices). Value = units held x the
 * reference price on the plan's faction (7-day median of the hourly cheapest 15%; Josh, 2026-11-25), else the latest
 * cheapest 15% when the item had no hourly price in that week (before the AH cut). A group's value counts each item once, even when it sits on several of its lines.
 */
export function portfolioRows(plan, holdings, prices) {
  const house = plan.house === 114 ? 114 : 111;
  const faction = FACTION_OF[house];
  const rows = [];
  const leafOf = (n) => {
    const p = prices?.[lookupName(n)];
    const id = p?.id ?? null;
    const key = id ? `${faction}:${id}` : null;
    const h = key ? holdings?.[key] : null;
    const held = h ? h.shown : 0;
    const price = refPriceOf(p, house);
    return {
      key, held, tsm: h ? h.tsm : 0, bought: h?.bought ?? 0, flag: h?.flag ?? null,
      avgPaid: h?.bought > 0 ? h.paid / h.bought : null,
      price, value: held > 0 ? (price ? held * price : null) : 0,
      noItem: !id,
    };
  };
  // returns Map(key -> leaf) of the subtree, for the group sums
  const rec = (node, depth) => {
    const all = new Map();
    for (const n of node.children ?? []) {
      if (n.children?.length) {
        const row = { node: n, depth, group: true };
        rows.push(row);
        const sub = rec(n, depth + 1);
        Object.assign(row, sumOf(sub));
        for (const [k, v] of sub) all.set(k, v);
      } else {
        const leaf = leafOf(n);
        rows.push({ node: n, depth, group: false, ...leaf });
        if (leaf.key) all.set(leaf.key, leaf);
      }
    }
    return all;
  };
  const top = rec(plan.tree, 0);
  const total = sumOf(top);
  shareOfParent(rows);
  return { rows, total, faction, house };
}

/**
 * Sets each row's `share`: its value as a % of the line it sits in (an item's group, a group's wallet, a top line's
 * plan), like the Plan's "% of parent" but from what is held (Josh, 2026-11-25). Lines with no weight in the plan
 * (w 0, e.g. one-offs kept outside the weights) are left out of the calculation (Josh): they get no share and don't
 * count in their parent's base, so the weighted lines next to them compare with their weights directly. A group
 * counts its weighted lines only. Share is null for those lines, and when the base is 0 or the line has no price.
 */
export function shareOfParent(rows) {
  const kids = new Map([[-1, []]]); // parent row index (-1 = the plan) -> child row indexes
  const stack = [];
  rows.forEach((r, i) => {
    stack.length = r.depth;
    kids.get(stack.length ? stack[stack.length - 1] : -1).push(i);
    if (r.group) { kids.set(i, []); stack.push(i); }
  });
  const weighted = (r) => Number(r.node?.w) > 0;
  const wv = new Map(); // row index -> weighted value (null = no price)
  const valueOf = (i) => {
    if (wv.has(i)) return wv.get(i);
    const r = rows[i];
    let v = r.value;
    if (r.group) { v = 0; for (const k of kids.get(i)) if (weighted(rows[k])) v += valueOf(k) ?? 0; }
    wv.set(i, v);
    return v;
  };
  for (const [p, ks] of kids) {
    let base = 0;
    for (const k of ks) if (weighted(rows[k])) base += valueOf(k) ?? 0;
    for (const k of ks) {
      const v = valueOf(k);
      rows[k].share = weighted(rows[k]) && base > 0 && v !== null ? (100 * v) / base : null;
    }
  }
}

/** Distinct items -> { value, missingPrice: units held with no price, flagged: items flagged }. */
export function sumOf(leaves) {
  let value = 0, missingPrice = 0, flagged = 0;
  for (const l of leaves.values()) {
    if (l.value === null) missingPrice++;
    else value += l.value;
    if (l.flag) flagged++;
  }
  return { value, missingPrice, flagged };
}

/** Points off the plan weight at which Portfolio colours a line (Josh, 2026-11-25). */
export const DRIFT_POINTS = 5;

/**
 * How far a line's held share is from its plan weight (Josh, 2026-11-25: "60% (-10%)"-style marker). Both in % of the
 * parent line; diff in points. level: 'over' / 'under' once DRIFT_POINTS off, or under half / over double the weight
 * (so small lines, which 5 points can't reach, are caught too; Josh, 2026-11-25), else 'ok'. Null when there is no
 * target (weight 0 or missing) or no share.
 */
export function drift(share, target) {
  if (share === null || share === undefined || !(target > 0)) return null;
  const diff = share - target;
  const ratio = share / target;
  const off = Math.abs(diff) >= DRIFT_POINTS || ratio < 0.5 || ratio > 2;
  return { diff, ratio, level: !off ? 'ok' : diff > 0 ? 'over' : 'under' };
}
