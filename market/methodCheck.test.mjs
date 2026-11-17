import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { rawSnapshots } from '../collector/departuresUpdate.mjs';
import { classifiedPairs } from './methodCheck.mjs';

const H = 3600, DAY0 = Date.UTC(2026, 10, 17) / 1000;
const id = (h) => `20261117T${String(h).padStart(2, '0')}0000Z`;
function write(root, hour, listings) {
  const dir = path.join(root, 'raw', '2026', '11', '17', id(hour));
  fs.mkdirSync(dir, { recursive: true });
  const auctions = listings.map(([aid, item]) => ({ id: aid, item: { id: item }, buyout: 100, quantity: 1, time_left: 'LONG' }));
  for (const h of [111, 114]) fs.writeFileSync(path.join(dir, `house-${h}-auctions.json.gz`), zlib.gzipSync(JSON.stringify({ auctions })));
}
const buy = (item, hour) => ({ kind: 'buy', item, time: DAY0 + hour * H + 60, stack: 1, count: 1, price: 100 });
const plain = (pairs) => Object.fromEntries(Object.entries(pairs).map(([h, ps]) => [h, ps.map((p) => ({ ...p, prev: [...p.prev], kinds: [...p.kinds] }))]));

test('pairs are classified once, kept on disk, redone only when needed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcheck-'));
  try {
    write(root, 10, [[1, 500], [2, 600]]); write(root, 11, [[2, 600]]); write(root, 12, []);
    const snaps = rawSnapshots(root);
    let st = { read: 0, cached: 0 };
    const first = classifiedPairs(root, snaps, [buy(500, 10)], st);
    assert.deepEqual(st, { read: 4, cached: 0 }); // only the pair 10 -> 11 is needed (2 snapshots x 2 houses)
    assert.deepEqual([...first[111][0].kinds], [[1, { kind: 'probable', units: 1 }]]);
    assert.equal(first[111][1].prev.size, 0);

    st = { read: 0, cached: 0 };
    assert.deepEqual(plain(classifiedPairs(root, snaps, [buy(500, 10)], st)), plain(first));
    assert.deepEqual(st, { read: 0, cached: 2 }); // both houses from the cache

    // a record for a new item in the same pair: that pair is read again, keeping both items
    st = { read: 0, cached: 0 };
    const more = classifiedPairs(root, snaps, [buy(500, 10), buy(600, 10)], st);
    assert.equal(st.read, 4);
    assert.deepEqual([...more[111][0].kinds.keys()], [1, 2]);

    // a late snapshot splits a pair: the old file goes, the new pairs are read
    write(root, 9, [[1, 500]]);
    st = { read: 0, cached: 0 };
    const late = classifiedPairs(root, rawSnapshots(root), [buy(500, 9), buy(500, 10), buy(600, 10)], st);
    assert.equal(late[111].length, 3);
    assert.deepEqual(st, { read: 4, cached: 2 });
    assert.equal(fs.readdirSync(path.join(root, 'cache', 'method-check')).length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
