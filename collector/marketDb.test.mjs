import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, insertSummary, snapshotSeconds, storedSnapshotIds } from './marketDb.mjs';

const summary = (snapshot, houses) => ({ format: 'forever-auction-summary', version: 1, snapshot, collectedAt: 'x', columns: [], houses });

test('snapshot ids to seconds', () => {
  assert.equal(snapshotSeconds('20261113T042242Z'), Date.parse('2026-11-13T04:22:42Z') / 1000);
  assert.equal(snapshotSeconds('nope'), null);
});

test('insert, query, re-insert replaces rows', () => {
  const db = openDb(':memory:');
  const n = insertSummary(db, summary('20261113T042242Z', {
    111: { listings: 3, bidOnly: 0, items: { 2589: [28, 30, 29, 13483, 384], 4306: [200, 222, 201, 3354, 143] } },
    114: { listings: 1, bidOnly: 1, items: { 2589: [25, 27, 26, 900, 40] } },
  }));
  assert.equal(n, 3);
  const t = snapshotSeconds('20261113T042242Z');
  assert.deepEqual({ ...db.prepare('SELECT * FROM prices WHERE item = 2589 AND house = 114').get() },
    { item: 2589, house: 114, t, lowest: 25, median: 27, cheapest15: 26, units: 900, listings: 40 });
  // the same snapshot again with a changed figure: that row is replaced, the others stay
  insertSummary(db, summary('20261113T042242Z', { 111: { listings: 1, bidOnly: 0, items: { 2589: [30, 30, 30, 10, 1] } } }));
  assert.equal(db.prepare('SELECT count(*) n FROM prices').get().n, 3);
  assert.equal(db.prepare('SELECT cheapest15 c FROM prices WHERE item = 2589 AND house = 111').get().c, 30);
  assert.deepEqual([...storedSnapshotIds(db)], ['20261113T042242Z']);
  assert.deepEqual(db.prepare('SELECT item FROM item_ids ORDER BY item').all().map((r) => r.item), [2589, 4306]);
  assert.throws(() => insertSummary(db, { format: 'other' }), /not a forever-auction-summary/);
});
