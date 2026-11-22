import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPrices, newestPerHouse } from './bscan.mjs';
import { summarizeUnits } from '../collector/syncLib.mjs';

const saved = (scan) => ({ BavvbScanDB: { scan: { format: 'bavvbscan', version: 1, realm: 'R', time: 1000, auctions: 4, ...scan } } });

test('scanPrices: per-unit prices from stack buyouts, same figures as the hourly summaries', () => {
  // item 2589: a stack of 20 for 2000c (100c each), one at 150c; a bid-only listing (buyout 0) is left out
  const s = scanPrices(saved({ faction: 'Horde', items: { 2589: '20:2000,1:150,5:0', 2592: '1:500' } }));
  assert.equal(s.house, 114);
  assert.equal(s.t, 1000);
  const expect = summarizeUnits(new Map([[2589, [[100, 20], [150, 1]]], [2592, [[500, 1]]]]));
  assert.deepEqual(s.items.get(2589), expect[2589]);
  assert.deepEqual(s.items.get(2592), expect[2592]);
  assert.equal(s.items.get(2589)[3], 21); // units
});

test('scanPrices: no usable scan', () => {
  assert.equal(scanPrices({}), null);
  assert.equal(scanPrices({ BavvbScanDB: { sales: {} } }), null);
  assert.equal(scanPrices(saved({ faction: 'Neutral', items: { 1: '1:1' } })), null);
  assert.equal(scanPrices(saved({ faction: 'Alliance', version: 2, items: { 1: '1:1' } })), null);
  assert.equal(scanPrices(saved({ faction: 'Alliance', items: {} })), null);
});

test('newestPerHouse keeps the newest scan of each faction', () => {
  const a = (t) => ({ house: 111, t }), h = (t) => ({ house: 114, t });
  const out = newestPerHouse([a(5), null, h(3), a(9), a(7)]);
  assert.equal(out[111].t, 9);
  assert.equal(out[114].t, 3);
  assert.deepEqual(newestPerHouse([null]), {});
});
