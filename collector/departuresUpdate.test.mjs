import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb } from './marketDb.mjs';
import { lateRedoFrom, updateDepartures } from './departuresUpdate.mjs';

const H = 3600;

test('lateRedoFrom finds the pair that spans a late snapshot', () => {
  const pairs = [{ prev_t: 0, t: H }, { prev_t: H, t: 3 * H }, { prev_t: 3 * H, t: 4 * H }];
  const snaps = [0, H, 2 * H, 3 * H, 4 * H].map((t) => ({ t }));
  assert.equal(lateRedoFrom(pairs, snaps, () => true), H);
  // a folder without this house's files is crossed on purpose, not late
  assert.equal(lateRedoFrom(pairs, snaps, (s) => s.t !== 2 * H), null);
  // nothing missing, nothing stored, or a snapshot outside the stored range
  assert.equal(lateRedoFrom(pairs, snaps.filter((s) => s.t !== 2 * H), () => true), null);
  assert.equal(lateRedoFrom([], snaps, () => true), null);
  assert.equal(lateRedoFrom(pairs, [...snaps, { t: 5 * H }, { t: -H }], (s) => s.t !== 2 * H), null);
});

// Josh's 2026-11-17 case: the 11:17 snapshot failed to download and was stored an hour after later ones.
test('a snapshot stored late is compared after all (was left as a gap)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-late-'));
  const write = (hour, units) => {
    const dir = path.join(root, 'raw', '2026', '11', '17', `20261117T${String(hour).padStart(2, '0')}1700Z`);
    fs.mkdirSync(dir, { recursive: true });
    const commodities = { auctions: [{ id: 1, item: { id: 2589 }, unit_price: 25, quantity: units, time_left: 'LONG' }] };
    for (const h of [111, 114]) fs.writeFileSync(path.join(dir, `house-${h}-commodities.json.gz`), zlib.gzipSync(JSON.stringify(commodities)));
  };
  const db = openDb(path.join(root, 'market.db'));
  try {
    write(10, 200); write(12, 100); write(13, 90);
    const first = updateDepartures(db, root);
    assert.equal(first.skipped, 2); // 10:17 -> 12:17 too far apart, per house
    write(11, 150); // arrives late
    const second = updateDepartures(db, root);
    assert.equal(second.redone, 4); // 12:17 and 13:17 pairs, both houses
    assert.equal(second.skipped, 0);
    const rows = db.prepare('SELECT t, certain FROM departures WHERE house = 111 ORDER BY t').all().map((r) => [r.t % 86400 / H | 0, r.certain]);
    assert.deepEqual(rows, [[11, 50], [12, 50], [13, 10]]);
    const pairs = db.prepare('SELECT count(*) n, sum(skipped) s FROM departure_pairs').get();
    assert.deepEqual([pairs.n, pairs.s], [6, 0]);
    assert.equal(updateDepartures(db, root).redone, 0); // settles
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
