import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tsmPlaces, totals, itemIdOf, updateHoldingsLog, readHoldingsLog } from './holdings.mjs';

const db = {
  's@Xria Forever - Alliance - Normal@internalData@bagQuantity': { 'i:7067': 2 },
  's@Xria Forever - Alliance - Normal@internalData@mailQuantity': { 'i:7067': 1140, 'i:13444': 25 },
  's@Xria Forever - Alliance - Normal@internalData@bankQuantity': {},
  's@Desti Xria - Alliance - Normal@internalData@auctionQuantity': { 'i:13444': 8 },
  's@Xria Two - Horde - Normal@internalData@bagQuantity': { 'i:7067': 5, 'i:1234::12': 1, 'p:999': 1 },
  's@Yamjam Layer - Alliance - PvP@internalData@bagQuantity': { 'i:7067': 100 }, // other realm: not counted
  'f@Alliance - Normal@internalData@pendingMail': { 'Scarce Bavvb': { 'i:249391': 3141 }, 'Misc Bavvb': {} },
  'f@Alliance - Normal@internalData@guildVaults': { CBW: { 'i:249391': 9 } },
  'f@Horde - Normal@internalData@guildVaults': {},
  'f@internalData@guildVaults': 102,
  's@Xria Forever - Alliance - Normal@internalData@money': 5,
};

test('itemIdOf', () => {
  assert.equal(itemIdOf('i:249391'), 249391);
  assert.equal(itemIdOf('i:1234::12'), 1234);
  assert.equal(itemIdOf('p:999'), null);
});

test('tsmPlaces: characters, unopened mail and guild banks, Normal realm only', () => {
  const p = tsmPlaces(db);
  assert.deepEqual(p['Alliance:7067'], { 'Xria Forever|bag': 2, 'Xria Forever|mail': 1140 });
  assert.deepEqual(p['Alliance:13444'], { 'Xria Forever|mail': 25, 'Desti Xria|auction': 8 });
  assert.deepEqual(p['Alliance:249391'], { 'Scarce Bavvb|pending': 3141, 'guild:CBW': 9 });
  assert.deepEqual(p['Horde:7067'], { 'Xria Two|bag': 5 });
  assert.deepEqual(p['Horde:1234'], { 'Xria Two|bag': 1 });
  const t = totals(p);
  assert.equal(t['Alliance:7067'], 1142);
  assert.equal(t['Alliance:249391'], 3150);
  assert.equal(Object.keys(p).length, 5);
});

test('updateHoldingsLog writes a reading only when a TSM file changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holdings-'));
  const wtf = path.join(root, 'Account');
  const sv = path.join(wtf, 'acct1', 'SavedVariables');
  fs.mkdirSync(sv, { recursive: true });
  fs.mkdirSync(path.join(wtf, 'acct2', 'SavedVariables'), { recursive: true }); // no TSM on it
  const file = path.join(sv, 'TradeSkillMaster.lua');
  fs.writeFileSync(file, 'TradeSkillMasterDB = {\n["s@A B - Alliance - Normal@internalData@bagQuantity"] = {\n["i:7067"] = 3,\n},\n}\n');
  const dir = path.join(root, 'holdings');
  assert.deepEqual(updateHoldingsLog({ wtfAccountDir: wtf, dir }), { added: 1, accounts: 1 });
  assert.deepEqual(updateHoldingsLog({ wtfAccountDir: wtf, dir }), { added: 0, accounts: 1 });
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(file, 'TradeSkillMasterDB = {\n["s@A B - Alliance - Normal@internalData@bagQuantity"] = {\n["i:7067"] = 1,\n},\n}\n');
  fs.utimesSync(file, later, later);
  assert.equal(updateHoldingsLog({ wtfAccountDir: wtf, dir }).added, 1);
  const r = readHoldingsLog(dir);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => x.items['Alliance:7067']['A B|bag']), [3, 1]);
  assert.ok(fs.existsSync(path.join(dir, 'README.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});
