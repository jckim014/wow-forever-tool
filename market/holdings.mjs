// Portfolio tab's figures (Josh, 2026-11-23): what he holds, from TSM, and what he paid, from the mail ledger.
// TSM is the source for holdings: crafting, sending things away and selling all lower its count, and that is right.
// Only one kind of drop is treated as TSM losing units: the 100-mail mailbox limit. A mailbox shows at most 100 mails;
// when a character opens one holding more, TSM clears that character's unopened-mail entry ("<char>|pending") but its
// mailbox count only sees the first 100, so the rest drop out. So per reading and character: units that left its
// unopened mail without turning up in its own bags, bank, mailbox or auctions are "lost" and stay shown (flagged)
// until they turn up on that character later (the mails over the cap get opened) or Josh says TSM is right.
// Characters in NOT_COUNTED (Josh: Simone Sharpe, his crafter) don't count: what goes to her leaves the portfolio,
// what comes back from her is back in it.
import fs from 'node:fs';
import path from 'node:path';
import { readHoldingsLog, tsmFiles, readTsm, updateHoldingsLog } from '../collector/holdings.mjs';

export const MIN_UNITS = 5;                         // a loss is flagged from this many units
export const NOT_COUNTED = ['Simone Sharpe'];       // default; portfolio.json "notCounted" overrides

const charOf = (place) => (place.startsWith('guild:') ? null : place.slice(0, place.lastIndexOf('|')));
const sumOf = (p, skip) => Object.entries(p ?? {}).reduce((s, [pl, n]) => (skip(pl) ? s : s + n), 0);

/**
 * Readings (oldest first, any accounts) -> Map(key -> [{ t, total, changes: [{ account, char, pending, own }] }]):
 * the total over all accounts after each reading (each account counts with its latest reading; characters in
 * notCounted left out) and, per character of that account, how much its unopened mail fell (pending > 0) and how much
 * its own places (bag, bank, mail, auction) rose (own, may be negative) since that account's previous reading.
 */
export function itemSteps(readings, notCounted = NOT_COUNTED) {
  const skipChar = new Set(notCounted);
  const skip = (pl) => skipChar.has(charOf(pl));
  const latest = new Map();  // account -> reading
  const now = new Map();     // key -> total
  const out = new Map();
  for (const r of readings) {
    const prev = latest.get(r.account);
    const keys = new Set([...Object.keys(prev?.items ?? {}), ...Object.keys(r.items ?? {})]);
    for (const k of keys) {
      const a = prev?.items?.[k] ?? {}, b = r.items?.[k] ?? {};
      const total = (now.get(k) ?? 0) - sumOf(a, skip) + sumOf(b, skip);
      now.set(k, total);
      const changes = [];
      if (prev) {
        const chars = new Set([...Object.keys(a), ...Object.keys(b)].map(charOf).filter((c) => c && !skipChar.has(c)));
        for (const c of chars) {
          const pending = (a[`${c}|pending`] ?? 0) - (b[`${c}|pending`] ?? 0);
          let own = 0;
          for (const w of ['bag', 'bank', 'mail', 'auction']) own += (b[`${c}|${w}`] ?? 0) - (a[`${c}|${w}`] ?? 0);
          if (pending > 0 || own) changes.push({ account: r.account, char: c, pending: Math.max(0, pending), own });
        }
      }
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ t: r.t, total, changes });
    }
    latest.set(r.account, r);
  }
  return out;
}

/**
 * One item's check. steps: from itemSteps; accepted: { tsm } (Josh said TSM is right at that count) or undefined.
 * Returns { tsm, shown, flag }, flag = { since, lost: [{ char, units }] } while units are missing.
 */
export function checkItem(steps = [], accepted) {
  const lost = new Map(); // account|char -> units
  let since = null, tsm = 0;
  for (const s of steps) {
    tsm = s.total;
    for (const c of s.changes) {
      const id = `${c.account}|${c.char}`;
      const was = lost.get(id) ?? 0;
      const net = c.pending - Math.max(0, c.own);                   // > 0: left unopened mail without arriving
      const back = Math.max(0, c.own - c.pending);                  // arrived beyond what left unopened mail
      const now = Math.max(0, was + Math.max(0, net) - back);
      if (now) lost.set(id, now); else lost.delete(id);
      if (!was && now) since ??= s.t;
    }
    if (accepted && accepted.tsm === s.total) lost.clear();
    if (![...lost.values()].some((n) => n > 0)) since = null;
  }
  const missing = [...lost.values()].reduce((a, n) => a + n, 0);
  if (missing < MIN_UNITS) return { tsm, shown: tsm, flag: null };
  return {
    tsm, shown: tsm + missing,
    flag: { since, lost: [...lost].map(([id, units]) => ({ char: id.slice(id.indexOf('|') + 1), units })).sort((x, y) => y.units - x.units) },
  };
}

/** Ledger lines -> Map("Faction:itemID" -> { bought, paid }) from purchases with status ok (for Avg paid). */
export function ledgerFacts(lines) {
  const out = new Map();
  for (const e of lines) {
    if (e?.kind !== 'buy' || e.status !== 'ok') continue;
    const n = Number(e.count);
    if (!e.itemID || !(n > 0) || !e.faction) continue;
    const k = `${e.faction}:${e.itemID}`;
    const x = out.get(k) ?? { bought: 0, paid: 0 };
    x.bought += n;
    x.paid += Number(e.price) || 0;
    out.set(k, x);
  }
  return out;
}

/** Everything the Portfolio needs: { "Faction:itemID": { tsm, shown, bought, paid, flag } }. */
export function holdingsFrom(readings, facts, accepted = {}, notCounted = NOT_COUNTED) {
  const steps = itemSteps(readings, notCounted);
  const out = {};
  for (const k of new Set([...steps.keys(), ...facts.keys()])) {
    const f = facts.get(k);
    const r = checkItem(steps.get(k), accepted[k]);
    if (!r.tsm && !r.shown && !f?.bought) continue;
    out[k] = { ...r, bought: f?.bought ?? 0, paid: f?.paid ?? 0 };
  }
  return out;
}

// ---- files (read only, except portfolio.json) ----

/** Every ledger *.jsonl line in dir, parsed (broken lines skipped). */
function readLedger(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* broken line */ }
    }
  }
  return out;
}

const stamp = (dir) => {
  try { return fs.readdirSync(dir).map((f) => { try { return `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`; } catch { return f; } }).join('|'); } catch { return ''; }
};

export const PORTFOLIO_FORMAT = 'forever-portfolio';

/** portfolio.json -> { accepted: { key: { tsm, at } }, notCounted: [character names] }. */
export function readPortfolio(file) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const ok = d?.format === PORTFOLIO_FORMAT;
  return {
    accepted: ok && d.accepted && typeof d.accepted === 'object' ? d.accepted : {},
    notCounted: ok && Array.isArray(d.notCounted) ? d.notCounted.map(String) : NOT_COUNTED,
  };
}

/** Records "TSM is right" for an item at its current TSM count (null tsm removes it). */
export function writeAccepted(file, key, tsm) {
  const p = readPortfolio(file);
  if (tsm === null) delete p.accepted[key];
  else p.accepted[key] = { tsm, at: new Date().toISOString() };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ format: PORTFOLIO_FORMAT, version: 1, notCounted: p.notCounted, accepted: p.accepted }, null, 1));
  fs.renameSync(tmp, file);
}

/**
 * Reader for the server. Each call (page open, Refresh) first logs any TradeSkillMaster.lua that changed since its
 * last logged reading (the same step the hourly sync runs, so every version of the file is kept for the check), then
 * reads the log and the ledger (again only when they changed). If the log can't be written, the new file is still
 * read for this answer.
 */
export function holdingsReader({ wtfAccountDir, logDir, ledgerDir, portfolioFile }) {
  let logCache = { key: null, readings: [] };
  let ledgerCache = { key: null, lines: [] };
  return function read() {
    let logError = null;
    try { updateHoldingsLog({ wtfAccountDir, dir: logDir }); } catch (e) { logError = e.message; }
    const lk = stamp(logDir);
    if (lk !== logCache.key) logCache = { key: lk, readings: readHoldingsLog(logDir) };
    const dk = stamp(ledgerDir);
    if (dk !== ledgerCache.key) ledgerCache = { key: dk, lines: readLedger(ledgerDir) };
    const files = tsmFiles(wtfAccountDir);
    const readings = [...logCache.readings];
    if (logError) {
      const lastLogged = new Map();
      for (const r of readings) lastLogged.set(r.account, Math.max(lastLogged.get(r.account) ?? 0, r.t));
      for (const f of files) {
        if ((lastLogged.get(f.account) ?? -1) >= f.t) continue;
        try { readings.push(readTsm(f)); } catch { /* being written: next time */ }
      }
      readings.sort((x, y) => x.t - y.t);
    }
    const { accepted, notCounted } = readPortfolio(portfolioFile);
    return {
      files: files.map((f) => ({ account: f.account, t: f.t })),
      readings: readings.length,
      notCounted,
      logError,
      items: holdingsFrom(readings, ledgerFacts(ledgerCache.lines), accepted, notCounted),
    };
  };
}
