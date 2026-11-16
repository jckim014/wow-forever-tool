// Mail ledger: a permanent copy of BavvbScan's mailbox log (every auction sale and purchase, on every character), for
// bookkeeping and looking back (Josh, 2026-11-16). The addon keeps only 60 days (KEEP_DAYS in Sales.lua) and WoW can
// only write SavedVariables, so the hourly sync copies new records from every account's BavvbScan.lua into
// <data root>\ledger\YYYY-MM.jsonl (local month of the record's time; one JSON object per line; lines are only ever
// added). The SavedVariables files are only read.
//
// Each line is an addon record or visit as saved (see the top of addon/BavvbScan/Sales.lua), plus:
//   kind: "sale" | "buy" | "visit", account: the WoW account folder, itemID: for sales, looked up by name in items.json
//   when exactly one item has that name (purchases carry it from the addon).
// A line is identified by account + id; one already in its month file is never written again.
import fs from 'node:fs';
import path from 'node:path';

// ---- a small reader for WoW SavedVariables (Lua tables of strings, numbers, booleans) ----

/** Lua source -> { name: value } for its top-level assignments. Tables become arrays when their keys are 1..n. */
export function parseSavedVariables(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => { throw new Error(`SavedVariables: ${msg} at offset ${i}`); };
  function ws() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text.startsWith('--', i)) { while (i < n && text[i] !== '\n') i++; } else return;
    }
  }
  function str() {
    const q = text[i++];
    let out = '';
    while (i < n && text[i] !== q) {
      let c = text[i++];
      if (c === '\\') {
        c = text[i++];
        if (c === 'n') out += '\n';
        else if (c === 't') out += '\t';
        else if (c === 'r') out += '\r';
        else if (c === '\n') out += '\n';
        else if (/\d/.test(c)) {
          let d = c;
          while (d.length < 3 && /\d/.test(text[i])) d += text[i++];
          out += String.fromCharCode(Number(d));
        } else out += c;
      } else out += c;
    }
    if (i >= n) fail('unterminated string');
    i++;
    return out;
  }
  function value() {
    ws();
    const c = text[i];
    if (c === '{') return table();
    if (c === '"' || c === "'") return str();
    const m = /^(-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+)|true|false|nil|-?inf|-?nan)/.exec(text.slice(i, i + 40));
    if (!m) fail(`unexpected ${JSON.stringify(text.slice(i, i + 20))}`);
    i += m[0].length;
    if (m[0] === 'true') return true;
    if (m[0] === 'false') return false;
    if (m[0] === 'nil') return null;
    return Number(m[0].replace(/inf$/, 'Infinity'));
  }
  function table() {
    i++; // {
    const obj = {};
    let pos = 1;
    for (;;) {
      ws();
      if (text[i] === '}') { i++; break; }
      let key;
      if (text[i] === '[') {
        i++;
        key = value();
        ws();
        if (text[i] !== ']') fail('expected ]');
        i++;
        ws();
        if (text[i] !== '=') fail('expected =');
        i++;
      } else {
        const m = /^[A-Za-z_]\w*\s*=(?!=)/.exec(text.slice(i, i + 200));
        if (m) { key = m[0].replace(/\s*=$/, ''); i += m[0].length; } else key = pos++;
      }
      obj[key] = value();
      ws();
      if (text[i] === ',' || text[i] === ';') i++;
    }
    const keys = Object.keys(obj);
    if (keys.length && keys.every((k, j) => k === String(j + 1))) return keys.map((k) => obj[k]);
    return keys.length ? obj : [];
  }
  const out = {};
  for (;;) {
    ws();
    if (i >= n) break;
    const m = /^([A-Za-z_]\w*)\s*=/.exec(text.slice(i, i + 200));
    if (!m) fail('expected an assignment');
    i += m[0].length;
    out[m[1]] = value();
  }
  return out;
}

// ---- pure parts ----

/** The sales log in one parsed BavvbScan.lua -> ledger entries (without itemID lookups). */
export function entriesFrom(saved, account) {
  const s = saved?.BavvbScanDB?.sales;
  if (!s || typeof s !== 'object') return [];
  if (s.format !== 'bavvbsales' || s.version !== 1) throw new Error(`${account}: sales log format ${s.format} v${s.version}, expected bavvbsales v1`);
  const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
  const out = [];
  for (const r of list(s.records)) {
    if (!r || !r.id || typeof r.t !== 'number') continue;
    out.push({ ...r, kind: r.kind === 'buy' ? 'buy' : 'sale', account });
  }
  for (const v of list(s.visits)) {
    if (!v || !v.id || typeof v.t0 !== 'number') continue;
    out.push({ ...v, kind: 'visit', account });
  }
  return out;
}

export const entryTime = (e) => (e.kind === 'visit' ? e.t0 : e.t);
export const entryKey = (e) => `${e.account}|${e.id}`;

/** Local calendar month of a Unix time, "YYYY-MM". */
export function monthOf(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** items.json ({ id: { name } }) -> name (lower case) -> id, only for names that belong to exactly one item. */
export function uniqueNames(items) {
  const m = new Map();
  for (const [id, x] of Object.entries(items || {})) {
    if (!x?.name) continue;
    const k = x.name.toLowerCase();
    m.set(k, m.has(k) ? null : Number(id));
  }
  return m;
}

/** Keys already in a month file's text (a broken line, e.g. from a crash mid-write, is skipped). */
export function keysIn(text) {
  const keys = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { keys.add(entryKey(JSON.parse(line))); } catch { /* broken line */ }
  }
  return keys;
}

// ---- files ----

const README = `Mail ledger: every auction sale and purchase collected from a mailbox, on every character, as recorded by the
BavvbScan addon (addon/BavvbScan/Sales.lua in the wow-forever-tool repo) and copied here by the hourly auction sync
(collector/ledger.mjs). Started 2026-11-16.

One file per month (local time of the entry), one JSON object per line, lines only ever added.
kind "sale": an auction sold. t = when its gold reached the character (Unix seconds); item, count; price = sale price of
  the whole stack; cut = AH cut; deposit = listing deposit returned; money = gold in the mail; received = money - deposit
  (= price - cut); status "ok" (gold seen) or "nogold"; mailDaysLeft = days the mail had left (sale mails last 30 days,
  so the sale was about 30 - mailDaysLeft days before t).
kind "buy": an auction won. t = when its items reached the bags; item, itemID, count, price = paid for those units;
  status "ok" or "noitem"; mailCount / mailPrice = the whole won mail (one mail can be emptied over several visits).
kind "visit": one mailbox opening: t0 / t1, goldIn, sales, received, buys, spent and checks.
All entries: char (first word of the name), full (name as shown), guid, faction, realm, account (WoW account folder).
Money is in copper (1g = 10000). Buyer and seller names are never recorded.
`;

/**
 * Copies new entries from every account's BavvbScan.lua under wtfAccountDir into ledgerDir. Returns
 * { added, accounts, files } (files: months written). Throws on an unreadable file or a write failure.
 */
export function updateLedger({ wtfAccountDir, ledgerDir, itemsFile }) {
  const accounts = fs.readdirSync(wtfAccountDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const all = [];
  let read = 0;
  for (const a of accounts) {
    const f = path.join(wtfAccountDir, a, 'SavedVariables', 'BavvbScan.lua');
    if (!fs.existsSync(f)) continue;
    read++;
    let saved;
    try { saved = parseSavedVariables(fs.readFileSync(f, 'latin1').toString()); } catch (e) { throw new Error(`${a}: ${e.message}`); }
    all.push(...entriesFrom(saved, a));
  }
  // latin1 kept every byte; item names are UTF-8 in the file: decode them back.
  for (const e of all) for (const k of ['item', 'char', 'full', 'realm']) {
    if (typeof e[k] === 'string') e[k] = Buffer.from(e[k], 'latin1').toString('utf8');
  }
  if (!all.length) return { added: 0, accounts: read, files: [] };
  let names = null;
  const byMonth = new Map();
  for (const e of all) {
    const m = monthOf(entryTime(e));
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(e);
  }
  fs.mkdirSync(ledgerDir, { recursive: true });
  const readme = path.join(ledgerDir, 'README.txt');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  let added = 0;
  const files = [];
  for (const [m, list] of [...byMonth].sort()) {
    const file = path.join(ledgerDir, `${m}.jsonl`);
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const have = keysIn(old);
    const fresh = list.filter((e) => !have.has(entryKey(e)) && (have.add(entryKey(e)), true))
      .sort((x, y) => entryTime(x) - entryTime(y));
    if (!fresh.length) continue;
    for (const e of fresh) {
      if (e.kind === 'sale' && e.itemID == null && e.item) {
        if (!names) {
          try { names = uniqueNames(JSON.parse(fs.readFileSync(itemsFile, 'utf8'))); } catch { names = new Map(); }
        }
        const id = names.get(e.item.toLowerCase());
        if (id) e.itemID = id;
      }
    }
    const lead = old && !old.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, lead + fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
    added += fresh.length;
    files.push(m);
  }
  return { added, accounts: read, files };
}
