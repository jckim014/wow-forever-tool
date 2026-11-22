import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, wholeShares, setLocal, setWhole, setGold, remove, addChild, leaves, validPlan } from './public/planLib.js';

// Small plan: Core 60 (Lotus 50: Black 60 / Death 40; Herbs 50: Dreamfoil 100), Misc 40 (E'kos 100: W 50 / F 50)
const plan = () => normalize({
  children: [
    { id: 'core', name: 'Core', w: 60, children: [
      { id: 'lotus', name: 'Lotus', w: 50, children: [{ id: 'bl', name: 'Black Lotus', w: 60 }, { id: 'dl', name: 'Death Lotus', w: 40 }] },
      { id: 'herbs', name: 'Herbs', w: 50, children: [{ id: 'df', name: 'Dreamfoil', w: 100 }] },
    ] },
    { id: 'misc', name: 'Misc', w: 40, children: [{ id: 'eko', name: "E'kos", w: 100, children: [{ id: 'w', name: 'Winterfall', w: 50 }, { id: 'f', name: 'Frostmaul', w: 50 }] }] },
  ],
});
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const sumsTo100 = (node) => {
  if (!node.children?.length) return;
  near(node.children.reduce((s, k) => s + k.w, 0), 100, `children of ${node.name ?? 'root'}`);
  node.children.forEach(sumsTo100);
};

test('whole shares multiply down the tree', () => {
  const s = wholeShares(plan());
  near(s.get('core'), 60, 'core'); near(s.get('lotus'), 30, 'lotus'); near(s.get('bl'), 18, 'bl'); near(s.get('dl'), 12, 'dl');
  near(s.get('df'), 30, 'df'); near(s.get('w'), 20, 'w');
});

test('normalize scales siblings to 100 and splits all-zero siblings equally', () => {
  const r = normalize({ children: [{ id: 'a', w: 2 }, { id: 'b', w: 6 }, { id: 'c', w: 0, children: [{ id: 'x', w: 0 }, { id: 'y', w: 0 }] }] });
  near(r.children[0].w, 25, 'a'); near(r.children[1].w, 75, 'b'); near(r.children[2].children[0].w, 50, 'x');
});

test('setLocal: the parent keeps its size, siblings make room in proportion', () => {
  const r = setLocal(plan(), 'bl', 80);
  const s = wholeShares(r);
  near(s.get('lotus'), 30, 'lotus unchanged'); near(s.get('bl'), 24, 'bl'); near(s.get('dl'), 6, 'dl');
  near(s.get('df'), 30, 'outside unchanged'); sumsTo100(r);
});

test('setLocal with three siblings keeps the others in proportion', () => {
  const r = normalize({ children: [{ id: 'a', w: 50 }, { id: 'b', w: 30 }, { id: 'c', w: 20 }] });
  setLocal(r, 'a', 0);
  near(r.children[1].w, 60, 'b'); near(r.children[2].w, 40, 'c');
});

test('setWhole: parents grow, everything outside shrinks in proportion, inside keeps its split', () => {
  const r = setWhole(plan(), 'bl', 28); // from 18 to 28: outside (82 -> 72) scales by 72/82
  const s = wholeShares(r);
  const f = 72 / 82;
  near(s.get('bl'), 28, 'bl');
  near(s.get('dl'), 12 * f, 'dl'); near(s.get('df'), 30 * f, 'df'); near(s.get('w'), 20 * f, 'w'); near(s.get('f'), 20 * f, 'f');
  near(s.get('lotus'), 28 + 12 * f, 'lotus'); near(s.get('core'), 28 + 42 * f, 'core'); near(s.get('misc'), 40 * f, 'misc');
  sumsTo100(r);
});

test('setWhole on a group keeps the split inside it', () => {
  const r = setWhole(plan(), 'lotus', 50);
  const s = wholeShares(r);
  near(s.get('lotus'), 50, 'lotus'); near(s.get('bl') / s.get('dl'), 1.5, 'bl:dl stays 60:40');
  near(s.get('df'), 30 * (50 / 70), 'df'); sumsTo100(r);
});

test('setWhole to 0 and back from 100', () => {
  const r = setWhole(plan(), 'misc', 0);
  near(wholeShares(r).get('core'), 100, 'core takes all');
  setWhole(r, 'core', 100);
  setWhole(r, 'core', 70); // core held everything: misc gets the 30 back
  const s = wholeShares(r);
  near(s.get('core'), 70, 'core'); near(s.get('misc'), 30, 'misc'); near(s.get('w') / s.get('f'), 1, 'split inside misc survives');
  sumsTo100(r);
});

test('setWhole on a node that holds everything, deep down', () => {
  const r = setWhole(plan(), 'bl', 100);
  near(wholeShares(r).get('bl'), 100, 'bl all');
  setWhole(r, 'bl', 40);
  const s = wholeShares(r);
  near(s.get('bl'), 40, 'bl'); near(s.get('dl'), 60, 'its sibling gets the rest'); sumsTo100(r);
});

test('setGold = setWhole at the budget', () => {
  const r = setGold(plan(), 'df', 500, 1000);
  near(wholeShares(r).get('df'), 50, 'df');
});

test('remove: siblings fill the share; addChild adds a 0 line, or a 100 line under a leaf', () => {
  const r = remove(plan(), 'dl');
  near(wholeShares(r).get('bl'), 30, 'bl takes lotus');
  addChild(r, 'herbs', 'Icecap');
  near(wholeShares(r).get('df'), 30, 'df unchanged');
  const ice = r.children[0].children[1].children[1];
  assert.equal(ice.name, 'Icecap'); near(ice.w, 0, 'new line at 0');
  addChild(r, 'bl', 'Inner');
  near(r.children[0].children[0].children[0].children[0].w, 100, 'a leaf becomes a group of one');
  assert.equal(leaves(r).length, 5);
  sumsTo100(r);
});

test('validPlan', () => {
  assert.ok(validPlan({ format: 'forever-plan', version: 1, tree: { children: [] } }));
  assert.ok(!validPlan({ format: 'x', version: 1, tree: { children: [] } }));
  assert.ok(!validPlan(null));
});

import { shoppingList } from './public/planLib.js';
test('shoppingList: units the gold buys per item, merged across lines, Auctionator format', () => {
  const r = normalize({ children: [
    { id: 'a', name: 'Core', w: 50, children: [{ id: 'df1', name: 'Dreamfoil', w: 50 }, { id: 'bl', name: 'Black Lotus', w: 50 }] },
    { id: 'b', name: 'NP', w: 50, children: [{ id: 'df2', name: 'Dreamfoil', w: 50 }, { id: 'np', name: 'Lesser NP', item: 'Nature Protection Potion', w: 25 }, { id: 'x', name: 'Placeholder', w: 25 }] },
  ] });
  const price = { 'Dreamfoil': 1300, 'Black Lotus': 90000, 'Nature Protection Potion': 300 }; // copper
  const all = shoppingList(r, null, 100, (n) => price[n] ?? null, 'Plan');
  // budget 100g: Dreamfoil 25g + 25g = 50g -> 384 at 13s; Black Lotus 25g -> 2 at 9g; NP potion 12.5g -> 416 at 3s
  assert.equal(all.text, 'Plan^"Dreamfoil";;;;;;;;;;;#;;384^"Black Lotus";;;;;;;;;;;#;;2^"Nature Protection Potion";;;;;;;;;;;#;;416');
  assert.deepEqual(all.skipped, ['Placeholder']);
  const np = shoppingList(r, 'b', 100, (n) => price[n] ?? null, 'Plan: NP');
  assert.equal(np.text, 'Plan: NP^"Dreamfoil";;;;;;;;;;;#;;192^"Nature Protection Potion";;;;;;;;;;;#;;416');
  const one = shoppingList(r, 'bl', 1, (n) => price[n] ?? null, 'x'); // 0.25g buys no Black Lotus
  assert.deepEqual(one.items, []); assert.deepEqual(one.skipped, ['Black Lotus']);
});

import { setBand, rebalance, rebalanceAll, BANDS } from './public/planLib.js';
const banded = () => normalize({ children: [
  { id: 'g', name: 'Shared', w: 60, children: [
    { id: 'df', name: 'Dreamfoil', w: 1, band: 'L' }, { id: 'gr', name: 'Gromsblood', w: 1, band: 'M' },
    { id: 'si', name: 'Silversage', w: 1, band: 'M' }, { id: 'ic', name: 'Icecap', w: 1, band: 'S' }] },
  { id: 'o', name: 'Other', w: 40 },
] });

test('bands: share = band weight / total of the group', () => {
  const r = rebalanceAll(banded());
  const g = r.children[0].children;
  near(g[0].w, 400 / 9, 'df 4/9'); near(g[1].w, 200 / 9, 'gr 2/9'); near(g[3].w, 100 / 9, 'ic 1/9');
  near(r.children[0].w, 60, 'group size unchanged');
});

test('setBand: raising one line takes from its siblings only', () => {
  const r = rebalanceAll(banded());
  setBand(r, 'gr', 'L'); // 4 4 2 1 = 11
  const g = r.children[0].children;
  near(g[0].w, 400 / 11, 'df'); near(g[1].w, 400 / 11, 'gr'); near(g[2].w, 200 / 11, 'si'); near(g[3].w, 100 / 11, 'ic');
  near(wholeShares(r).get('o'), 40, 'other group untouched');
});

test('a typed % makes a line exact; the banded rest share what is left by band', () => {
  const r = rebalanceAll(banded());
  setLocal(r, 'ic', 25);
  const g = r.children[0].children;
  assert.equal(g[3].band, undefined);
  near(g[3].w, 25, 'icecap exact 25');
  setBand(r, 'si', 'S'); // banded: 4 2 1 = 7 share 75
  near(g[0].w, 75 * 4 / 7, 'df'); near(g[2].w, 75 / 7, 'si'); near(g[3].w, 25, 'icecap stays');
});

test('setWhole makes the path exact but keeps the siblings banded', () => {
  const r = rebalanceAll(banded());
  setWhole(r, 'df', 40);
  assert.equal(r.children[0].children[0].band, undefined);
  assert.equal(r.children[0].children[1].band, 'M');
  near(r.children[0].children[1].w / r.children[0].children[3].w, 2, 'M:S ratio kept');
});

test('adding a line to an all-banded group brings it in as Small', () => {
  const r = rebalanceAll(banded());
  addChild(r, 'g', 'Golden Sansam'); // 4 2 2 1 1 = 10
  const g = r.children[0].children;
  assert.equal(g[4].band, 'S');
  near(g[0].w, 40, 'df'); near(g[4].w, 10, 'sansam');
});

test('setBand(null) keeps the current % as exact', () => {
  const r = rebalanceAll(banded());
  setBand(r, 'df', null);
  near(r.children[0].children[0].w, 400 / 9, 'df kept');
  assert.ok(BANDS.L.w === 4);
  void rebalance;
});

test('setLocal with rows already set: the change comes out of the untouched ones', () => {
  const r = normalize({ children: [{ id: 'c', w: 60.2 }, { id: 'n', w: 15.7 }, { id: 'm', w: 12.9 }, { id: 'x', w: 11.2 }] });
  const keep = new Set();
  const edit = (id, v) => { setLocal(r, id, v, keep); keep.add(id); };
  edit('c', 55); edit('n', 20); edit('m', 15);
  const w = Object.fromEntries(r.children.map((k) => [k.id, k.w]));
  near(w.c, 55, 'core'); near(w.n, 20, 'np'); near(w.m, 15, 'misc'); near(w.x, 10, 'last one gets the rest');
  edit('x', 12); // every other row is set: all make room in proportion
  near(r.children.reduce((s, k) => s + k.w, 0), 100, 'sum'); near(r.children[3].w, 12, 'x');
  near(r.children[0].w / r.children[1].w, 55 / 20, 'proportional among the set ones');
});

test('setLocal: kept rows plus the new value over 100 falls back to proportional', () => {
  const r = normalize({ children: [{ id: 'a', w: 50 }, { id: 'b', w: 40 }, { id: 'c', w: 10 }] });
  setLocal(r, 'c', 30, new Set(['a', 'b'])); // a + b = 90, + 30 > 100; and nothing is free anyway
  near(r.children[2].w, 30, 'c'); near(r.children[0].w / r.children[1].w, 50 / 40, 'a:b kept');
  const r2 = normalize({ children: [{ id: 'a', w: 70 }, { id: 'b', w: 20 }, { id: 'c', w: 10 }] });
  setLocal(r2, 'b', 40, new Set(['a'])); // 70 + 40 > 100: everyone moves
  near(r2.children[1].w, 40, 'b'); near(r2.children[0].w / r2.children[2].w, 7, 'a:c kept');
});

import { toV2, newPlan } from './public/planLib.js';
test('plan file v1 -> v2, and v2 validation', () => {
  const v1 = { format: 'forever-plan', version: 1, budget: 500, house: 111, tree: { children: [{ id: 'a', name: 'A', w: 100 }] }, initial: { children: [] } };
  const v2 = toV2(v1);
  assert.equal(v2.version, 2); assert.equal(v2.plans.length, 1);
  assert.equal(v2.plans[0].name, 'Raid consumables'); assert.equal(v2.plans[0].budget, 500); assert.equal(v2.plans[0].tree, v1.tree);
  assert.ok(validPlan(v2));
  assert.equal(toV2(v2), v2);
  const p = newPlan('Pre-BiS mats');
  assert.equal(p.tree.children.length, 1); near(p.tree.children[0].w, 100, 'one wallet');
  assert.ok(validPlan({ ...v2, plans: [...v2.plans, p] }));
  assert.ok(!validPlan({ format: 'forever-plan', version: 2, plans: [{ name: 'no id', tree: { children: [] } }] }));
});

test('movePlan puts a plan before or after another', async () => {
  const { movePlan } = await import('./public/planLib.js');
  const ps = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const ids = (x) => x.map((p) => p.id).join('');
  assert.equal(ids(movePlan(ps, 'd', 'a')), 'dabc');
  assert.equal(ids(movePlan(ps, 'a', 'c', true)), 'bcad');
  assert.equal(ids(movePlan(ps, 'a', 'c')), 'bacd');
  assert.equal(ids(movePlan(ps, 'b', 'c', true)), 'acbd');
  assert.equal(movePlan(ps, 'a', 'b'), ps);            // already there
  assert.equal(movePlan(ps, 'b', 'a', true), ps);
  assert.equal(movePlan(ps, 'c', 'b', true), ps);
  assert.equal(movePlan(ps, 'a', 'a'), ps);
  assert.equal(movePlan(ps, 'x', 'a'), ps);
  assert.equal(ids(ps), 'abcd');                       // input untouched
});
