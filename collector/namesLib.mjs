// Pure logic for item names (fetch_names.mjs): reading Wowhead / Blizzard item responses and choosing what to fetch.
// Game data only (name, quality, icon): never auction-house data (CLAUDE.md hard rule).

/** Wowhead Forever tooltip JSON -> { name, quality, icon }, or null if it has no name. */
export function fromWowhead(json) {
  if (!json || typeof json.name !== 'string' || !json.name.trim()) return null;
  return {
    name: json.name.trim(),
    quality: Number.isInteger(json.quality) ? json.quality : null,
    icon: typeof json.icon === 'string' ? json.icon : null,
  };
}

const QUALITY = { POOR: 0, COMMON: 1, UNCOMMON: 2, RARE: 3, EPIC: 4, LEGENDARY: 5, ARTIFACT: 6, HEIRLOOM: 7 };

/** Blizzard game-data item JSON (locale=en_US) -> { name, quality, icon: null }, or null. */
export function fromBlizzard(json) {
  const name = typeof json?.name === 'string' ? json.name : json?.name?.en_US;
  if (typeof name !== 'string' || !name.trim()) return null;
  const q = QUALITY[json?.quality?.type];
  return { name: name.trim(), quality: q ?? null, icon: null };
}

/** How long to wait before asking again about an item no source could name. */
export const RETRY_MISSING_MS = 7 * 24 * 60 * 60 * 1000;

/** IDs (numbers, ascending) that need fetching: not in the cache, or missing and due for a retry. */
export function toFetch(ids, cache, now) {
  const out = [];
  for (const id of ids) {
    const c = cache[id];
    if (!c || (c.missing && now - Date.parse(c.at) > RETRY_MISSING_MS)) out.push(Number(id));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
