// Pure logic for the PC sync (sync.mjs): zip reading, per-item summaries, alert bookkeeping. Tested in syncLib.test.mjs.
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------------------------------------------
// Zip (GitHub artifact downloads). Stored and deflated entries; no zip64 (artifacts are far below 4 GB).

/** Returns Map(name -> Buffer) for every file in a zip. Throws on anything it can't read. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error('zip64 not supported');
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`zip: unsupported method ${method} for ${name}`);
    if (data.length !== size) throw new Error(`zip: ${name} unpacked to ${data.length} bytes, expected ${size}`);
    files.set(name, data);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-item summaries: the same figures as the app (app/src/prices/auctioneer.ts pricesFromUnits; checked against it
// by app/src/history/collectorSummary.test.ts).

export const SUMMARY_COLUMNS = ['lowest', 'median', 'cheapest15', 'units', 'listings'];
const CHEAPEST_SHARE = 0.15;

export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** byItem: Map(item -> [unitPrice, units][]). Returns { [item]: [lowest, median, cheapest15, units, listings] }. */
export function summarizeUnits(byItem) {
  const out = {};
  for (const item of [...byItem.keys()].sort((a, b) => a - b)) {
    const xs = byItem.get(item);
    xs.sort((p, q) => p[0] - q[0]);
    const units = xs.reduce((s, x) => s + x[1], 0);
    let acc = 0, med = xs[xs.length - 1][0];
    for (const [pr, n] of xs) {
      acc += n;
      if (acc >= units / 2) { med = pr; break; }
    }
    const need = Math.max(1, CHEAPEST_SHARE * units);
    let took = 0, sum = 0;
    for (const [pr, n] of xs) {
      const take = Math.min(n, need - took);
      sum += pr * take;
      took += take;
      if (took >= need) break;
    }
    out[item] = [roundHalfEven(xs[0][0]), roundHalfEven(med), roundHalfEven(sum / took), units, xs.length];
  }
  return out;
}

/**
 * One house's summary from its API responses (either may be null if not in this snapshot).
 * Auctions: `buyout` for the listing (divided by quantity, though on 2026-11-12 every auction had quantity 1: stacks
 * are commodities); bid-only listings are left out. Commodities: `unit_price` per unit.
 */
export function summarizeHouse(auctionsJson, commoditiesJson) {
  const byItem = new Map();
  const add = (item, unit, units) => {
    let xs = byItem.get(item);
    if (!xs) byItem.set(item, (xs = []));
    xs.push([unit, units]);
  };
  let listings = 0, bidOnly = 0;
  for (const a of auctionsJson?.auctions ?? []) {
    listings++;
    if (!(a.buyout > 0) || !(a.quantity > 0)) { bidOnly++; continue; }
    add(a.item.id, a.buyout / a.quantity, a.quantity);
  }
  for (const a of commoditiesJson?.auctions ?? []) {
    listings++;
    if (!(a.unit_price > 0) || !(a.quantity > 0)) { bidOnly++; continue; }
    add(a.item.id, a.unit_price, a.quantity);
  }
  return { listings, bidOnly, items: summarizeUnits(byItem) };
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshot ids and paths

/** "20261112T202239Z" -> Date. */
export function snapshotDate(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/** ["2026", "11", "12"] (UTC date of the data). */
export function snapshotDayParts(id) {
  return [id.slice(0, 4), id.slice(4, 6), id.slice(6, 8)];
}

// ---------------------------------------------------------------------------------------------------------------
// Alerts: a condition notifies when it starts, reminds every REMIND_MS while it lasts, and says when it clears.

export const REMIND_MS = 6 * 60 * 60 * 1000;

/**
 * conditions: { key: message } active now. previous: { key: { since, lastNotified, message } }.
 * Returns { notify: [{ key, title, message }], state }.
 */
export function updateAlerts(conditions, previous, now) {
  const notify = [];
  const state = {};
  for (const [key, message] of Object.entries(conditions)) {
    const prev = previous?.[key];
    if (!prev) {
      notify.push({ key, title: 'Auction sync: problem', message });
      state[key] = { since: now, lastNotified: now, message };
    } else if (now - prev.lastNotified >= REMIND_MS || prev.message !== message) {
      const hours = ((now - prev.since) / 3600000).toFixed(0);
      notify.push({ key, title: `Auction sync: still a problem (${hours} h)`, message });
      state[key] = { since: prev.since, lastNotified: now, message };
    } else {
      state[key] = prev;
    }
  }
  for (const [key, prev] of Object.entries(previous ?? {})) {
    if (!(key in conditions)) notify.push({ key, title: 'Auction sync: fixed', message: `Cleared: ${prev.message}` });
  }
  return { notify, state };
}

/** GitHub's token expiry header ("2027-11-12 21:00:00 UTC") -> ms, or null. */
export function parseTokenExpiry(header) {
  if (!header) return null;
  const t = Date.parse(header.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(t) ? null : t;
}
