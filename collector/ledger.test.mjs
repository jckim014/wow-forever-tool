import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSavedVariables, entriesFrom, monthOf, uniqueNames, keysIn, updateLedger } from './ledger.mjs';

const T = 1794836000; // 2026-11-16

const file = (records, visits = []) => {
  const lua = (o) => {
    if (Array.isArray(o)) return `{\n${o.map((x, j) => `${lua(x)}, -- [${j + 1}]`).join('\n')}\n}`;
    if (o && typeof o === 'object') return `{\n${Object.entries(o).map(([k, v]) => `["${k}"] = ${lua(v)},`).join('\n')}\n}`;
    if (typeof o === 'string') return `"${o.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return String(o);
  };
  return `\nBavvbScanDB = ${lua({ scan: { items: { 2589: '20:1000,5:300' }, time: T }, sales: { format: 'bavvbsales', version: 1, next: 9, records, visits } })}\n`;
};

test('parseSavedVariables: tables, arrays, escapes, comments, numbers', () => {
  const v = parseSavedVariables('A = {\n["x"] = "a\\"b\\\\c\\n",\n[3] = -1.5,\n{ 1, 2 }, -- [1]\n["e"] = {},\n["t"] = true,\n}\nB = nil\n');
  assert.equal(v.A.x, 'a"b\\c\n');
  assert.equal(v.A[3], -1.5);
  assert.deepEqual(v.A[1], [1, 2]);
  assert.deepEqual(v.A.e, []);
  assert.equal(v.A.t, true);
  assert.equal(v.B, null);
  assert.equal(parseSavedVariables('X = "\\195\\169"').X, 'Ã©'); // bytes as latin1; decoded later
});

test('entriesFrom: sales, purchases (kind), visits; account added', () => {
  const s = parseSavedVariables(file(
    [{ id: 'Xria-1-1', t: T, item: 'Linen Cloth', count: 20, received: 9500, status: 'ok' },
      { id: 'Xria-1-2', kind: 'buy', t: T + 5, item: 'Silk Cloth', itemID: 4306, count: 10, price: 5000, status: 'ok' }],
    [{ id: 'Xria-1-3', t0: T - 10, t1: T + 10, goldIn: 9500 }]));
  const e = entriesFrom(s, 'ACC');
  assert.deepEqual(e.map((x) => [x.kind, x.id, x.account]), [['sale', 'Xria-1-1', 'ACC'], ['buy', 'Xria-1-2', 'ACC'], ['visit', 'Xria-1-3', 'ACC']]);
  assert.deepEqual(entriesFrom({ BavvbScanDB: { scan: {} } }, 'ACC'), []);
  assert.throws(() => entriesFrom({ BavvbScanDB: { sales: { format: 'bavvbsales', version: 2 } } }, 'ACC'), /v2/);
});

test('monthOf, uniqueNames, keysIn', () => {
  assert.match(monthOf(T), /^2026-11$/);
  const m = uniqueNames({ 1: { name: 'Linen Cloth' }, 2: { name: 'Twin' }, 3: { name: 'twin' }, 4: { missing: true } });
  assert.equal(m.get('linen cloth'), 1);
  assert.equal(m.get('twin'), null);
  assert.deepEqual([...keysIn('{"account":"A","id":"x"}\n{"acc\n')], ['A|x']);
});

test('updateLedger: copies new entries once, per month, from every account; item IDs by name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const wtf = path.join(root, 'Account');
  const put = (acct, text) => {
    fs.mkdirSync(path.join(wtf, acct, 'SavedVariables'), { recursive: true });
    fs.writeFileSync(path.join(wtf, acct, 'SavedVariables', 'BavvbScan.lua'), text);
  };
  fs.mkdirSync(path.join(wtf, 'NoAddon'), { recursive: true });
  const old = T - 40 * 86400; // October
  put('A1', file([{ id: 'X-1-1', t: old, item: 'Linen Cloth', count: 1, status: 'ok' }, { id: 'X-1-2', t: T, item: 'Twé', count: 1, status: 'ok' }]));
  put('A2', file([{ id: 'X-1-1', t: T, item: 'Linen Cloth', count: 2, status: 'ok' }])); // same id, other account
  const items = path.join(root, 'items.json');
  fs.writeFileSync(items, JSON.stringify({ 2996: { name: 'Linen Cloth' } }));
  const ledgerDir = path.join(root, 'ledger');
  const args = { wtfAccountDir: wtf, ledgerDir, itemsFile: items };
  const r1 = updateLedger(args);
  assert.equal(r1.added, 3);
  assert.equal(r1.accounts, 2);
  assert.ok(fs.existsSync(path.join(ledgerDir, 'README.txt')));
  const read = (m) => fs.readFileSync(path.join(ledgerDir, `${m}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const nov = read(monthOf(T));
  assert.deepEqual(nov.map((e) => [e.account, e.item, e.itemID]), [['A1', 'Twé', undefined], ['A2', 'Linen Cloth', 2996]]);
  assert.equal(read(monthOf(old))[0].itemID, 2996);
  // Again: nothing new. Then a new record and a pruned old one (gone from the addon, kept in the ledger).
  assert.equal(updateLedger(args).added, 0);
  put('A1', file([{ id: 'X-1-2', t: T, item: 'Twé', count: 1, status: 'ok' }, { id: 'X-1-9', t: T + 60, item: 'Linen Cloth', count: 3, status: 'ok' }]));
  assert.equal(updateLedger(args).added, 1);
  assert.equal(read(monthOf(T)).length, 3);
  assert.equal(read(monthOf(old)).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
