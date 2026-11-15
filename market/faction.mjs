// Faction arbitrage (Josh, 2026-11-13): buy on the cheap faction's AH, move the item through Blackwater (list it there
// at the buy price, the other character buys it: 15% of that price is lost), sell on the dear faction's AH (5% cut).
//   buy  = cheap side's average of the cheapest 15% of units (robust to a single bait listing)
//   sell = dear side's lowest listing, unless it is under 80% of the dear side's cheapest-15% average (a lone outlier,
//          e.g. a bait auction): then that average, and the row says the outlier was ignored
//   profit per unit = sell x 0.95 - buy / 0.85, both directions (Josh, 2026-11-15; replaced buy x 1.15 and the
//   "send the gold back" / "Horde's gold comes from Alliance" switches): each faction keeps a fixed pool of gold; the
//   transfer listing returns 85% of the buy price to the buying side, and the 15% it loses is refilled from the selling
//   side by a junk item (Skinning Knife), which loses 15% too: 0.15 / 0.85 = 17.6% of the cut, so the buy costs
//   1 + 0.15 + 0.026 = 1 / 0.85. Break-even: sell ~24% above buy. Profit stays on the faction sold on; moving it
//   elsewhere costs another 15% (not included). Deposits left out: they come back when the item sells.
// Pure; tested in faction.test.mjs.

export const AH_CUT = 0.05;
export const TRANSFER_CUT = 0.15; // Blackwater, confirmed by Josh 2026-11-13
export const OUTLIER_RATIO = 0.8;
export const THIN_UNITS = 2; // cheap side with this few units, or dear side with this few listings, is "thin"

/** One direction for one item. cheap/dear: { lowest, cheapest15, units, listings } at the same snapshot. */
export function trade(cheap, dear) {
  if (!cheap || !dear || !(cheap.cheapest15 > 0) || !(dear.lowest > 0)) return null;
  const buy = cheap.cheapest15;
  const outlier = dear.cheapest15 > 0 && dear.lowest < OUTLIER_RATIO * dear.cheapest15;
  const sell = outlier ? dear.cheapest15 : dear.lowest;
  const profit = sell * (1 - AH_CUT) - buy / (1 - TRANSFER_CUT);
  return {
    buy, sell, profit, margin: profit / buy, outlier,
    thin: (cheap.units ?? 0) <= THIN_UNITS || (dear.listings ?? 0) <= THIN_UNITS,
  };
}

/**
 * Steadiness over a window: of the snapshots where both sides had the item, the share where this direction was
 * profitable. series: Map(t -> { cheap, dear }). Returns { profitable, seen }.
 */
export function steadiness(series) {
  let profitable = 0, seen = 0;
  for (const { cheap, dear } of series.values()) {
    const r = trade(cheap, dear);
    if (!r) continue;
    seen++;
    if (r.profit > 0) profitable++;
  }
  return { profitable, seen };
}
