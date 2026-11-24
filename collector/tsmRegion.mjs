// Reads TSM's region sale data from the TSM desktop app's file (Interface\AddOns\TradeSkillMaster_AppHelper\AppData.lua):
// block LoadData("AUCTIONDB_REGION_SALE","Forever-US",[[return {downloadTime=..., fields={...}, data={{...},...}}]]).
// Numbers are base 32 (0-9A-V). regionSale is copper; regionSoldPerDay and regionSalePercent are x1000 (confirmed by
// Josh against TSM's in-game tooltip, 2026-11-13: Linen Cloth 15,997,626 -> 15,997.6 sold/day, 954 -> 0.954 sale rate).
// These are pooled sales of TSM users across the whole Forever-US region, not Josh's realm.

const b32 = (v) => (v === undefined || v === '' ? null : parseInt(v, 32));

/** Item ID from a TSM itemString: plain number (decimal) or "i:123[:...]"; null for pets and others. */
export function itemIdOf(itemString) {
  const s = String(itemString).replace(/^"|"$/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^i:(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

/**
 * Parses the region sale block. Returns { region, downloadTime (Unix s), items: Map(id -> { saleAvg, soldPerDay,
 * saleRate }) }, or null if the file has no such block. When an item appears more than once (variants), the first wins.
 */
export function parseRegionSale(text, region = 'Forever-US') {
  const start = text.indexOf(`LoadData("AUCTIONDB_REGION_SALE","${region}",[[`);
  if (start < 0) return null;
  const end = text.indexOf(']]', start);
  const body = text.slice(start, end);
  const downloadTime = Number(/downloadTime=(\d+)/.exec(body)?.[1]) || null;
  const fields = (/fields=\{([^}]*)\}/.exec(body)?.[1] ?? '').split(',').map((f) => f.trim().replace(/"/g, ''));
  const col = (name) => fields.indexOf(name);
  const [ci, cs, cd, cp] = [col('itemString'), col('regionSale'), col('regionSoldPerDay'), col('regionSalePercent')];
  if ([ci, cs, cd, cp].some((c) => c < 0)) throw new Error(`unexpected TSM fields: ${fields.join(', ')}`);
  const items = new Map();
  const data = body.slice(body.indexOf('data='));
  for (const m of data.matchAll(/\{([^{}]*)\}/g)) {
    const v = m[1].split(',');
    const id = itemIdOf(v[ci]);
    if (id === null || items.has(id)) continue;
    const sold = b32(v[cd]), rate = b32(v[cp]);
    items.set(id, { saleAvg: b32(v[cs]), soldPerDay: sold === null ? null : sold / 1000, saleRate: rate === null ? null : rate / 1000 });
  }
  return { region, downloadTime, items };
}
