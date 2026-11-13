import test from 'node:test';
import assert from 'node:assert/strict';
import { indexListings, compareSnapshots, classify, newListingsByKey } from './departures.mjs';

const auc = (id, item, buyout, tl, quantity = 1) => ({ id, item: { id: item }, buyout, quantity, time_left: tl });
const com = (id, item, unit, qty, tl) => ({ id, item: { id: item }, unit_price: unit, quantity: qty, time_left: tl });

test('classify each kind of departure', () => {
  const prev = indexListings(
    { auctions: [auc(1, 100, 500, 'LONG'), auc(2, 100, 600, 'VERY_LONG'), auc(3, 200, 900, 'SHORT'), auc(4, 300, 700, 'LONG'), auc(9, 400, 50, 'LONG')] },
    { auctions: [com(5, 2589, 25, 200, 'LONG'), com(6, 2589, 30, 100, 'VERY_LONG')] },
  );
  const next = indexListings(
    // 1 gone (probable); 2 gone but item 100 x1 reappears cheaper (reposted); 3 gone with SHORT left (unclear);
    // 4 unchanged; 9 gone and a new item-400 listing appears *dearer* (still probable)
    { auctions: [auc(4, 300, 700, 'LONG'), auc(20, 100, 550, 'VERY_LONG'), auc(21, 400, 80, 'VERY_LONG')] },
    // 5 partly bought (certain 60); 6 gone with time left (probable 100)
    { auctions: [com(5, 2589, 25, 140, 'LONG')] },
  );
  const per = compareSnapshots(prev, next);
  assert.deepEqual(per.get(100), { certain: 0, probable: 1, reposted: 1, unclear: 0 });
  assert.deepEqual(per.get(200), { certain: 0, probable: 0, reposted: 0, unclear: 1 });
  assert.equal(per.has(300), false);
  assert.deepEqual(per.get(400), { certain: 0, probable: 1, reposted: 0, unclear: 0 });
  assert.deepEqual(per.get(2589), { certain: 60, probable: 100, reposted: 0, unclear: 0 });
  assert.deepEqual(classify(5, prev.get(5), next, newListingsByKey(prev, next)), { kind: 'certain', units: 60 });
});

test('one new cheaper listing explains only one vanished listing (v2)', () => {
  const prev = indexListings({ auctions: [auc(1, 50, 400, 'LONG'), auc(2, 50, 400, 'LONG'), auc(3, 50, 400, 'LONG')] }, null);
  const next = indexListings({ auctions: [auc(10, 50, 390, 'VERY_LONG')] }, null);
  assert.deepEqual(compareSnapshots(prev, next).get(50), { certain: 0, probable: 2, reposted: 1, unclear: 0 });
});

test('bid-only listings have no unit price and are never "reposted"', () => {
  const prev = indexListings({ auctions: [{ id: 1, item: { id: 7 }, bid: 10, quantity: 1, time_left: 'LONG' }] }, null);
  const next = indexListings({ auctions: [auc(2, 7, 5, 'LONG')] }, null);
  assert.deepEqual(compareSnapshots(prev, next).get(7), { certain: 0, probable: 1, reposted: 0, unclear: 0 });
});
