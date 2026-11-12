// Pure logic for the auction collector: no network, no files. Tested in lib.test.mjs.
import crypto from 'node:crypto';

/** The 15 WoW Forever US auction houses seen on 2026-11-12. Any change fails the run. */
export const EXPECTED_HOUSES = [110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 123, 124, 125];

/** Each house is fetched twice: its regular auctions and its commodities. */
export const KINDS = ['auctions', 'commodities'];

/** A house that had at least this many listings fails the run if it drops below half of that. */
export const SHRINK_MIN_PREVIOUS = 5000;
export const SHRINK_RATIO = 0.5;

/** Blizzard's newest data older than this fails the run. */
export const STALE_MS = 3 * 60 * 60 * 1000;

/** A cached token is reused while it has at least this long left. */
export const TOKEN_MARGIN_MS = 60 * 60 * 1000;

// Fields seen in the probe (2026-11-12) and in the Retail auction format. Anything else is reported, not fatal.
const KNOWN_TOP = new Set(['_links', 'connected_realm', 'ruleset', 'auctions', 'commodities', 'id', 'name']);
const KNOWN_AUCTION = new Set(['id', 'item', 'buyout', 'bid', 'quantity', 'time_left', 'unit_price']);
const KNOWN_ITEM = new Set(['id', 'context', 'bonus_lists', 'modifiers', 'pet_breed_id', 'pet_level', 'pet_quality_id', 'pet_species_id']);

const isInt = (v) => Number.isInteger(v);

/** Compares the house list from the API with the expected one. Returns a problem string or null. */
export function checkHouseList(index) {
  const list = index?.auctions;
  if (!Array.isArray(list)) return 'house list: no "auctions" array in the response';
  const ids = list.map((h) => h?.id).sort((a, b) => a - b);
  const added = ids.filter((id) => !EXPECTED_HOUSES.includes(id));
  const removed = EXPECTED_HOUSES.filter((id) => !ids.includes(id));
  if (added.length || removed.length) {
    return `house list changed: added [${added.join(', ')}], removed [${removed.join(', ')}]`;
  }
  return null;
}

/**
 * Checks one house response. kind is 'auctions' or 'commodities'.
 * Returns { listings, items, errors: string[], newFields: string[] }.
 * An empty house has no "auctions" field at all (seen for 112, 115, 118).
 */
export function checkHouseData(json, kind) {
  const errors = [];
  const newFields = new Set();
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { listings: 0, items: 0, errors: ['response is not a JSON object'], newFields: [] };
  }
  for (const k of Object.keys(json)) if (!KNOWN_TOP.has(k)) newFields.add(k);
  const list = json.auctions ?? [];
  if (!Array.isArray(list)) {
    return { listings: 0, items: 0, errors: ['"auctions" is not an array'], newFields: [...newFields] };
  }
  const items = new Set();
  let bad = 0;
  let firstBad = null;
  for (const a of list) {
    let why = null;
    if (!a || typeof a !== 'object') why = 'not an object';
    else if (!isInt(a.id)) why = 'no id';
    else if (!a.item || !isInt(a.item.id)) why = 'no item.id';
    else if (!isInt(a.quantity) || a.quantity <= 0) why = 'no quantity';
    else if (typeof a.time_left !== 'string') why = 'no time_left';
    else if (kind === 'commodities' && !isInt(a.unit_price)) why = 'no unit_price';
    else if (kind === 'auctions' && !isInt(a.buyout) && !isInt(a.bid)) why = 'neither buyout nor bid';
    if (why) {
      bad++;
      firstBad ??= `${why}: ${JSON.stringify(a).slice(0, 200)}`;
      continue;
    }
    items.add(a.item.id);
    for (const k of Object.keys(a)) if (!KNOWN_AUCTION.has(k)) newFields.add(`auction.${k}`);
    for (const k of Object.keys(a.item)) if (!KNOWN_ITEM.has(k)) newFields.add(`auction.item.${k}`);
  }
  if (bad) errors.push(`${bad} of ${list.length} listings are malformed, first: ${firstBad}`);
  return { listings: list.length, items: items.size, errors, newFields: [...newFields].sort() };
}

/** Returns a problem string if a big house shrank to under half of its previous size, else null. */
export function checkShrink(previous, current) {
  if (previous == null || previous < SHRINK_MIN_PREVIOUS) return null;
  if (current >= previous * SHRINK_RATIO) return null;
  return `shrank from ${previous} to ${current} listings`;
}

/** Returns a problem string if the newest Last-Modified is older than STALE_MS, else null. */
export function checkStale(lastModifiedValues, now) {
  const times = lastModifiedValues.map((v) => Date.parse(v)).filter((t) => !Number.isNaN(t));
  if (!times.length) return 'no Last-Modified times known';
  const newest = Math.max(...times);
  const age = now - newest;
  if (age <= STALE_MS) return null;
  return `Blizzard's newest data is ${(age / 3600000).toFixed(1)} h old (from ${new Date(newest).toISOString()})`;
}

/** Snapshot id from the newest Last-Modified among the files in it, e.g. "20261112T192239Z". */
export function snapshotId(lastModifiedValues) {
  const newest = Math.max(...lastModifiedValues.map((v) => Date.parse(v)));
  return new Date(newest).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** True if the cached token can still be used at `now`. */
export function tokenUsable(token, now) {
  return Boolean(token?.accessToken) && Number.isFinite(token.expiresAt) && token.expiresAt - now > TOKEN_MARGIN_MS;
}

// Token cache encryption: AES-256-GCM with a key derived from the TOKEN_CACHE_KEY secret.
const keyFrom = (secret) => crypto.createHash('sha256').update(String(secret)).digest();

export function encryptJson(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

/** Returns the decrypted value, or null if the text is not ours or the key is wrong. */
export function decryptJson(text, secret) {
  try {
    const box = JSON.parse(text);
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
}
