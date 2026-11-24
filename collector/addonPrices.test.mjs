import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addonPricesLua } from './addonPrices.mjs';

test('addonPricesLua: one line per item, prices as lowest:median:cheapest15, blanks kept blank', () => {
  const lua = addonPricesLua({
    Alliance: { house: 111, t: 1795480000, rows: [{ item: 2589, lowest: 10, median: 12.4, cheapest15: 11 }, { item: 14047, lowest: 500, median: null, cheapest15: 520 }] },
    Horde: { house: 114, t: 1795480100, rows: [] },
  }, 1795481000000);
  assert.match(lua, /^-- Written by/);
  assert.match(lua, /written = 1795481000,/);
  assert.match(lua, /Alliance = \{ house = 111, t = 1795480000, items = \{\n    \[2589\] = "10:12:11",\n    \[14047\] = "500::520",\n  \} \},/);
  assert.match(lua, /Horde = \{ house = 114, t = 1795480100, items = \{\n  \} \},/);
  assert.ok(lua.trimEnd().endsWith('}'));
});
