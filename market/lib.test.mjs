// Run with: node --test market/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchItems, shouldStop, IDLE_MS, itemList } from './lib.mjs';
import { formatMoney, formatMoneyAxis } from './public/shared.js';

const items = itemList({
  2589: { name: 'Linen Cloth', quality: 1 },
  2996: { name: 'Bolt of Linen Cloth', quality: 1 },
  4306: { name: 'Silk Cloth', quality: 1 },
  2592: { name: 'Wool Cloth', quality: 1 },
  14047: { name: 'Runecloth', quality: 1 },
  1: { missing: true, at: 'x' },
});

test('item list skips unnamed items', () => {
  assert.equal(items.length, 5);
});

test('search: exact, prefix, word prefix, anywhere; ID by number', () => {
  assert.deepEqual(searchItems(items, 'linen cloth').map((i) => i.id), [2589, 2996]);
  assert.deepEqual(searchItems(items, 'cloth').map((i) => i.id), [2996, 2589, 4306, 2592, 14047]); // words first, then Runecloth (anywhere)
  assert.deepEqual(searchItems(items, 'rune').map((i) => i.id), [14047]);
  assert.deepEqual(searchItems(items, 'ecl').map((i) => i.id), [14047]); // anywhere
  assert.deepEqual(searchItems(items, '4306').map((i) => i.id), [4306]);
  assert.deepEqual(searchItems(items, '  '), []);
  assert.equal(searchItems(items, 'cloth', 2).length, 2);
});

test('idle stop', () => {
  assert.equal(shouldStop(0, IDLE_MS), false);
  assert.equal(shouldStop(0, IDLE_MS + 1), true);
});

test('money format matches the shuffle app', () => {
  assert.equal(formatMoney(12345), '1g 23s 45c');
  assert.equal(formatMoney(20504, true), '2g 05s 04c');
  assert.equal(formatMoney(5), '5c');
  assert.equal(formatMoney(null), '');
  assert.deepEqual([400000, 397500, 250, 5, 10000].map(formatMoneyAxis), ['40g', '39g 75s', '2s 50c', '5c', '1g']);
});
