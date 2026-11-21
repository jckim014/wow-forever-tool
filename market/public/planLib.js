// Plan tab's pure logic (no DOM): a tree of wallets, groups and items, each with a weight = its % of its parent.
// Children of a node always add up to 100. Shared by the page (plan.js) and its tests (market/planLib.test.mjs).
//
// Node: { id, name, w, item?, note?, children? }   w = % of parent; item = item name for the price lookup
// (defaults to name); a node without children is a line you buy.

/** Every node with its parent, depth-first. */
export function walk(root, fn, parent = null, depth = 0) {
  for (const n of root.children ?? []) {
    fn(n, parent, depth);
    walk(n, fn, n, depth + 1);
  }
}

/** Makes every set of siblings add up to exactly 100 (equal shares when they are all 0). Changes the tree in place. */
export function normalize(node) {
  const kids = node.children ?? [];
  if (kids.length) {
    const sum = kids.reduce((s, k) => s + (Number(k.w) || 0), 0);
    for (const k of kids) k.w = sum > 0 ? ((Number(k.w) || 0) / sum) * 100 : 100 / kids.length;
    for (const k of kids) normalize(k);
  }
  return node;
}

/** Share of the whole budget (0-100) for every node id. */
export function wholeShares(root) {
  const out = new Map();
  const rec = (node, whole) => {
    for (const k of node.children ?? []) {
      const w = (whole * k.w) / 100;
      out.set(k.id, w);
      rec(k, w);
    }
  };
  rec(root, 100);
  return out;
}

export function find(root, id) {
  let hit = null, par = null;
  if (!id) return { node: null, parent: null };
  walk(root, (n, p) => { if (n.id === id) { hit = n; par = p ?? root; } });
  return { node: hit, parent: par };
}

const clamp = (v) => Math.min(100, Math.max(0, Number(v) || 0));

/**
 * Sets a node's % of its parent. The parent keeps its size: the siblings make room in proportion to their weights
 * (equally if they are all 0).
 */
export function setLocal(root, id, pct) {
  const { node, parent } = find(root, id);
  if (!node) return root;
  const v = clamp(pct);
  delete node.band; // a typed % is exact
  const sibs = parent.children.filter((k) => k !== node);
  const rest = sibs.reduce((s, k) => s + k.w, 0);
  node.w = sibs.length ? v : 100;
  for (const k of sibs) k.w = rest > 0 ? (k.w / rest) * (100 - node.w) : (100 - node.w) / sibs.length;
  return root;
}

/**
 * Sets a node's % of the whole budget. Its parents grow or shrink to fit; everything outside the node shrinks or
 * grows in proportion (so the rest keeps its own balance), and inside the node the split stays as it was.
 */
export function setWhole(root, id, pct) {
  const shares = wholeShares(root);
  if (!shares.has(id)) return root;
  const target = clamp(pct);
  const old = shares.get(id);
  if (Math.abs(target - old) < 1e-9) return root;
  // the node's ancestors (outermost first) and the node
  const chain = [];
  const findChain = (node, path) => {
    for (const k of node.children ?? []) {
      if (k.id === id) { chain.push(...path, k); return true; }
      if (findChain(k, [...path, k])) return true;
    }
    return false;
  };
  findChain(root, []);
  for (const n of chain) delete n.band; // their own % changes: they become exact (siblings keep their bands' ratios)
  // Walk down the path: at each level the path node and its siblings get new weights. Everything below a sibling
  // keeps its own split (its local weights don't change), and so does everything inside the target.
  const rest = 100 - old;
  if (rest < 1e-9) {
    // The node held the whole budget, so everything else is at 0: the innermost level with siblings shares the
    // freed part among them equally.
    let parent = root, level = -1;
    chain.forEach((n, i) => { if (parent.children.length > 1) level = i; parent = n; });
    if (level < 0) return root; // nothing else to give it to
    parent = level === 0 ? root : chain[level - 1];
    const n = chain[level];
    const sibs = parent.children.filter((k) => k !== n);
    n.w = target;
    for (const k of sibs) k.w = (100 - target) / sibs.length;
    return normalize(root);
  }
  const f = (100 - target) / rest; // everything outside the node scales by this
  let parent = root, parentNew = 100;
  for (const n of chain) {
    const nNew = n.id === id ? target : (shares.get(n.id) - old) * f + target;
    for (const k of parent.children) {
      if (k !== n) k.w = parentNew > 0 ? ((shares.get(k.id) * f) / parentNew) * 100 : 0;
    }
    n.w = parentNew > 0 ? (nNew / parentNew) * 100 : 0;
    parent = n;
    parentNew = nNew;
  }
  return normalize(root);
}

/** Sets a node's gold: the same as its % of the whole at this budget. */
export function setGold(root, id, gold, budget) {
  if (!(budget > 0)) return root;
  return setWhole(root, id, (Math.max(0, Number(gold) || 0) / budget) * 100);
}

/** Removes a node; its siblings fill its share in proportion. */
export function remove(root, id) {
  const { node, parent } = find(root, id);
  if (!node) return root;
  parent.children = parent.children.filter((k) => k !== node);
  if (!parent.children.length) delete parent.children;
  return normalize(root);
}

let seq = 0;
export const newId = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Adds a line (weight 0) under a node; a line that had no children becomes a group holding it. */
export function addChild(root, parentId, name) {
  const target = parentId ? find(root, parentId).node : root;
  if (!target) return root;
  const child = { id: newId(), name: String(name || 'New line').trim() || 'New line', w: 0 };
  if (!target.children?.length) { target.children = [child]; child.w = 100; return root; }
  // In a group whose lines all have bands, a new line comes in as Small and the group is re-split.
  const banded = target.children.every((k) => k.band);
  target.children.push(child);
  if (banded) { child.band = 'S'; rebalance(target); }
  return root;
}

// ---- Bands: a few sizes instead of precise %s (Josh, 2026-11-20). A band is a weight; within a group, exact lines
// (no band) keep their %, and banded lines share the rest in proportion to their band weights. ----
export const BANDS = { L: { label: 'Large', w: 4 }, M: { label: 'Medium', w: 2 }, S: { label: 'Small', w: 1 }, T: { label: 'Token', w: 0.5 } };

/** Re-splits a group's lines: exact lines keep their weight, banded lines share what's left by band weight. */
export function rebalance(group) {
  const kids = group.children ?? [];
  const banded = kids.filter((k) => BANDS[k.band]);
  if (!banded.length) return normalize(group);
  const exact = kids.filter((k) => !BANDS[k.band]);
  const fixed = Math.min(100, exact.reduce((s, k) => s + k.w, 0));
  const total = banded.reduce((s, k) => s + BANDS[k.band].w, 0);
  for (const k of banded) k.w = ((100 - fixed) * BANDS[k.band].w) / total;
  if (fixed >= 100 - 1e-9 && exact.length) {
    // exact lines already fill the group: give the banded lines room by scaling the exact ones down to 50%
    for (const k of exact) k.w = (k.w / fixed) * 50;
    for (const k of banded) k.w = (50 * BANDS[k.band].w) / total;
  }
  return group;
}

/** Sets a line's band (null = exact, keeping its current %) and re-splits its group. */
export function setBand(root, id, band) {
  const { node, parent } = find(root, id);
  if (!node) return root;
  if (band && BANDS[band]) node.band = band; else delete node.band;
  rebalance(parent);
  return normalize(root);
}

/** Re-splits every group that has banded lines (after loading or bulk changes). */
export function rebalanceAll(root) {
  rebalance(root);
  walk(root, (n) => { if (n.children?.length) rebalance(n); });
  return normalize(root);
}

/** Leaves (the lines you buy) with their whole share, in tree order. */
export function leaves(root) {
  const shares = wholeShares(root);
  const out = [];
  walk(root, (n) => { if (!n.children?.length) out.push({ node: n, whole: shares.get(n.id) }); });
  return out;
}

/** The empty plan's file shape (format forever-plan v1). */
export const PLAN_FORMAT = 'forever-plan';
export function validPlan(doc) {
  return !!doc && doc.format === PLAN_FORMAT && doc.version === 1 && Array.isArray(doc.tree?.children);
}

// Auctionator's own separators; a name containing them would break the list.
const cleanName = (s) => String(s).replace(/[\^;"\r\n]/g, ' ').trim();

/**
 * Auctionator shopping-list import for a group (or the whole plan when id is null): `List name^term^term`, each term
 * an exact-name search with a quantity (14 ";" fields, tier "#": the same format as the shuffle app's Shopping view,
 * app/src/shopping/list.ts). Quantity = units the line's gold buys at `priceOf(name)` (copper each), rounded down;
 * an item on several lines gets their sum. Lines without a price, or whose gold buys less than one, are skipped.
 */
export function shoppingList(root, id, budget, priceOf, listName) {
  const start = id ? find(root, id).node : root;
  const shares = wholeShares(root);
  const gold = new Map(); // item name -> gold
  const order = [];
  const skipped = [];
  const rec = (n) => {
    if (n.children?.length) { n.children.forEach(rec); return; }
    const name = n.item ?? n.name;
    if (!gold.has(name)) { gold.set(name, 0); order.push(name); }
    gold.set(name, gold.get(name) + ((Number(budget) || 0) * (shares.get(n.id) ?? 0)) / 100);
  };
  if (start) (start === root ? root.children ?? [] : [start]).forEach(rec);
  const terms = [];
  const items = [];
  for (const name of order) {
    const each = priceOf(name);
    const qty = each > 0 ? Math.floor((gold.get(name) * 10000) / each) : 0;
    if (qty < 1) { skipped.push(name); continue; }
    items.push({ name, qty });
    terms.push([`"${cleanName(name)}"`, '', '', '', '', '', '', '', '', '', '', '#', '', String(qty)].join(';'));
  }
  return { text: [cleanName(listName) || 'Plan', ...terms].join('^'), items, skipped };
}
