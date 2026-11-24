import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemSteps, ledgerFacts, checkItem, holdingsFrom } from './holdings.mjs';

const K = 'Alliance:249391';
const reading = (t, account, places) => ({ t, account, items: places ? { [K]: places } : {} });
const check = (readings, accepted, notCounted) => checkItem(itemSteps(readings, notCounted).get(K), accepted);

test('itemSteps sums accounts; a first reading has no changes', () => {
  const s = itemSteps([
    reading(100, 'A', { 'Scarce Bavvb|pending': 3141 }),
    reading(200, 'B', { 'Jeder|bag': 10 }),
    reading(300, 'A', { 'Scarce Bavvb|mail': 400 }),
  ]).get(K);
  assert.deepEqual(s.map((p) => p.total), [3141, 3151, 410]);
  assert.deepEqual(s[0].changes, []);
  assert.deepEqual(s[2].changes, [{ account: 'A', char: 'Scarce Bavvb', pending: 3141, own: 400 }]);
});

test('100-mail limit: unopened mail cleared, only part shows in the mailbox -> the rest stays counted, flagged', () => {
  const r = check([
    reading(1, 'A', { 'Scarce Bavvb|pending': 3141 }),
    reading(5, 'A', { 'Scarce Bavvb|mail': 1200 }),
  ]);
  assert.equal(r.tsm, 1200);
  assert.equal(r.shown, 3141);
  assert.deepEqual(r.flag, { since: 5, lost: [{ char: 'Scarce Bavvb', units: 1941 }] });
});

test('the mails over the cap get opened later: the count comes back and the flag clears', () => {
  const r = check([
    reading(1, 'A', { 'Scarce Bavvb|pending': 3141 }),
    reading(5, 'A', { 'Scarce Bavvb|mail': 1200 }),
    reading(9, 'A', { 'Scarce Bavvb|bag': 3141 }),
  ]);
  assert.deepEqual(r, { tsm: 3141, shown: 3141, flag: null });
});

test('opened and moved to bags in one session is not a loss', () => {
  const r = check([
    reading(1, 'A', { 'Scarce Bavvb|pending': 500 }),
    reading(5, 'A', { 'Scarce Bavvb|bag': 300, 'Scarce Bavvb|bank': 200 }),
  ]);
  assert.deepEqual(r, { tsm: 500, shown: 500, flag: null });
});

test('crafting, selling or sending away lowers the count without a flag', () => {
  const r = check([reading(1, 'A', { 'X|bag': 186 }), reading(5, 'A', { 'X|bag': 77 })]);
  assert.deepEqual(r, { tsm: 77, shown: 77, flag: null });
});

test('Simone Sharpe is not counted: sent to her = gone, sent back = counted again', () => {
  const r = check([
    reading(1, 'A', { 'Desti Xria|bag': 100 }),
    reading(2, 'A', { 'Desti Xria|bag': 40, 'Simone Sharpe|pending': 60 }),
    reading(3, 'A', { 'Desti Xria|bag': 40, 'Simone Sharpe|bag': 60 }),
  ]);
  assert.deepEqual(r, { tsm: 40, shown: 40, flag: null });
  const back = check([
    reading(1, 'A', { 'Simone Sharpe|bag': 60 }),
    reading(2, 'A', { 'Simone Sharpe|bag': 20, 'Desti Xria|pending': 40 }),
    reading(3, 'A', { 'Simone Sharpe|bag': 20, 'Desti Xria|bag': 40 }),
  ]);
  assert.deepEqual(back, { tsm: 40, shown: 40, flag: null });
  // another list of characters not counted
  assert.equal(check([reading(1, 'A', { 'Simone Sharpe|bag': 60 })], undefined, []).tsm, 60);
});

test('a loss under 5 units is not flagged', () => {
  const r = check([reading(1, 'A', { 'X|pending': 10 }), reading(2, 'A', { 'X|mail': 6 })]);
  assert.deepEqual(r, { tsm: 6, shown: 6, flag: null });
});

test('"TSM is right" clears a flag; a new loss later flags again', () => {
  const rs = [reading(1, 'A', { 'X|pending': 100 }), reading(2, 'A', { 'X|mail': 20 })];
  assert.deepEqual(check(rs, { tsm: 20 }), { tsm: 20, shown: 20, flag: null });
  const r = check([...rs, reading(3, 'A', { 'X|mail': 20, 'X|pending': 50 }), reading(4, 'A', { 'X|mail': 30 })], { tsm: 20 });
  assert.equal(r.tsm, 30);
  assert.equal(r.shown, 70);
  assert.equal(r.flag.since, 4);
});

test('ledgerFacts: only ok purchases, per faction', () => {
  const f = ledgerFacts([
    { kind: 'buy', faction: 'Alliance', itemID: 249391, count: 100, price: 20000, status: 'ok', t: 1000 },
    { kind: 'buy', faction: 'Alliance', itemID: 249391, count: 50, price: 9999, status: 'noitem', t: 1100 },
    { kind: 'sale', faction: 'Alliance', itemID: 249391, count: 20, t: 2000 },
    { kind: 'visit', faction: 'Alliance', t0: 5 },
    { kind: 'buy', faction: 'Horde', itemID: 249391, count: 1, price: 1, status: 'ok', t: 1 },
  ]);
  assert.deepEqual(f.get(K), { bought: 100, paid: 20000 });
  assert.deepEqual(f.get('Horde:249391'), { bought: 1, paid: 1 });
});

test('holdingsFrom joins TSM, ledger and accepted counts', () => {
  const out = holdingsFrom(
    [reading(10, 'A', { 'X|bag': 60 })],
    ledgerFacts([{ kind: 'buy', faction: 'Alliance', itemID: 249391, count: 60, price: 162600, status: 'ok', t: 1 }]),
  );
  assert.deepEqual(out[K], { tsm: 60, shown: 60, flag: null, bought: 60, paid: 162600 });
});
