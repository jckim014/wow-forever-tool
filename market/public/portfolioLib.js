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
  return { rows, total: sumOf(top), faction, house };
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
