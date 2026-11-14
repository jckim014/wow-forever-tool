import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTsmRecords, candidates, summarize, spearman, ownPricesByItem, pairWindow } from './validate.mjs';

// Shape of TradeSkillMaster.lua's csv strings, one section per realm (names here are made up and must not come out
// of the parser).
const lua = [
  '["r@Normal@internalData@csvSales"] = "itemString,stackSize,quantity,price,otherPlayer,player,time,source\\n'
    + 'i:4238,1,2,285,Someone,MyChar,1794520000,Auction\\ni:4865,4,4,5,Merchant,MyChar,1794520001,Vendor\\n",',
  '["r@Normal@internalData@csvCancelled"] = "itemString,stackSize,quantity,player,time\\ni:2589,20,20,MyChar,1794520500\\n",',
  '["r@PvP@internalData@csvSales"] = "itemString,stackSize,quantity,price,otherPlayer,player,time,source\\n'
    + 'i:4238,1,1,999,Someone,PvpChar,1794520100,Auction\\n",',
  '["r@PvP@internalData@csvExpired"] = "itemString,stackSize,quantity,player,time\\ni:2589,20,20,PvpChar,1794520600\\n",',
].join('\n');

test('TSM records: auction rows only, counts from merged rows, no names', () => {
  const r = parseTsmRecords(lua);
  assert.deepEqual(r, [
    { kind: 'sale', item: 4238, stack: 1, count: 2, price: 285, time: 1794520000 },
    { kind: 'cancel', item: 2589, stack: 20, count: 1, price: null, time: 1794520500 },
  ]);
  assert.ok(!JSON.stringify(r).includes('MyChar') && !JSON.stringify(r).includes('Someone'));
});

test('TSM records: only the chosen realm (other realms trade on other auction houses)', () => {
  assert.ok(!parseTsmRecords(lua).some((x) => x.price === 999 || x.kind === 'expiry'));
  assert.deepEqual(parseTsmRecords(lua, 'PvP').map((x) => x.kind), ['sale', 'expiry']);
  assert.deepEqual(parseTsmRecords(lua, 'Nowhere'), []);
});

test('candidate listings', () => {
  const prev = new Map([
    [1, { item: 4238, qty: 1, unit: 300, commodity: false }],
    [2, { item: 4238, qty: 1, unit: 285, commodity: false }],
    [3, { item: 2589, qty: 20, unit: 25, commodity: true }],
    [4, { item: 2589, qty: 60, unit: 25, commodity: true }],
    [5, { item: 2589, qty: 20, unit: 40, commodity: true }],
  ]);
  // sale recorded at 285 = 300 listed minus the 5% cut
  assert.deepEqual(candidates({ kind: 'sale', item: 4238, stack: 1, price: 285 }, prev), [1]);
  // commodity buy of 84 at 25: any stack at or below 25 (units come from several)
  assert.deepEqual(candidates({ kind: 'buy', item: 2589, stack: 84, price: 25 }, prev), [3, 4]);
  // cancel without price: same stack size; narrowed to own prices when known
  assert.deepEqual(candidates({ kind: 'cancel', item: 2589, stack: 20, price: null }, prev), [3, 5]);
  assert.deepEqual(candidates({ kind: 'cancel', item: 2589, stack: 20, price: null }, prev, new Set([40])), [5]);
});

test('own prices and pair windows', () => {
  const recs = [{ kind: 'sale', item: 7, price: 95, time: 1000 }, { kind: 'sale', item: 7, price: 190, time: 999999 }];
  assert.deepEqual([...ownPricesByItem(recs, 2000).get(7)], [100]);
  assert.deepEqual(pairWindow({ kind: 'sale', time: 10000 }), [10000 - 7200, 10300]);
  assert.deepEqual(pairWindow({ kind: 'expiry', time: 10000 }), [10000, 10300]);
});

test('summary and rank correlation', () => {
  const s = summarize([
    { kind: 'sale', count: 2, outcome: 'probable' }, { kind: 'sale', count: 1, outcome: 'invisible' },
    { kind: 'cancel', count: 1, outcome: 'probable' }, { kind: 'cancel', count: 1, outcome: 'reposted' },
  ]);
  assert.deepEqual(s.sale, { total: 3, right: 2, wrong: 0, invisible: 1, unmatched: 0, noData: 0, byOutcome: { probable: 2, invisible: 1 } });
  assert.deepEqual(s.cancel, { total: 2, right: 1, wrong: 1, invisible: 0, unmatched: 0, noData: 0, byOutcome: { probable: 1, reposted: 1 } });
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
});
