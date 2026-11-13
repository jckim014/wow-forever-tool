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
export const RETRY_MISSING_MS = 24 * 60 * 60 * 1000;
/** Named items are checked again after this long, in case a patch renamed them. */
export const REFRESH_NAMED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * IDs (numbers) that need fetching, most urgent first: never fetched, then missing and due for a retry, then named
 * but due for the monthly re-check (oldest first). The sync fetches at most 120 per run, so new items never wait
 * behind re-checks.
 */
export function toFetch(ids, cache, now) {
  const fresh = [], retry = [], refresh = [];
  for (const id of new Set(ids.map(String))) {
    const c = cache[id];
    const age = c ? now - Date.parse(c.at) : Infinity;
    if (!c) fresh.push(Number(id));
    else if (c.missing && age > RETRY_MISSING_MS) retry.push(Number(id));
    else if (!c.missing && age > REFRESH_NAMED_MS) refresh.push([Number(id), Date.parse(c.at)]);
  }
  fresh.sort((a, b) => a - b);
  retry.sort((a, b) => a - b);
  refresh.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return [...fresh, ...retry, ...refresh.map((r) => r[0])];
}
