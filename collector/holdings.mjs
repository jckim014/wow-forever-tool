// Holdings log (Josh, 2026-11-23, for Forever Market's Portfolio tab): what TSM says Josh owns, per faction, item and
// place, recorded each time an account's TradeSkillMaster.lua changes (TSM writes it at logout or /reload). TSM is
// the source for holdings; the log lets the Portfolio tell a TSM loss (e.g. the 100-mail mailbox limit: opening a
// mailbox with more than 100 mails clears TSM's unopened-mail entry while its mailbox count only sees the first 100)
// from a real change. The SavedVariables files are only read.
//
// Log: <data root>\holdings\YYYY-MM.jsonl (local month of the file time), one line per reading:
//   { t: file time (Unix s), account, items: { "Alliance:249391": { "Scarce Bavvb|pending": 3141, ... } } }
// Places: "<char>|bag" / "|bank" / "|mail" / "|auction" (TSM's per-character counts), "<char>|pending" (mail sent
// between own characters, not opened yet), "guild:<name>" (guild bank).
import fs from 'node:fs';
import path from 'node:path';
import { parseSavedVariables, monthOf } from './ledger.mjs';

export const TSM_REALM = 'Normal';
const FACTIONS = new Set(['Alliance', 'Horde']);
const fix = (s) => Buffer.from(String(s), 'latin1').toString('utf8'); // file read as latin1; names are UTF-8

/** "i:249391" / "i:1234::12" -> 249391 / 1234; anything else (pets "p:...") -> null. */
export function itemIdOf(s) {
  const m = /^i:(\d+)/.exec(String(s));
  return m ? Number(m[1]) : null;
}

function addAll(out, faction, place, table) {
  for (const [s, q] of Object.entries(table ?? {})) {
    const id = itemIdOf(s);
    const n = Number(q);
    if (!id || !(n > 0)) continue;
    const k = `${faction}:${id}`;
    const p = (out[k] ??= {});
    p[place] = (p[place] ?? 0) + n;
  }
}

/**
 * Parsed TradeSkillMasterDB -> { "Faction:itemID": { place: units } } for one realm ("Normal" = Josh's PvE realm;
 * the PvP characters are left out, as in the Method check).
 */
export function tsmPlaces(db, realm = TSM_REALM) {
  const out = {};
  const esc = realm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const charRe = new RegExp(`^s@(.+) - (Alliance|Horde) - ${esc}@internalData@(bag|bank|mail|auction)Quantity$`);
  const facRe = new RegExp(`^f@(Alliance|Horde) - ${esc}@internalData@(pendingMail|guildVaults)$`);
  for (const [key, v] of Object.entries(db ?? {})) {
    if (!v || typeof v !== 'object') continue;
    let m = charRe.exec(key);
    if (m) { addAll(out, m[2], `${fix(m[1])}|${m[3]}`, v); continue; }
    m = facRe.exec(key);
    if (m && FACTIONS.has(m[1])) {
      for (const [who, t] of Object.entries(v)) {
        if (t && typeof t === 'object') addAll(out, m[1], m[2] === 'pendingMail' ? `${fix(who)}|pending` : `guild:${fix(who)}`, t);
      }
    }
  }
  return out;
}

/** { key: { place: units } } -> { key: total units }. */
export function totals(places) {
  const out = {};
  for (const [k, p] of Object.entries(places ?? {})) out[k] = Object.values(p).reduce((s, n) => s + n, 0);
  return out;
}

/** Every account folder's TradeSkillMaster.lua: [{ account, file, t (mtime, Unix s) }]. */
export function tsmFiles(wtfAccountDir) {
  let accounts = [];
  try {
    accounts = fs.readdirSync(wtfAccountDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
  const out = [];
  for (const a of accounts) {
    const file = path.join(wtfAccountDir, a, 'SavedVariables', 'TradeSkillMaster.lua');
    try { out.push({ account: a, file, t: Math.floor(fs.statSync(file).mtimeMs / 1000) }); } catch { /* no TSM on it */ }
  }
  return out;
}

/** One account's reading: { t, account, items } (throws on an unreadable file). */
export function readTsm({ account, file, t }) {
  const saved = parseSavedVariables(fs.readFileSync(file, 'latin1'));
  return { t, account, items: tsmPlaces(saved.TradeSkillMasterDB) };
}

/** Every reading in the log folder (all months), oldest first; broken lines skipped. */
export function readHoldingsLog(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && typeof r.t === 'number' && r.account && r.items) out.push(r); } catch { /* broken line */ }
    }
  }
  // the sync and Forever Market's Refresh can both log the same file version: keep one
  const seen = new Set();
  return out.sort((a, b) => a.t - b.t).filter((r) => { const k = `${r.account}|${r.t}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const README = `Holdings log: what TradeSkillMaster says Josh owns, per faction, item and place, written by the hourly auction
sync (collector/holdings.mjs in the wow-forever-tool repo) each time an account's TradeSkillMaster.lua changed
(TSM writes it at logout or /reload). Started 2026-11-23. Used by Forever Market's Portfolio tab to spot units that
TSM loses (e.g. the 100-mail mailbox limit) and keep showing them.

One file per month (local time of the reading), one JSON object per line, lines only ever added:
  { t: the TSM file's time (Unix seconds), account: WoW account folder,
    items: { "Faction:itemID": { place: units } } }
Places: "<character>|bag", "|bank", "|mail", "|auction" (TSM's counts per character), "<character>|pending" (mail
sent between own characters, not opened yet), "guild:<name>" (guild bank). Only the "Normal" (PvE) realm.
`;

/**
 * Appends a reading for every account whose TradeSkillMaster.lua changed since its last logged reading.
 * Returns { added, accounts } (accounts = TSM files found). Throws on an unreadable file or a write failure.
 */
export function updateHoldingsLog({ wtfAccountDir, dir }) {
  const files = tsmFiles(wtfAccountDir);
  if (!files.length) return { added: 0, accounts: 0 };
  const last = new Map();
  for (const r of readHoldingsLog(dir)) last.set(r.account, Math.max(last.get(r.account) ?? 0, r.t));
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.txt');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  let added = 0;
  for (const f of files) {
    if ((last.get(f.account) ?? -1) >= f.t) continue;
    let r;
    try { r = readTsm(f); } catch (e) { throw new Error(`${f.account}: ${e.message}`); }
    fs.appendFileSync(path.join(dir, `${monthOf(r.t)}.jsonl`), `${JSON.stringify(r)}\n`);
    added++;
  }
  return { added, accounts: files.length };
}
