import test from 'node:test';
import assert from 'node:assert/strict';
import { median, segments, weekdayHourGrid, daily, niceTicks, nearest } from './public/stats.js';

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null, 5]), 5);
  assert.equal(median([]), null);
});

test('segments break where the item was not listed', () => {
  const snaps = [10, 20, 30, 40, 50];
  assert.deepEqual(segments([[10, 1], [20, 2], [40, 4], [50, 5]], snaps), [[[10, 1], [20, 2]], [[40, 4], [50, 5]]]);
  assert.deepEqual(segments([[30, null]], snaps), []);
});

test('weekday x hour grid and daily medians (UTC for the test)', () => {
  // 2026-11-16 is a Monday
  const mon10 = Date.parse('2026-11-16T10:05:00Z') / 1000;
  const pts = [[mon10, 100], [mon10 + 7 * 86400, 300], [mon10 + 3600, 50], [mon10 + 86400, null]];
  const g = weekdayHourGrid(pts, 0);
  assert.deepEqual(g[0][10], { value: 200, n: 2 });
  assert.deepEqual(g[0][11], { value: 50, n: 1 });
  assert.deepEqual(g[1][10], { value: null, n: 0 });
  assert.deepEqual(daily(pts, 0), [
    { date: '2026-11-16', weekday: 0, value: 75, n: 2 },
    { date: '2026-11-23', weekday: 0, value: 300, n: 1 },
  ]);
  // Pacific (UTC-8): Monday 10:05 UTC is Monday 02:05 local
  assert.equal(weekdayHourGrid([[mon10, 1]], -480)[0][2].n, 1);
});

test('nice ticks and nearest', () => {
  assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(23, 31, 4), [24, 26, 28, 30]);
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(niceTicks(21.5, 29.8, 4), [22.5, 25, 27.5]);
  assert.deepEqual(niceTicks(21.5, 29.8, 4, true), [22, 24, 26, 28]); // whole copper
  assert.deepEqual(niceTicks(0.2, 1.9, 4, true), [1]);
  assert.equal(nearest([10, 20, 30], 24), 1);
  assert.equal(nearest([10, 20, 30], 26), 2);
  assert.equal(nearest([], 1), -1);
});
