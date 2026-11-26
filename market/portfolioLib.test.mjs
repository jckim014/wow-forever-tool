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

import { shareOfParent } from './public/portfolioLib.js';
test('shareOfParent: an item as % of its group, a group as % of the plan; 0-weight lines left out', () => {
  const W = (w) => ({ w });
  const rows = [
    { depth: 0, group: true, value: 330, node: W(60) },
    { depth: 1, group: false, value: 200, node: W(60) }, { depth: 1, group: false, value: 100, node: W(40) },
    { depth: 1, group: false, value: 30, node: W(0) },  // a one-off: no share, not in the group's base
    { depth: 0, group: true, value: 100, node: W(40) },
    { depth: 1, group: false, value: null, node: W(50) }, { depth: 1, group: false, value: 100, node: W(50) },
  ];
  shareOfParent(rows);
  // group 1 counts 300 (not 330) against group 2's 100
  assert.deepEqual(rows.map((r) => r.share === null ? null : Math.round(r.share)), [75, 67, 33, null, 25, null, 100]);
});

import { drift } from './public/portfolioLib.js';
test('drift: coloured from 5 points off the weight, or under half / over double, over or under', () => {
  assert.equal(drift(54.9, 50).level, 'ok');
  assert.equal(drift(55, 50).level, 'over');
  assert.equal(drift(40, 50).level, 'under');
  assert.equal(drift(3, 7.5).level, 'under');     // only 4.5 points, but under half
  assert.equal(drift(4, 7.5).level, 'ok');        // 3.5 points, 0.53x
  assert.equal(drift(0.4, 5).level, 'under');     // a 5% line can never be 5 points under
  assert.equal(drift(4.5, 2).level, 'over');      // 2.5 points, but over double
  assert.equal(Math.round(drift(60, 50).diff), 10);
  assert.equal(drift(11, 0), null);               // no target: an item kept outside the weights
  assert.equal(drift(null, 50), null);
});
