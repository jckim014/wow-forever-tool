import test from 'node:test';
import assert from 'node:assert/strict';
import { fromWowhead, fromBlizzard, toFetch, RETRY_MISSING_MS, REFRESH_NAMED_MS } from './namesLib.mjs';

test('Wowhead tooltip: name, quality, icon (real shape, 2026-11-12)', () => {
  assert.deepEqual(fromWowhead({ name: 'Pyrite', quality: 2, icon: 'inv_ore_pyrite_nugget', tooltip: '<table>…', spells: [] }),
    { name: 'Pyrite', quality: 2, icon: 'inv_ore_pyrite_nugget' });
  assert.equal(fromWowhead({ error: 'not found' }), null);
  assert.equal(fromWowhead({ name: '  ' }), null);
});

test('Blizzard item: name and quality type', () => {
  assert.deepEqual(fromBlizzard({ id: 2589, name: 'Linen Cloth', quality: { type: 'COMMON', name: 'Common' } }),
    { name: 'Linen Cloth', quality: 1, icon: null });
  assert.deepEqual(fromBlizzard({ name: { en_US: 'Silk Cloth' }, quality: { type: 'X' } }), { name: 'Silk Cloth', quality: null, icon: null });
  assert.equal(fromBlizzard({ code: 404 }), null);
});

test('what to fetch: new first, then missing after a day, then monthly re-checks oldest first', () => {
  const now = Date.parse('2026-12-20T00:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const cache = {
    1: { name: 'A', at: ago(1000) },                       // named recently: skip
    2: { missing: true, at: ago(RETRY_MISSING_MS - 1000) }, // missing, retried less than a day ago: skip
    3: { missing: true, at: ago(RETRY_MISSING_MS + 1000) }, // missing, due
    5: { name: 'E', at: ago(REFRESH_NAMED_MS + 5000) },     // due for re-check (older)
    6: { name: 'F', at: ago(REFRESH_NAMED_MS + 1000) },     // due for re-check (newer)
  };
  assert.deepEqual(toFetch(['6', '5', '4', '1', '2', '3', '4', '9'], cache, now), [4, 9, 3, 5, 6]);
});
