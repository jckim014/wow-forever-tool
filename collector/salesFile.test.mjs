import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { perDay, salesDoc, tsmPart } from './salesFile.mjs';
import { ensureDepartureTables } from './departuresUpdate.mjs';

test('perDay scales units over the hours present to 24 h', () => {
  assert.deepEqual(perDay([{ item: 1, u: 12 }, { item: 2, u: 0 }, { item: 3, u: 1 }], 48), { 1: 6, 3: 0.5 });
  assert.deepEqual(perDay([{ item: 1, u: 12 }], 0), {});
});

test('salesDoc: last 7 days, skipped pairs and older rows left out, per house', () => {
  const db = new DatabaseSync(':memory:');
  ensureDepartureTables(db);
  const now = Date.UTC(2026, 10, 15, 12) ;
  const t = (h) => Math.floor(now / 1000) - h * 3600;
  const pair = db.prepare('INSERT INTO departure_pairs (house, t, prev_t, skipped, method) VALUES (?, ?, ?, ?, 2)');
  const dep = db.prepare('INSERT INTO departures (item, house, t, certain, probable, reposted, unclear) VALUES (?, ?, ?, ?, ?, 0, 0)');
  pair.run(111, t(1), t(2), 0); pair.run(111, t(2), t(3), 0); pair.run(111, t(5), t(9), 1);
  pair.run(111, t(24 * 8), t(24 * 8 + 1), 0); // older than 7 days
  dep.run(7, 111, t(1), 1, 2); dep.run(7, 111, t(2), 0, 1); dep.run(7, 111, t(24 * 8), 50, 50);
  dep.run(8, 114, t(1), 1, 0);
  const d = salesDoc(db, now, 7, null);
  assert.equal(d.format, 'forever-sales');
  assert.deepEqual(d.houses[111], { hours: 2, items: { 7: 48 } }); // 4 units in 2 hours
  assert.deepEqual(d.houses[114], { hours: 0, items: {} });
  assert.equal(d.tsm, undefined); // no TSM file: written without it
  const tsm = tsmPart({ region: 'Forever-US', downloadTime: 5, items: new Map([[2589, { soldPerDay: 15997.6 }], [3, { soldPerDay: 0 }], [4, { soldPerDay: null }]]) });
  assert.deepEqual(tsm, { region: 'Forever-US', downloadTime: 5, items: { 2589: 15997.6 } });
  assert.deepEqual(salesDoc(db, now, 7, tsm).tsm, tsm);
});
