import { test } from 'node:test';
import assert from 'node:assert/strict';
import { portfolioRows } from './public/portfolioLib.js';

const plan = {
  id: 'p', name: 'Raid', house: 111,
  tree: { children: [
    { id: 'g', name: 'Mana', w: 50, children: [
      { id: 'a', name: 'Dark Rune', w: 60 },
      { id: 'b', name: 'Lesser Mana', item: 'Major Mana Potion', w: 40 },
    ] },
    { id: 'c', name: 'Dark Rune', w: 30 },        // same item on a second line: counted once in the plan total
    { id: 'd', name: 'Unknown Thing', w: 20 },
  ] },
};
const prices = {
  'Dark Rune': { id: 20520, latest: { 111: { cheapest15: 15000 }, 114: { cheapest15: 1 } } },
  'Major Mana Potion': { id: 13444, latest: { 111: null, 114: { cheapest15: 9000 } } },
  'Unknown Thing': null,
};
const holdings = {
  'Alliance:20520': { tsm: 79, shown: 79, bought: 26, paid: 26 * 12700, flag: null },
  'Alliance:13444': { tsm: 77, shown: 133, bought: 134, paid: 134 * 8400, flag: { baseline: true, fell: [] } },
  'Horde:20520': { tsm: 5, shown: 5, bought: 0, paid: 0, flag: null },
};

test('rows follow the plan tree, priced on the plan faction', () => {
  const { rows, total, faction } = portfolioRows(plan, holdings, prices);
  assert.equal(faction, 'Alliance');
  assert.deepEqual(rows.map((r) => [r.node.id, r.depth, r.group]), [['g', 0, true], ['a', 1, false], ['b', 1, false], ['c', 0, false], ['d', 0, false]]);
  const rune = rows[1];
  assert.equal(rune.held, 79);
  assert.equal(rune.avgPaid, 12700);
  assert.equal(rune.value, 79 * 15000);
  const mana = rows[2];
  assert.equal(mana.held, 133);          // flagged: the fallback count
  assert.equal(mana.value, null);        // not listed on Alliance
  assert.equal(rows[0].value, 79 * 15000);
  assert.equal(rows[0].missingPrice, 1);
  assert.equal(rows[0].flagged, 1);
  assert.equal(rows[4].noItem, true);
  assert.equal(total.value, 79 * 15000); // Dark Rune once
});

test('Horde plan uses Horde holdings and prices', () => {
  const { rows } = portfolioRows({ ...plan, house: 114 }, holdings, prices);
  assert.equal(rows[1].held, 5);
  assert.equal(rows[1].value, 5);
  assert.equal(rows[1].avgPaid, null);
});

import { refPriceOf } from './public/portfolioLib.js';
test('refPriceOf: the 7-day reference price wins, the latest cheapest 15% only when there is none', () => {
  const p = { latest: { 111: { cheapest15: 8600 }, 114: { cheapest15: 1700 } }, ref: { 111: 1500, 114: null } };
  assert.equal(refPriceOf(p, 111), 1500); // a cleared market's 86s doesn't count
  assert.equal(refPriceOf(p, 114), 1700); // no hourly price that week: today's
  assert.equal(refPriceOf(null, 111), null);
});
