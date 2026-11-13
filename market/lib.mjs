// Pure logic for the Forever Market server (server.mjs). Tested in lib.test.mjs.

/**
 * Items matching a search, best first: exact name, name starts with it, a word starts with it, then anywhere in the
 * name; ties by name. A number also matches the item ID exactly. items: [{ id, name, quality }].
 */
export function searchItems(items, query, limit = 50) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const asId = /^\d+$/.test(q) ? Number(q) : null;
  const scored = [];
  for (const it of items) {
    const n = it.name.toLowerCase();
    let score = -1;
    if (asId !== null && it.id === asId) score = 0;
    else if (n === q) score = 1;
    else if (n.startsWith(q)) score = 2;
    else if (n.split(/[\s:'-]+/).some((w) => w.startsWith(q))) score = 3;
    else if (n.includes(q)) score = 4;
    if (score >= 0) scored.push([score, it]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));
  return scored.slice(0, limit).map((s) => s[1]);
}

/** The server stops when no open tab has checked in for this long (tabs check in every minute). */
export const IDLE_MS = 10 * 60 * 1000;

/** True if the server should stop: no heartbeat (or start) within IDLE_MS. */
export const shouldStop = (lastSeen, now, idle = IDLE_MS) => now - lastSeen > idle;

/** items.json ({id: {name, quality, icon} | {missing}}) -> [{ id, name, quality, icon }], named items only. */
export function itemList(cache) {
  const out = [];
  for (const [id, v] of Object.entries(cache)) {
    if (v && typeof v.name === 'string') out.push({ id: Number(id), name: v.name, quality: v.quality ?? null, icon: v.icon ?? null });
  }
  return out;
}
