// Run with: node --test collector/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_HOUSES, checkHouseList, checkHouseData, checkShrink, checkStale, snapshotId,
  tokenUsable, encryptJson, decryptJson,
} from './lib.mjs';

test('house list: same houses pass, any change is named', () => {
  const ok = { auctions: EXPECTED_HOUSES.map((id) => ({ id })) };
  assert.equal(checkHouseList(ok), null);
  const changed = { auctions: [...EXPECTED_HOUSES.filter((id) => id !== 112), 126].map((id) => ({ id })) };
  assert.equal(checkHouseList(changed), 'house list changed: added [126], removed [112]');
  assert.match(checkHouseList({}), /no "auctions" array/);
});

test('house data: real shapes pass and are counted', () => {
  const auctions = { _links: {}, auctions: [
    { id: 1, item: { id: 2589 }, buyout: 500, quantity: 1, time_left: 'LONG' },
    { id: 2, item: { id: 2589, context: 1, bonus_lists: [1] }, bid: 300, quantity: 1, time_left: 'SHORT' },
    { id: 3, item: { id: 4306 }, buyout: 900, bid: 800, quantity: 1, time_left: 'MEDIUM' },
  ] };
  assert.deepEqual(checkHouseData(auctions, 'auctions'), { listings: 3, items: 2, errors: [], newFields: [] });
  const commodities = { _links: {}, auctions: [{ id: 9, item: { id: 2589 }, quantity: 20, unit_price: 25, time_left: 'LONG' }] };
  assert.deepEqual(checkHouseData(commodities, 'commodities'), { listings: 1, items: 1, errors: [], newFields: [] });
});

test('house data: an empty house has no auctions field', () => {
  assert.deepEqual(checkHouseData({ _links: {} }, 'auctions'), { listings: 0, items: 0, errors: [], newFields: [] });
});

test('house data: malformed listings are errors, new fields are notes', () => {
  const r = checkHouseData({ auctions: [
    { id: 1, item: { id: 5 }, quantity: 1, time_left: 'LONG' },
    { id: 2, item: { id: 5, shiny: true }, buyout: 1, quantity: 1, time_left: 'LONG', seller: 'x' },
  ], extra: 1 }, 'auctions');
  assert.equal(r.listings, 2);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /^1 of 2 listings are malformed, first: neither buyout nor bid/);
  assert.deepEqual(r.newFields, ['auction.item.shiny', 'auction.seller', 'extra']);
  assert.match(checkHouseData({ auctions: [{ id: 1, item: { id: 5 }, quantity: 3, time_left: 'LONG' }] }, 'commodities').errors[0], /no unit_price/);
  assert.deepEqual(checkHouseData([], 'auctions').errors, ['response is not a JSON object']);
});

test('shrink: only big houses that halve', () => {
  assert.equal(checkShrink(null, 0), null);
  assert.equal(checkShrink(4000, 0), null);
  assert.equal(checkShrink(80000, 40000), null);
  assert.equal(checkShrink(80000, 39999), 'shrank from 80000 to 39999 listings');
});

test('stale: newest time decides', () => {
  const now = Date.parse('2026-11-12T23:00:00Z');
  assert.equal(checkStale(['Thu, 12 Nov 2026 19:22:39 GMT', 'Thu, 12 Nov 2026 20:30:00 GMT'], now), null);
  assert.match(checkStale(['Thu, 12 Nov 2026 19:22:39 GMT'], now), /3\.6 h old/);
  assert.equal(checkStale([], now), 'no Last-Modified times known');
});

test('snapshot id from the newest time', () => {
  assert.equal(snapshotId(['Thu, 12 Nov 2026 19:22:32 GMT', 'Thu, 12 Nov 2026 19:22:39 GMT']), '20261112T192239Z');
});

test('token reuse until an hour before expiry', () => {
  const now = 1_000_000_000_000;
  assert.equal(tokenUsable({ accessToken: 'a', expiresAt: now + 2 * 3600e3 }, now), true);
  assert.equal(tokenUsable({ accessToken: 'a', expiresAt: now + 30 * 60e3 }, now), false);
  assert.equal(tokenUsable(null, now), false);
});

test('token cache: round trip, wrong key and garbage give null', () => {
  const box = encryptJson({ accessToken: 'secret-token', expiresAt: 5 }, 'key-1');
  assert.ok(!box.includes('secret-token'));
  assert.deepEqual(decryptJson(box, 'key-1'), { accessToken: 'secret-token', expiresAt: 5 });
  assert.equal(decryptJson(box, 'key-2'), null);
  assert.equal(decryptJson('not json', 'key-1'), null);
});
