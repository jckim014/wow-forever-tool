// Plan tab: Josh's budgets, each split into wallets, groups and items. Several plans sit on the page one under another,
// each with its own budget, faction, tree, bands, shopping lists and starting weights. Each row's % of parent and
// % of the whole are editable (planLib.js says what each edit does to the rest); the budget turns shares into gold;
// prices come from the latest snapshot. Saved to F:\ForeverAuctionData\plan.json through the server.
import { moneyHtml, iconHtml, HOUSES } from './shared.js';
import {
  normalize, wholeShares, setLocal, setWhole, remove, addChild, walk, validPlan, shoppingList, find, BANDS, setBand,
  toV2, newPlan, movePlan,
} from './planLib.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CLOSED_KEY = 'forever-market:plan-closed';          // groups closed (node ids)
const PLANS_CLOSED_KEY = 'forever-market:plan-sections-closed'; // plans collapsed (plan ids)
const readSet = (k) => new Set((() => { try { return JSON.parse(localStorage.getItem(k) ?? '[]'); } catch { return []; } })());
const keepSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch { /* per browser */ } };

let doc = null;          // the plan file's content (v2: { plans: [...] })
let prices = {};         // item name -> { id, icon, quality, latest: { 111: {...}, 114: {...} } } | null
const closed = readSet(CLOSED_KEY);
const closedPlans = readSet(PLANS_CLOSED_KEY);
let saveState = '';      // '', 'saving', 'saved', or an error message
let saveTimer = null;
let loaded = false;
let planFile = 'the plan file';
const setRows = new Set(); // rows whose % of parent was typed since the page loaded: later edits in their group leave them alone
let exported = null;     // the last Auctionator list made: { planId, name, text, items, skipped, copied }

const lookupName = (n) => n.item ?? n.name;
const planById = (id) => doc.plans.find((p) => p.id === id);
const houseOf = (p) => (p.house === 114 ? 114 : 111);

export async function showPlan() {
  if (loaded) return refreshPrices();
  const box = $('#plan');
  box.innerHTML = '<p class="mempty">Loading the plan…</p>';
  try {
    const r = await (await fetch('/api/plan')).json();
    if (r.error) throw new Error(r.error);
    doc = validPlan(r.plan) ? toV2(r.plan) : { format: 'forever-plan', version: 2, plans: [newPlan('Plan 1')] };
    if (r.file) planFile = r.file;
    for (const p of doc.plans) normalize(p.tree);
    loaded = true;
    wire(box);
    render();
    await refreshPrices();
  } catch (e) {
    box.innerHTML = `<p class="mempty">Couldn't read the plan: ${esc(e.message)}</p>`;
  }
}

async function refreshPrices() {
  const names = new Set();
  for (const p of doc.plans) walk(p.tree, (n) => { if (!n.children?.length) names.add(lookupName(n)); });
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
    saveTimer = null;
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

// A save still waiting when the page closes or reloads goes out at once (sendBeacon survives the page going away).
addEventListener('pagehide', () => {
  if (!saveTimer || saveState !== 'saving' || !doc) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  navigator.sendBeacon('/api/plan', new Blob([JSON.stringify(doc)], { type: 'application/json' }));
});

function renderStatus() {
  const el = $('#p-save');
  if (!el) return;
  el.className = saveState && !['saving', 'saved'].includes(saveState) ? 'mwarn-text' : 'mfaint';
  el.textContent = saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? `Saved to ${planFile}` : saveState;
}

const pct = (v) => (v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v > 0 ? v.toFixed(2) : '0');

function render() {
  const total = doc.plans.reduce((s, p) => s + (Number(p.budget) || 0), 0);
  $('#plan').innerHTML = `
    <div class="mfilters">
      <button class="mbtn2" data-act="new-plan">New plan</button>
      <span class="field">All plans: <strong>${moneyHtml(total * 10000)}</strong></span>
      <span id="p-save"></span>
    </div>
    <p class="mhint2">Band: Large 4, Medium 2, Small 1, Token ½. In a group, each banded line's share = its band / the total of the bands (after any exact lines);
      changing a band only moves weight inside that group. Typing a % makes that line exact.<br>
      % of parent: change it and the rest of that group makes room, nothing outside the group moves; rows you have already typed stay as they are
      (until you reload the page), so you can type a group's numbers one after another.
      % of whole: change it and the groups above it grow or shrink with it, while everything else shrinks or grows in proportion.
      Every group always adds up to 100%. Prices: cheapest 15% at the latest snapshot; "~" = units the gold buys at that price; Listed = units on the AH now.
      ✎ (or double-click a name) renames a line. Click a plan's name to fold it away; drag its ⠿ to move it.</p>
    ${doc.plans.length ? doc.plans.map(planHtml).join('') : '<p class="mempty">No plans yet: click New plan.</p>'}`;
  renderStatus();
}

function planHtml(plan) {
  const shares = wholeShares(plan.tree);
  const budget = Number(plan.budget) || 0;
  const house = houseOf(plan);
  const open = !closedPlans.has(plan.id);
  const head = `<div class="pl-head">
      ${doc.plans.length > 1 ? '<span class="pl-grip" draggable="true" title="Drag to move this plan up or down">⠿</span>' : ''}
      <button class="pl-ptog" data-act="toggle-plan" title="${open ? 'Fold away' : 'Open'}">${open ? '▾' : '▸'} <span class="pl-pname">${esc(plan.name)}</span></button>
      <span class="pl-psum">${moneyHtml(budget * 10000)} · ${house === 114 ? 'Horde' : 'Alliance'}</span>
      <button class="mbtn2" data-act="rename-plan">Rename</button><button class="mbtn2" data-act="delete-plan">Delete</button>
    </div>`;
  if (!open) return `<section class="pl-plan" data-plan="${plan.id}">${head}</section>`;
  const rows = [];
  const rec = (node, depth) => {
    for (const n of node.children ?? []) {
      rows.push({ n, depth });
      if (n.children?.length && !closed.has(n.id)) rec(n, depth + 1);
    }
  };
  rec(plan.tree, 0);
  const flags = [];
  // Gold per item across every line of this plan that buys it (Dreamfoil sits in two wallets): "more than listed" uses
  // it. Each plan is checked on its own (Josh, 2026-11-21).
  const itemGold = new Map();
  walk(plan.tree, (x) => {
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
      <td><select class="pl-band${n.band ? '' : ' pl-exact'}" data-band="${n.id}" title="Band: a size relative to the rest of this group. Exact = the % typed">${[['', 'Exact'], ...Object.entries(BANDS).map(([k, b]) => [k, b.label])].map(([k, lb]) => `<option value="${k}"${(n.band ?? '') === k ? ' selected' : ''}>${lb}</option>`).join('')}</select></td>
      <td><input class="pl-in" data-k="${n.id}:local" type="number" step="any" min="0" max="100" value="${pct(n.w)}"> %</td>
      <td><input class="pl-in" data-k="${n.id}:whole" type="number" step="any" min="0" max="100" value="${pct(whole)}"> %</td>
      <td>${moneyHtml(Math.round(gold * 100) * 100)}</td>
      <td>${group ? '' : each ? moneyHtml(each) : `<span class="blank" title="${p === null ? 'No AH item with this name' : 'Not listed in this faction right now'}">—</span>`}</td>
      <td>${units === null ? '' : `~${units >= 100 ? Math.round(units).toLocaleString() : units.toFixed(1)}`}</td>
      <td>${group || !l ? '' : l.units.toLocaleString()}</td>
      <td class="mleft">${thin ? `<span class="mflag" title="${shared ? `All lines of this item in this plan together (~${Math.round(totalUnits).toLocaleString()} units) buy` : 'The gold buys'} more than is listed right now">more than listed${shared ? ' (all lines)' : ''}</span>` : ''}</td>
      <td class="pl-act">${group ? `<button class="pl-btn pl-list" data-list="${n.id}" title="Auctionator shopping list of everything in ${esc(n.name)}">List</button>` : ''}<button class="pl-btn" data-ren="${n.id}" title="Rename (or double-click the name)">✎</button><button class="pl-btn" data-add="${n.id}" title="Add a line inside">+</button><button class="pl-btn" data-del="${n.id}" title="Remove">×</button></td>
    </tr>`;
  }).join('');
  const ex = exported?.planId === plan.id ? exported : null;
  return `<section class="pl-plan" data-plan="${plan.id}">${head}
    <div class="mfilters">
      <label class="field">Budget <input class="pl-budget" data-act="budget" type="number" step="any" min="0" value="${budget}"> g</label>
      <span class="field">Prices <span class="seg">
        ${HOUSES.map((h) => `<button data-act="house" data-v="${h.id}" class="${house === h.id ? 'on' : ''}">${h.label}</button>`).join('')}
      </span></span>
      <button class="mbtn2" data-act="open-all">Open all</button><button class="mbtn2" data-act="close-all">Close all</button>
      <button class="mbtn2" data-act="add-wallet">Add wallet</button>
      <button class="mbtn2" data-act="reset">Reset to starting weights</button>
      <button class="mbtn2" data-act="list-all" title="Auctionator shopping list of this whole plan">Shopping list (all)</button>
    </div>
    ${ex ? `<div class="pl-export">
      <div><strong>Auctionator list "${esc(ex.name)}"</strong>: ${ex.items.length} item${ex.items.length === 1 ? '' : 's'}${ex.copied ? ', copied' : ''}.
        In game: Auctionator's Shopping tab, Import, paste. Importing a list with the same name replaces it.
        Quantities = units the gold buys at today's ${house === 114 ? 'Horde' : 'Alliance'} prices.
        ${ex.skipped.length ? `<br>Left out (no price, or the gold buys less than one): ${ex.skipped.map(esc).join(', ')}` : ''}</div>
      <textarea class="pl-export-text" readonly rows="2">${esc(ex.text)}</textarea>
      <div><button class="mbtn2" data-act="copy">Copy again</button> <button class="mbtn2" data-act="export-close">Close</button></div>
    </div>` : ''}
    ${flags.length ? `<p class="mearly">More gold than the AH lists right now: ${flags.map(esc).join(', ')}. Buying them out would push the price up; spread the buying over time or lower their share.</p>` : ''}
    <div class="mfaction">
      <table class="mtable mft pl-table">
        <tr><th class="mleft">Wallet / item</th><th class="mleft">Band</th><th>% of parent</th><th>% of whole</th><th>Gold</th><th>Price each</th><th>Buys</th><th>Listed</th><th></th><th></th></tr>
        ${body}
        <tr class="pl-total"><td class="mleft">Total</td><td></td><td></td><td>100 %</td><td>${moneyHtml(budget * 10000)}</td><td colspan="5"></td></tr>
      </table>
    </div>
  </section>`;
}

function changed() { save(); render(); }

/** Rename a wallet, group or item line (✎ button or double-click on the name). */
function renameLine(plan, id) {
  const n = find(plan.tree, id).node;
  const name = n && prompt('New name:', n.name);
  if (name && name.trim()) {
    n.name = name.trim();
    changed();
    refreshPrices();
  }
}

/** One set of listeners on the tab's box; every control says what it is (data-act etc.) and which plan it's in. */
function wire(box) {
  const planOf = (el) => planById(el.closest('[data-plan]')?.dataset.plan);
  box.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    const plan = e.target.closest('[data-plan]') ? planOf(e.target) : null;
    if (a) {
      const act = a.dataset.act;
      if (act === 'new-plan') {
        const name = prompt('Name of the new plan:');
        if (name) { doc.plans.push(newPlan(name)); changed(); }
        return;
      }
      if (!plan) return;
      if (act === 'toggle-plan') { closedPlans.has(plan.id) ? closedPlans.delete(plan.id) : closedPlans.add(plan.id); keepSet(PLANS_CLOSED_KEY, closedPlans); render(); }
      else if (act === 'rename-plan') { const n = prompt('New name of the plan:', plan.name); if (n && n.trim()) { plan.name = n.trim(); changed(); } }
      else if (act === 'delete-plan') {
        if (confirm(`Delete the plan "${plan.name}" and everything in it? This can't be undone (except from a copy of the plan file).`)) {
          doc.plans = doc.plans.filter((p) => p !== plan);
          if (exported?.planId === plan.id) exported = null;
          changed();
        }
      } else if (act === 'house') { plan.house = Number(a.dataset.v); changed(); }
      else if (act === 'open-all') { walk(plan.tree, (n) => closed.delete(n.id)); keepSet(CLOSED_KEY, closed); render(); }
      else if (act === 'close-all') { walk(plan.tree, (n) => { if (n.children?.length) closed.add(n.id); }); keepSet(CLOSED_KEY, closed); render(); }
      else if (act === 'add-wallet') { const n = prompt(`Name of the new wallet in "${plan.name}":`); if (n) { addChild(plan.tree, null, n); changed(); } }
      else if (act === 'reset') {
        if (!plan.initial || !confirm(`Go back to the starting weights of "${plan.name}"? Your changes to its weights, names and lines are replaced (the budget stays).`)) return;
        plan.tree = structuredClone(plan.initial);
        setRows.clear();
        normalize(plan.tree);
        changed();
        refreshPrices();
      } else if (act === 'list-all') makeList(plan, null);
      else if (act === 'copy') copyList();
      else if (act === 'export-close') { exported = null; render(); }
      return;
    }
    const t = e.target.closest('[data-tog],[data-ren],[data-add],[data-del],[data-list]');
    if (!t || !plan) return;
    if (t.dataset.ren) renameLine(plan, t.dataset.ren);
    else if (t.dataset.list) makeList(plan, t.dataset.list);
    else if (t.dataset.tog) {
      const id = t.dataset.tog;
      closed.has(id) ? closed.delete(id) : closed.add(id);
      keepSet(CLOSED_KEY, closed);
      render();
    } else if (t.dataset.add) {
      const name = prompt('Name of the new line (an item name gets its price):');
      if (!name) return;
      addChild(plan.tree, t.dataset.add, name);
      closed.delete(t.dataset.add);
      changed();
      refreshPrices();
    } else if (t.dataset.del) {
      const n = find(plan.tree, t.dataset.del).node;
      if (n && confirm(`Remove "${n.name}"${n.children?.length ? ' and everything in it' : ''}? The rest of its group fills its share.`)) {
        remove(plan.tree, n.id);
        changed();
      }
    }
  });
  box.addEventListener('change', (e) => {
    const plan = planOf(e.target);
    if (!plan) return;
    if (e.target.dataset.act === 'budget') { plan.budget = Math.max(0, Number(e.target.value) || 0); changed(); return; }
    if (e.target.dataset.band) { setBand(plan.tree, e.target.dataset.band, e.target.value || null); changed(); return; }
    const k = e.target.dataset.k;
    if (!k) return;
    const next = document.activeElement?.dataset?.k; // Tab moved focus: put it back after redrawing
    const [id, field] = k.split(':');
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) { render(); return; }
    if (field === 'local') { setLocal(plan.tree, id, v, setRows); setRows.add(id); }
    else setWhole(plan.tree, id, v);
    changed();
    const el = next && box.querySelector(`[data-k="${next}"]`);
    if (el) { el.focus(); el.select?.(); }
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.dataset.k || e.target.dataset.act === 'budget')) e.target.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // Reorder plans: drag a header's grip onto another plan; the top half of that plan drops before it, the bottom half after.
  let dragId = null;
  const clearMarks = () => box.querySelectorAll('.pl-drop-before,.pl-drop-after').forEach((el) => el.classList.remove('pl-drop-before', 'pl-drop-after'));
  const dropSpot = (e) => {
    const sec = e.target.closest?.('section[data-plan]');
    if (!sec || !dragId) return null;
    const r = sec.getBoundingClientRect();
    return { sec, after: e.clientY > r.top + r.height / 2 };
  };
  box.addEventListener('dragstart', (e) => {
    const g = e.target.closest?.('.pl-grip');
    if (!g) return;
    dragId = g.closest('[data-plan]').dataset.plan;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.setDragImage(g.closest('.pl-head'), 12, 12);
    g.closest('section').classList.add('pl-dragging');
  });
  box.addEventListener('dragover', (e) => {
    const s = dropSpot(e);
    if (!s) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearMarks();
    if (s.sec.dataset.plan !== dragId) s.sec.classList.add(s.after ? 'pl-drop-after' : 'pl-drop-before');
  });
  box.addEventListener('drop', (e) => {
    const s = dropSpot(e);
    if (!s) return;
    e.preventDefault();
    const next = movePlan(doc.plans, dragId, s.sec.dataset.plan, s.after);
    dragId = null;
    if (next !== doc.plans) { doc.plans = next; changed(); } else { clearMarks(); render(); }
  });
  box.addEventListener('dragend', () => {
    if (!dragId) return;
    dragId = null;
    clearMarks();
    box.querySelectorAll('.pl-dragging').forEach((el) => el.classList.remove('pl-dragging'));
  });
  box.addEventListener('dblclick', (e) => {
    const t = e.target.closest('[data-rename]');
    const plan = t && planOf(t);
    if (plan) renameLine(plan, t.dataset.rename);
  });
}

/** Builds the Auctionator list for a group of a plan (null = the whole plan), shows it in that plan and copies it.
 *  Named after the plan, so lists from different plans don't replace each other in game. */
async function makeList(plan, id) {
  const house = houseOf(plan);
  const node = id ? find(plan.tree, id).node : null;
  const name = node ? `${plan.name}: ${node.name}` : plan.name;
  const priceOf = (itemName) => prices[itemName]?.latest?.[house]?.cheapest15 ?? null;
  exported = { planId: plan.id, name, ...shoppingList(plan.tree, id, Number(plan.budget) || 0, priceOf, name), copied: false };
  await copyList();
}

async function copyList() {
  if (!exported) return;
  try { await navigator.clipboard.writeText(exported.text); exported.copied = true; } catch { exported.copied = false; }
  render();
  if (!exported.copied) $('.pl-export-text')?.select(); // copy by hand (Ctrl+C) if the browser refused
}
