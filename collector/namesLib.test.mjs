import test from 'node:test';
import assert from 'node:assert/strict';
import { fromWowhead, fromBlizzard, toFetch, RETRY_MISSING_MS } from './namesLib.mjs';

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

test('what to fetch: new ids, and missing ones after a week', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const cache = {
    1: { name: 'A' },
    2: { missing: true, at: '2026-11-19T00:00:00Z' },
    3: { missing: true, at: new Date(now - RETRY_MISSING_MS - 1).toISOString() },
  };
  assert.deepEqual(toFetch(['4', '1', '2', '3', '4'], cache, now), [3, 4]);
});
