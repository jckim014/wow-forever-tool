import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse, days, overlaps, bestWindows, BREAK_EVEN_SWING } from './timing.mjs';

const UTC = { tzOffsetMin: 0 };
const day0 = Date.parse('2026-11-16T00:22:00Z') / 1000;
/** n days of hourly points; price(dayIndex, hour) -> copper or null (not listed). */
function series(n, price) {
  const pts = [];
  for (let d = 0; d < n; d++) for (let h = 0; h < 24; h++) {
    const v = price(d, h);
    if (v !== null) pts.push([day0 + d * 86400 + h * 3600, v]);
  }
  return pts;
}

test('finds a clear daily pattern: cheap 4-8, expensive 18-22', () => {
  const r = analyse(series(5, (d, h) => (h >= 4 && h < 8 ? 80 : h >= 18 && h < 22 ? 120 : 100)), UTC);
  assert.equal(r.days, 5);
  assert.equal(r.cheapStart, 4);
  assert.equal(r.expStart, 18);
  assert.ok(Math.abs(r.swing - 0.5) < 1e-9);
  assert.equal(r.cheapPrice, 80);
  assert.equal(r.expPrice, 120);
  assert.equal(r.profit, 120 * 0.95 - 80);
  assert.deepEqual([r.held, r.tested], [5, 5]);
});

test('a price drifting from day to day is not a time-of-day pattern', () => {
  const r = analyse(series(6, (d) => 100 * 1.1 ** d), UTC); // flat within each day, +10% a day
  assert.ok(Math.abs(r.swing) < 1e-9);
  assert.equal(r.profit < 0, true);
  assert.equal(r.held, 0);
});

test('one odd day does not make a pattern', () => {
  const r = analyse(series(6, (d, h) => (d === 2 && h >= 18 && h < 22 ? 300 : 100)), UTC);
  assert.ok(Math.abs(r.swing) < 1e-9); // the profile takes the median day
  assert.ok(r.held <= 1);
});

test('windows wrap past midnight', () => {
  const r = analyse(series(4, (d, h) => (h >= 22 || h < 2 ? 70 : h >= 10 && h < 14 ? 110 : 100)), UTC);
  assert.equal(r.cheapStart, 22);
  assert.equal(r.expStart, 10);
});

test('too few days, short days and local time', () => {
  assert.deepEqual(analyse(series(1, () => 100), UTC), { days: 1 });
  // a day with fewer than 12 priced hours doesn't count
  assert.equal(days(series(3, (d, h) => (d === 1 && h % 2 ? null : 100)), UTC).length, 3);
  assert.equal(days(series(3, (d, h) => (d === 1 && h > 9 ? null : 100)), UTC).length, 2);
  // UTC 4-8 is 20-24 the day before in UTC-8
  const r = analyse(series(5, (d, h) => (h >= 4 && h < 8 ? 80 : 100)), { tzOffsetMin: -480 });
  assert.equal(r.cheapStart, 20);
});

test('the pattern found on other days is what each day is checked against', () => {
  // three days cheap in the morning, three cheap in the evening: no window holds on most days
  const r = analyse(series(6, (d, h) => ((d % 2 ? h >= 4 && h < 8 : h >= 18 && h < 22) ? 80 : 100)), UTC);
  assert.ok(r.held < r.tested / 2, `${r.held} of ${r.tested}`);
});

test('overlap and break-even', () => {
  assert.equal(overlaps(4, 7, 4), true);
  assert.equal(overlaps(4, 8, 4), false);
  assert.equal(overlaps(22, 1, 4), true);
  assert.equal(overlaps(22, 2, 4), false);
  assert.ok(Math.abs(BREAK_EVEN_SWING - 0.0526315789) < 1e-9);
  assert.equal(bestWindows(Array(24).fill(null), 4), null);
});
