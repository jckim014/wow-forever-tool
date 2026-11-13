import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRegionSale, itemIdOf } from './tsm.mjs';

// Shape copied from the real AppData.lua (2026-11-13); values for Linen Cloth (2589) and Arcanite Bar (12360) are real.
const sample = 'select(2, ...).LoadData("AUCTIONDB_REGION_SALE","Forever-US",[[return {downloadTime=1794476311,'
  + 'fields={"itemString","regionSale","regionSoldPerDay","regionSalePercent"},'
  + 'data={{200,0,0,0},{2589,N,F86LQ,TQ},{12360,HMCP,2SK,74},{"i:2589:1",1,1,1},{"p:40:1",5,5,5}}}]]) --<RAW_DATA>';

test('item strings', () => {
  assert.equal(itemIdOf('2589'), 2589);
  assert.equal(itemIdOf('"i:12360:0"'), 12360);
  assert.equal(itemIdOf('p:40:1'), null);
});

test('region sale block: base 32, copper, x1000 scales', () => {
  const r = parseRegionSale(sample);
  assert.equal(r.downloadTime, 1794476311);
  assert.deepEqual(r.items.get(2589), { saleAvg: 23, soldPerDay: 15997.626, saleRate: 0.954 });
  assert.deepEqual(r.items.get(12360), { saleAvg: 579993, soldPerDay: 2.964, saleRate: 0.228 });
  assert.equal(r.items.size, 3); // 200, 2589, 12360 (the variant row and the pet are skipped)
  assert.equal(parseRegionSale('nothing here'), null);
});
