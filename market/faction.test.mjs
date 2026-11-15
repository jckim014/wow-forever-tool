import test from 'node:test';
import assert from 'node:assert/strict';
import { trade, steadiness } from './faction.mjs';

const side = (lowest, cheapest15, units = 50, listings = 20) => ({ lowest, cheapest15, units, listings });

test('profit = sell x 0.95 - buy / 0.85 (cut refilled from the selling side)', () => {
  const r = trade(side(9000, 10000), side(14000, 15000));
  assert.equal(r.buy, 10000);
  assert.equal(r.sell, 14000);
  assert.ok(Math.abs(r.profit - (14000 * 0.95 - 10000 / 0.85)) < 1e-9);
  assert.ok(Math.abs(r.margin - r.profit / 10000) < 1e-9);
  assert.equal(r.outlier, false);
  assert.equal(r.thin, false);
  // the example shown to Josh: buy 10g, sell 15g -> 2.49g
  assert.equal(Math.round(trade(side(1, 100000), side(150000, 150000)).profit / 100), 249);
});

test('break-even needs the expensive side ~24% above the buy price', () => {
  assert.ok(trade(side(1, 100), side(123, 130)).profit < 0);
  assert.ok(trade(side(1, 100), side(124, 130)).profit > 0);
});

test('a lone low listing on the dear side is ignored', () => {
  const r = trade(side(9000, 10000), side(5000, 15000)); // 5000 < 80% of 15000
  assert.equal(r.sell, 15000);
  assert.equal(r.outlier, true);
  assert.equal(trade(side(9000, 10000), side(12500, 15000)).outlier, false); // 12500 >= 12000: a real floor
});

test('thin markets and missing sides', () => {
  assert.equal(trade(side(9000, 10000, 2), side(14000, 15000)).thin, true);
  assert.equal(trade(side(9000, 10000), side(14000, 15000, 50, 1)).thin, true);
  assert.equal(trade(null, side(1, 1)), null);
  assert.equal(trade(side(0, 0), side(1, 1)), null);
});

test('steadiness counts profitable snapshots among those with both sides', () => {
  const s = new Map([
    [1, { cheap: side(1, 100), dear: side(200, 210) }], // profitable
    [2, { cheap: side(1, 100), dear: side(110, 120) }], // not
    [3, { cheap: null, dear: side(200, 210) }],          // not listed on the cheap side: not counted
  ]);
  assert.deepEqual(steadiness(s), { profitable: 1, seen: 2 });
  const b = new Map([[1, { cheap: side(1, 100), dear: side(122, 130) }]]); // was profitable at buy x 1.15, not at buy / 0.85
  assert.deepEqual(steadiness(b), { profitable: 0, seen: 1 });
});
