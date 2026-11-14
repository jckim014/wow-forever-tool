// Run with: node --test collector/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  readZip, summarizeUnits, summarizeHouse, snapshotDate, snapshotDayParts, updateAlerts, REMIND_MS, parseTokenExpiry,
} from './syncLib.mjs';

// Minimal zip writer for the tests (one stored and one deflated entry).
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data, deflate] of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('zip: stored and deflated entries', () => {
  const a = Buffer.from('{"x":1}');
  const b = Buffer.from('hello '.repeat(100));
  const files = readZip(makeZip([['manifest.json', a, false], ['house-111-auctions.json.gz', b, true]]));
  assert.deepEqual([...files.keys()], ['manifest.json', 'house-111-auctions.json.gz']);
  assert.deepEqual(files.get('manifest.json'), a);
  assert.deepEqual(files.get('house-111-auctions.json.gz'), b);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
});

test('summary: lowest, unit-weighted median, cheapest 15%, units, listings', () => {
  // 10 units at 100, 10 units at 200 (one stack), 1 unit at 1000
  const m = new Map([[5, [[200, 10], [100, 1], [100, 9], [1000, 1]]]]);
  assert.deepEqual(summarizeUnits(m), { 5: [100, 200, 100, 21, 4] }); // median: unit 11 of 21 is in the 200 stack
  // half-even rounding: 2.5 -> 2
  assert.deepEqual(summarizeUnits(new Map([[7, [[2.5, 1]]]])), { 7: [2, 2, 2, 1, 1] });
});

test('summary: an overpriced wall is left out of the cheapest 15%', () => {
  // Raw Longjaw Mud Snapper on Horde, 2026-11-14 (shortened): 100 at 10c, 50 at 15c, 900 at 22s.
  // Without the cutoff: 15% of 1,050 = 157.5 units, reaching into the wall (~5s 36c). Anchor = price at 5% of units
  // (52.5 units -> 10c), cutoff 5x = 50c, so only the 150 cheap units count: 15% = 22.5 units, all at 10c.
  const m = new Map([[1, [[10, 100], [15, 50], [2200, 900]]]]);
  assert.deepEqual(summarizeUnits(m)[1], [10, 2200, 10, 1050, 3]);
});

test('summary: one cheap bait unit does not set the cutoff', () => {
  // Stonescale Eel on Horde, 2026-11-14 (shortened): 1 at 21c, then 300 at 1s 64c and 100 at 2s.
  // Anchored on the lowest (21c x 5 = 1s 05c) everything real would go; the 5% anchor (1s 64c) keeps it all.
  const m = new Map([[1, [[21, 1], [164, 300], [200, 100]]]]);
  const [low, , c15] = summarizeUnits(m)[1];
  assert.equal(low, 21);
  assert.equal(c15, Math.round((21 + 59.15 * 164) / 60.15)); // 15% of 401 units
});

test('summary of a house: stack buyouts, unit prices, bid-only left out', () => {
  const s = summarizeHouse(
    { auctions: [
      { id: 1, item: { id: 10 }, buyout: 1000, quantity: 5, time_left: 'LONG' }, // 200 each
      { id: 2, item: { id: 10 }, bid: 50, quantity: 1, time_left: 'LONG' },
    ] },
    { auctions: [{ id: 3, item: { id: 20 }, unit_price: 7, quantity: 40, time_left: 'LONG' }] },
  );
  assert.deepEqual(s, { listings: 3, bidOnly: 1, items: { 10: [200, 200, 200, 5, 1], 20: [7, 7, 7, 40, 1] } });
  assert.deepEqual(summarizeHouse({}, null), { listings: 0, bidOnly: 0, items: {} });
});

test('snapshot ids', () => {
  assert.equal(snapshotDate('20261112T202239Z').toISOString(), '2026-11-12T20:22:39.000Z');
  assert.equal(snapshotDate('snapshot-x'), null);
  assert.deepEqual(snapshotDayParts('20261112T202239Z'), ['2026', '11', '12']);
});

test('alerts: start, quiet, remind, change, clear', () => {
  const t0 = 1_000_000;
  let r = updateAlerts({ stale: 'old data' }, {}, t0);
  assert.deepEqual(r.notify.map((n) => n.title), ['Auction sync: problem']);
  r = updateAlerts({ stale: 'old data' }, r.state, t0 + 3600e3);
  assert.equal(r.notify.length, 0);
  r = updateAlerts({ stale: 'old data' }, r.state, t0 + REMIND_MS);
  assert.deepEqual(r.notify.map((n) => n.title), ['Auction sync: still a problem (6 h)']);
  r = updateAlerts({ stale: 'older data' }, r.state, t0 + REMIND_MS + 60e3);
  assert.equal(r.notify.length, 1);
  r = updateAlerts({}, r.state, t0 + REMIND_MS + 120e3);
  assert.deepEqual(r.notify, [{ key: 'stale', title: 'Auction sync: fixed', message: 'Cleared: older data' }]);
  assert.deepEqual(r.state, {});
});

test('token expiry header', () => {
  assert.equal(parseTokenExpiry('2027-11-12 21:00:00 UTC'), Date.parse('2027-11-12T21:00:00Z'));
  assert.equal(parseTokenExpiry(null), null);
  assert.equal(parseTokenExpiry('garbage'), null);
});
