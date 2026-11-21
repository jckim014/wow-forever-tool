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
