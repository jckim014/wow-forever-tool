// Plan tab: Josh's budget split into wallets, groups and items. Each row's % of parent and % of the whole are editable
// (planLib.js says what each edit does to the rest); the budget turns shares into gold; prices come from the latest
// snapshot. Saved to F:\ForeverAuctionData\plan.json through the server.
import { moneyHtml, iconHtml, HOUSES } from './shared.js';
import { normalize, wholeShares, setLocal, setWhole, remove, addChild, walk, validPlan, shoppingList, find, BANDS, setBand } from './planLib.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CLOSED_KEY = 'forever-market:plan-closed';

let doc = null;          // the plan file's content
let prices = {};         // item name -> { id, icon, quality, latest: { 111: {...}, 114: {...} } } | null
let closed = new Set((() => { try { return JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]'); } catch { return []; } })());
let saveState = '';      // '', 'saving', 'saved', or an error message
let saveTimer = null;
let loaded = false;
let planFile = 'the plan file';
let exported = null;     // the last Auctionator list made: { name, text, items, skipped, copied }

const lookupName = (n) => n.item ?? n.name;

export async function showPlan() {
  if (loaded) return refreshPrices();
  const box = $('#plan');
  box.innerHTML = '<p class="mempty">Loading the plan…</p>';
  try {
    const r = await (await fetch('/api/plan')).json();
    if (r.error) throw new Error(r.error);
    doc = validPlan(r.plan) ? r.plan : emptyPlan();
    if (r.file) planFile = r.file;
    normalize(doc.tree);
    loaded = true;
    render();
    await refreshPrices();
  } catch (e) {
    box.innerHTML = `<p class="mempty">Couldn't read the plan: ${esc(e.message)}</p>`;
  }
}

function emptyPlan() {
  const tree = { children: [{ id: 'w1', name: 'Wallet 1', w: 100 }] };
  return { format: 'forever-plan', version: 1, budget: 1000, house: 111, tree, initial: structuredClone(tree) };
}

async function refreshPrices() {
  const names = new Set();
  walk(doc.tree, (n) => { if (!n.children?.length) names.add(lookupName(n)); });
  const want = [...names].filter((n) => !(n in prices));
  if (!want.length) return;
  try {
    const r = await (await fetch(`/api/prices?names=${encodeURIComponent(want.join('|'))}`)).json();
    if (!r.error) Object.assign(prices, r);
  } catch { /* prices are extra; the plan works without them */ }
  render();
}

function save() {
  saveState = 'saving';
  renderStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      saveState = 'saved';
    } catch (e) {
      saveState = `Couldn't save: ${e.message}`;
    }
    renderStatus();
  }, 400);
}

function renderStatus() {
  const el = $('#p-save');
  if (!el) return;
  el.className = saveState && !['saving', 'saved'].includes(saveState) ? 'mwarn-text' : 'mfaint';
  el.textContent = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? `Saved to ${planFile}` : saveState;
}

const pct = (v) => (v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v > 0 ? v.toFixed(2) : '0');

function render() {
  const box = $('#plan');
  const shares = wholeShares(doc.tree);
  const budget = Number(doc.budget) || 0;
  const house = doc.house === 114 ? 114 : 111;
  const rows = [];
  const rec = (node, depth, parentId) => {
    for (const n of node.children ?? []) {
      rows.push({ n, depth, parentId });
      if (n.children?.length && !closed.has(n.id)) rec(n, depth + 1, n.id);
    }
  };
  rec(doc.tree, 0, null);
  const flags = [];
  // Gold per item across every line that buys it (Dreamfoil sits in two wallets): the "more than listed" check uses it.
  const itemGold = new Map();
  walk(doc.tree, (x) => {
    if (!x.children?.length) itemGold.set(lookupName(x), (itemGold.get(lookupName(x)) ?? 0) + (budget * (shares.get(x.id) ?? 0)) / 100);
  });
  const body = rows.map(({ n, depth }) => {
    const whole = shares.get(n.id) ?? 0;
    const gold = (budget * whole) / 100;
    const group = !!n.children?.length;
    const p = group ? null : prices[lookupName(n)];
    const l = p?.latest?.[house];
    const each = l?.cheapest15 ?? null;
    const units = each ? (gold * 10000) / each : null;
    const totalGold = itemGold.get(lookupName(n)) ?? gold;
    const totalUnits = each ? (totalGold * 10000) / each : null;
    const thin = totalUnits !== null && l && totalUnits > l.units;
    const shared = Math.abs(totalGold - gold) > 1e-6;
    if (thin && !flags.includes(n.name)) flags.push(n.name);
    const nameCell = `<td class="mleft pl-name" style="padding-left:${6 + depth * 22}px">
      ${group ? `<button class="pl-tog" data-tog="${n.id}" title="${closed.has(n.id) ? 'Open' : 'Close'}">${closed.has(n.id) ? '▸' : '▾'}</button>` : '<span class="pl-tog-sp"></span>'}
      ${group ? '' : p ? iconHtml(p.icon) : '<span class="micon-none"></span>'}<span class="${group ? 'pl-group' : `q${p?.quality ?? 1}`}" data-rename="${n.id}" title="Double-click to rename${n.item ? ` · priced as ${esc(n.item)}` : ''}">${esc(n.name)}</span>
      ${n.note ? `<span class="minfo" title="${esc(n.note)}">ⓘ</span>` : ''}</td>`;
    return `<tr class="pl-d${Math.min(depth, 3)}${group ? ' pl-grow' : ''}">
      ${nameCell}
      <td><select class="pl-band${n.band ? '' : ' pl-exact'}" data-band="${n.id}" title="Band: a size relative to the rest of this group. Exact = the % typed">${[['', 'Exact'], ...Object.entries(BANDS).map(([k, b]) => [k, b.label])].map(([k, l]) => `<option value="${k}"${(n.band ?? '') === k ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input class="pl-in" data-k="${n.id}:local" type="number" step="any" min="0" max="100" value="${pct(n.w)}"> %</td>
      <td><input class="pl-in" data-k="${n.id}:whole" type="number" step="any" min="0" max="100" value="${pct(whole)}"> %</td>
      <td>${moneyHtml(Math.round(gold * 100) * 100)}</td>
      <td>${group ? '' : each ? moneyHtml(each) : `<span class="blank" title="${p === null ? 'No AH item with this name' : 'Not listed in this faction right now'}">—</span>`}</td>
      <td>${units === null ? '' : `~${units >= 100 ? Math.round(units).toLocaleString() : units.toFixed(1)}`}</td>
      <td>${group || !l ? '' : l.units.toLocaleString()}</td>
      <td class="mleft">${thin ? `<span class="mflag" title="${shared ? `All lines of this item together (~${Math.round(totalUnits).toLocaleString()} units) buy` : 'The gold buys'} more than is listed right now">more than listed${shared ? ' (all lines)' : ''}</span>` : ''}</td>
      <td class="pl-act">${group ? `<button class="pl-btn pl-list" data-list="${n.id}" title="Auctionator shopping list of everything in ${esc(n.name)}">List</button>` : ''}<button class="pl-btn" data-add="${n.id}" title="Add a line inside">+</button><button class="pl-btn" data-del="${n.id}" title="Remove">×</button></td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="mfilters">
      <label class="field">Budget <input id="p-budget" class="pl-budget" type="number" step="any" min="0" value="${budget}"> g</label>
      <span class="field">Prices <span class="seg" id="p-house">
        ${HOUSES.map((h) => `<button data-v="${h.id}" class="${house === h.id ? 'on' : ''}">${h.label}</button>`).join('')}
      </span></span>
      <button id="p-open" class="mbtn2">Open all</button><button id="p-close" class="mbtn2">Close all</button>
      <button id="p-add" class="mbtn2">Add wallet</button>
      <button id="p-reset" class="mbtn2">Reset to starting weights</button>
      <button id="p-list-all" class="mbtn2" title="Auctionator shopping list of the whole plan">Shopping list (all)</button>
      <span id="p-save"></span>
    </div>
    ${exported ? `<div class="pl-export">
      <div><strong>Auctionator list "${esc(exported.name)}"</strong>: ${exported.items.length} item${exported.items.length === 1 ? '' : 's'}${exported.copied ? ', copied' : ''}.
        In game: Auctionator's Shopping tab, Import, paste. Importing a list with the same name replaces it.
        Quantities = units the gold buys at today's ${house === 114 ? 'Horde' : 'Alliance'} prices.
        ${exported.skipped.length ? `<br>Left out (no price, or the gold buys less than one): ${exported.skipped.map(esc).join(', ')}` : ''}</div>
      <textarea class="pl-export-text" readonly rows="2">${esc(exported.text)}</textarea>
      <div><button id="p-copy" class="mbtn2">Copy again</button> <button id="p-export-close" class="mbtn2">Close</button></div>
    </div>` : ''}
    <p class="mhint2">Band: Large 4, Medium 2, Small 1, Token ½. In a group, each banded line's share = its band / the total of the bands (after any exact lines);
      changing a band only moves weight inside that group. Typing a % makes that line exact.<br>
      % of parent: change it and the rest of that group makes room, nothing outside the group moves.
      % of whole: change it and the groups above it grow or shrink with it, while everything else shrinks or grows in proportion.
      Every group always adds up to 100%. Prices: cheapest 15% at the latest snapshot; "~" = units the gold buys at that price; Listed = units on the AH now.
      Double-click a name to rename it.</p>
    ${flags.length ? `<p class="mearly">More gold than the AH lists right now: ${flags.map(esc).join(', ')}. Buying them out would push the price up; spread the buying over time or lower their share.</p>` : ''}
    <div class="mfaction">
      <table class="mtable mft pl-table">
        <tr><th class="mleft">Wallet / item</th><th class="mleft">Band</th><th>% of parent</th><th>% of whole</th><th>Gold</th><th>Price each</th><th>Buys</th><th>Listed</th><th></th><th></th></tr>
        ${body}
        <tr class="pl-total"><td class="mleft">Total</td><td></td><td></td><td>100 %</td><td>${moneyHtml(budget * 10000)}</td><td colspan="5"></td></tr>
      </table>
    </div>`;
  renderStatus();
  wire();
}

function changed() { save(); render(); }

function wire() {
  const box = $('#plan');
  $('#p-budget').addEventListener('change', (e) => { doc.budget = Math.max(0, Number(e.target.value) || 0); changed(); });
  $('#p-house').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { doc.house = Number(b.dataset.v); changed(); } });
  $('#p-open').addEventListener('click', () => { closed.clear(); keepClosed(); render(); });
  $('#p-close').addEventListener('click', () => { walk(doc.tree, (n) => { if (n.children?.length) closed.add(n.id); }); keepClosed(); render(); });
  $('#p-add').addEventListener('click', () => {
    const name = prompt('Name of the new wallet:');
    if (name) { addChild(doc.tree, null, name); changed(); }
  });
  $('#p-reset').addEventListener('click', () => {
    if (!doc.initial || !confirm('Go back to the starting weights? Your changes to the weights, names and lines are replaced (the budget stays).')) return;
    doc.tree = structuredClone(doc.initial);
    normalize(doc.tree);
    prices = {};
    changed();
    refreshPrices();
  });
  $('#p-list-all').addEventListener('click', () => makeList(null));
  $('#p-copy')?.addEventListener('click', () => copyList());
  $('#p-export-close')?.addEventListener('click', () => { exported = null; render(); });
  box.querySelector('.pl-table').addEventListener('change', (e) => {
    if (e.target.dataset.band) { setBand(doc.tree, e.target.dataset.band, e.target.value || null); changed(); return; }
    const k = e.target.dataset.k;
    if (!k) return;
    const next = document.activeElement?.dataset?.k; // Tab moved focus: put it back after redrawing
    const [id, field] = k.split(':');
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) { render(); return; }
    if (field === 'local') setLocal(doc.tree, id, v);
    else setWhole(doc.tree, id, v);
    changed();
    const el = next && box.querySelector(`[data-k="${next}"]`);
    if (el) { el.focus(); el.select?.(); }
  });
  box.querySelector('.pl-table').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.k) e.target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  box.querySelector('.pl-table').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tog],[data-add],[data-del],[data-list]');
    if (!t) return;
    if (t.dataset.list) {
      makeList(t.dataset.list);
    } else if (t.dataset.tog) {
      const id = t.dataset.tog;
      closed.has(id) ? closed.delete(id) : closed.add(id);
      keepClosed();
      render();
    } else if (t.dataset.add) {
      const name = prompt('Name of the new line (an item name gets its price):');
      if (!name) return;
      addChild(doc.tree, t.dataset.add, name);
      closed.delete(t.dataset.add);
      changed();
      refreshPrices();
    } else if (t.dataset.del) {
      let n = null;
      walk(doc.tree, (x) => { if (x.id === t.dataset.del) n = x; });
      if (n && confirm(`Remove "${n.name}"${n.children?.length ? ' and everything in it' : ''}? The rest of its group fills its share.`)) {
        remove(doc.tree, n.id);
        changed();
      }
    }
  });
  box.querySelector('.pl-table').addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-rename]');
    if (!t) return;
    let n = null;
    walk(doc.tree, (x) => { if (x.id === t.dataset.rename) n = x; });
    const name = n && prompt('New name:', n.name);
    if (name && name.trim()) {
      if (!n.children?.length && !n.item && name.trim() !== n.name) n.item = undefined;
      n.name = name.trim();
      changed();
      refreshPrices();
    }
  });
}

/** Builds the Auctionator list for a group (null = the whole plan), shows it above the table and copies it. */
async function makeList(id) {
  const house = doc.house === 114 ? 114 : 111;
  const node = id ? find(doc.tree, id).node : null;
  const name = node ? `Plan: ${node.name}` : 'Plan';
  const priceOf = (itemName) => prices[itemName]?.latest?.[house]?.cheapest15 ?? null;
  exported = { name, ...shoppingList(doc.tree, id, Number(doc.budget) || 0, priceOf, name), copied: false };
  await copyList();
}

async function copyList() {
  if (!exported) return;
  try { await navigator.clipboard.writeText(exported.text); exported.copied = true; } catch { exported.copied = false; }
  render();
  if (!exported.copied) $('.pl-export-text')?.select(); // copy by hand (Ctrl+C) if the browser refused
}

function keepClosed() { try { localStorage.setItem(CLOSED_KEY, JSON.stringify([...closed])); } catch { /* per browser */ } }
