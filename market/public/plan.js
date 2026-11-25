// Plan tab: Josh's budgets, each split into wallets, groups and items. Several plans sit on the page one under another,
// each with its own budget, faction, tree, bands, shopping lists and starting weights. Each row's % of parent and
// % of the whole are editable (planLib.js says what each edit does to the rest); the budget turns shares into gold;
// prices come from the latest snapshot. Saved to F:\ForeverAuctionData\plan.json through the server.
import { moneyHtml, iconHtml, HOUSES } from './shared.js';
import { refPriceOf } from './portfolioLib.js';
import {
  normalize, wholeShares, setLocal, remove, addChild, walk, validPlan, shoppingList, find, BANDS, setBand,
  toV2, newPlan, movePlan, moveLine, setGoldKeepRest,
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
let sources = null;      // per house { api, scan, used }: where the prices came from (/api/price-sources)
let refreshing = false;
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

/** Prices for lines not priced yet; `all` = every line again (Refresh prices: a new /bscan or hourly snapshot). */
async function refreshPrices(all = false) {
  const names = new Set();
  for (const p of doc.plans) walk(p.tree, (n) => { if (!n.children?.length) names.add(lookupName(n)); });
  const want = [...names].filter((n) => all || !(n in prices));
  if (!want.length && sources) return;
  // Loaded apart: the source line failing (e.g. an older server without /api/price-sources) must never blank the prices.
  const json = (url) => fetch(url).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  const [r, src] = await Promise.all([
    want.length ? json(`/api/prices?names=${encodeURIComponent(want.join('|'))}`) : null,
    json('/api/price-sources'),
  ]);
  if (r && !r.error) Object.assign(prices, r); // prices are extra; the plan works without them
  sources = src && !src.error ? src : sources ?? {};
  render();
}

/** "8:34 PM", or "Nov 13, 8:34 PM" when not today. */
function when(t) {
  const d = new Date(t * 1000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function sourcesHtml() {
  if (!sources) return '';
  if (!Object.keys(sources).length) return 'hourly data (restart Forever Market to use your /bscan scans)';
  return HOUSES.map((h) => {
    const s = sources[h.id];
    if (!s) return '';
    const text = s.used === 'scan' ? `your scan ${when(s.scan)}` : s.api ? `hourly data ${when(s.api)}` : 'no data';
    const tip = s.used === 'scan'
      ? `Your /bscan of ${when(s.scan)} is newer than the latest hourly data (${s.api ? when(s.api) : 'none'}). Items not in the scan keep their hourly price.`
      : `Latest hourly data. ${s.scan ? `Your last ${h.label} scan (${when(s.scan)}) is older.` : `No ${h.label} scan found.`}`;
    return `<span title="${esc(tip)}">${h.label}: ${text}</span>`;
  }).filter(Boolean).join(' · ');
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
      <button class="mbtn2" data-act="refresh-prices" title="Read prices again: your newest /bscan (after logging off or /reload) or the latest hourly data, whichever is newer, per faction"${refreshing ? ' disabled' : ''}>${refreshing ? 'Refreshing…' : 'Refresh prices'}</button>
      <span class="mfaint pl-src">Prices: ${sourcesHtml() || '…'}</span>
      <span class="field">All plans: <strong>${moneyHtml(total * 10000)}</strong></span>
      <span id="p-save"></span>
    </div>
    <p class="mhint2">Band: Large 4, Medium 2, Small 1, Token ½. In a group, each banded line's share = its band / the total of the bands (after any exact lines);
      changing a band only moves weight inside that group. Typing a % makes that line exact.<br>
      % of parent: change it and the rest of that group makes room, nothing outside the group moves; rows you have already typed stay as they are
      (until you reload the page), so you can type a group's numbers one after another.
      Gold: click a line's gold and type it to size it like a sub-budget; every other line keeps its gold and the budget grows (or shrinks) by the difference.
      Every group always adds up to 100%. Prices: cheapest 15%, from your newest /bscan or the latest hourly data, whichever is newer (per faction; hover a price for its source); "~" = units the gold buys at that price; Listed = units on the AH now.
      ✎ (or double-click a name) renames a line; 🏷 adds a short label of your own after the name (what it's for). Click a plan's name to fold it away; drag its ⠿ to move it. Drag a line's ⠿ to move it within its group.</p>
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
  const rec = (node, depth, anc) => {
    for (const n of node.children ?? []) {
      rows.push({ n, depth, anc: [...anc, n.id] });
      if (n.children?.length && !closed.has(n.id)) rec(n, depth + 1, [...anc, n.id]);
    }
  };
  rec(plan.tree, 0, []);
  const flags = [];
  // Gold per item across every line of this plan that buys it (Dreamfoil sits in two wallets): "more than listed" uses
  // it. Each plan is checked on its own (Josh, 2026-11-21).
  const itemGold = new Map();
  walk(plan.tree, (x) => {
    if (!x.children?.length) itemGold.set(lookupName(x), (itemGold.get(lookupName(x)) ?? 0) + (budget * (shares.get(x.id) ?? 0)) / 100);
  });
  const body = rows.map(({ n, depth, anc }) => {
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
      <span class="pl-grip pl-lgrip" draggable="true" title="Drag to move up or down within its group">⠿</span>
      ${group ? `<button class="pl-tog" data-tog="${n.id}" title="${closed.has(n.id) ? 'Open' : 'Close'}">${closed.has(n.id) ? '▸' : '▾'}</button>` : '<span class="pl-tog-sp"></span>'}
      ${group ? '' : p ? iconHtml(p.icon) : '<span class="micon-none"></span>'}<span class="${group ? 'pl-group' : `q${p?.quality ?? 1}`}" data-rename="${n.id}" title="Double-click to rename${n.item ? ` · priced as ${esc(n.item)}` : ''}">${esc(n.name)}</span>
      ${n.uses ? `<span class="pl-uses" data-uses-edit="${n.id}" title="${esc(n.uses)} (double-click to change)">· ${esc(n.uses.length > 45 ? `${n.uses.slice(0, 43).trimEnd()}…` : n.uses)}</span>` : ''}
      ${n.note ? `<span class="minfo" title="${esc(n.note)}">ⓘ</span>` : ''}</td>`;
    return `<tr class="pl-d${Math.min(depth, 3)}${group ? ' pl-grow' : ''}" data-line="${n.id}" data-anc="${anc.join(' ')}">
      ${nameCell}
      <td><span class="pl-click${n.band ? '' : ' pl-exact'}" data-bedit="${n.id}" title="Band: a size relative to the rest of this group. Exact = the % typed. Click to change">${n.band ? BANDS[n.band]?.label ?? n.band : 'Exact'}</span></td>
      <td><span class="pl-click" data-edit="${n.id}:local" data-v="${pct(n.w)}" title="% of its group. Click to type; Tab moves to the next line">${pct(n.w)} %</span></td>
      <td><span class="pl-click" data-edit="${n.id}:gold" data-v="${+gold.toFixed(2)}" title="Click to type this line's gold. Every other line keeps its gold: the budget grows or shrinks by the difference">${moneyHtml(Math.round(gold * 100) * 100)}</span></td>
      <td${l?.src ? ` title="${l.src === 'scan' ? `Your scan, ${when(l.t)}` : `Hourly data, ${when(l.t)}`}"` : ''}>${group ? '' : each ? moneyHtml(each) : `<span class="blank" title="${p === null ? 'No AH item with this name' : 'Not listed in this faction right now'}">—</span>`}</td>
      <td>${units === null ? '' : `~${units >= 100 ? Math.round(units).toLocaleString() : units.toFixed(1)}`}</td>
      <td>${group || !l ? '' : l.units.toLocaleString()}</td>
      <td class="mleft">${thin ? `<span class="mflag" title="${shared ? `All lines of this item in this plan together (~${Math.round(totalUnits).toLocaleString()} units) buy` : 'The gold buys'} more than is listed right now">more than listed${shared ? ' (all lines)' : ''}</span>` : ''}</td>
      <td class="pl-act">${group ? `<button class="pl-btn pl-list" data-list="${n.id}" title="Auctionator shopping list of everything in ${esc(n.name)}">List</button>` : ''}<button class="pl-btn" data-uses="${n.id}" title="What it's for: a short label of your own, shown after the name">🏷</button><button class="pl-btn" data-ren="${n.id}" title="Rename (or double-click the name)">✎</button><button class="pl-btn" data-add="${n.id}" title="Add a line inside">+</button><button class="pl-btn" data-del="${n.id}" title="Remove">×</button></td>
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
        Quantities = units the gold buys at the 7-day ${house === 114 ? 'Horde' : 'Alliance'} price (median of the hourly cheapest 15% over the last week); max price = that price + 50%.
        ${ex.skipped.length ? `<br>Left out (no price, or the gold buys less than one): ${ex.skipped.map(esc).join(', ')}` : ''}</div>
      <textarea class="pl-export-text" readonly rows="2">${esc(ex.text)}</textarea>
      <div><button class="mbtn2" data-act="copy">Copy again</button> <button class="mbtn2" data-act="export-close">Close</button></div>
    </div>` : ''}
    ${flags.length ? `<p class="mearly">More gold than the AH lists right now: ${flags.map(esc).join(', ')}. Buying them out would push the price up; spread the buying over time or lower their share.</p>` : ''}
    <div class="mfaction">
      <table class="mtable mft pl-table">
        <tr><th class="mleft">Wallet / item</th><th class="mleft">Band</th><th>% of parent</th><th>Gold</th><th>Price each</th><th>Buys</th><th>Listed</th><th></th><th></th></tr>
        ${body}
        <tr class="pl-total"><td class="mleft">Total</td><td></td><td></td><td>${moneyHtml(budget * 10000)}</td><td colspan="5"></td></tr>
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

/** A line's "for" label (🏷 button or double-click on the label): free text Josh types, display only (2026-11-22). */
function labelLine(plan, id) {
  const n = find(plan.tree, id).node;
  if (!n) return;
  const v = prompt(`What is "${n.name}" for? (e.g. Natural flasks). Leave empty to remove the label.`, n.uses ?? '');
  if (v === null) return;
  if (v.trim()) n.uses = v.trim(); else delete n.uses;
  changed();
}

/** Click-in edit (Josh, 2026-11-22: boxes on every row were distracting): the plain figure turns into a box with
 *  the value selected; Enter, Tab or leaving it applies, Escape cancels. */
function openEditor(box, key) {
  const span = box.querySelector(`[data-edit="${key}"]`);
  if (!span) return;
  const gold = key.endsWith(':gold');
  span.outerHTML = `<input class="pl-in${gold ? ' pl-gin' : ''}" data-k="${key}" data-orig="${span.dataset.v}" type="number" step="any" min="0"${gold ? '' : ' max="100"'} value="${span.dataset.v}">${gold ? '' : ' %'}`;
  const inp = box.querySelector(`input[data-k="${key}"]`);
  inp.focus();
  inp.select();
}

/** Click-in band: the label turns into the band list, opened. */
function openBand(box, plan, span) {
  const n = find(plan.tree, span.dataset.bedit).node;
  if (!n) return;
  const cur = n.band ?? '';
  span.outerHTML = `<select class="pl-band${cur ? '' : ' pl-exact'}" data-band="${n.id}" data-orig="${cur}">${[['', 'Exact'], ...Object.entries(BANDS).map(([k, b]) => [k, b.label])].map(([k, lb]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${lb}</option>`).join('')}</select>`;
  const sel = box.querySelector(`select[data-band="${n.id}"]`);
  sel.focus();
  try { sel.showPicker(); } catch { /* older browsers: the focused list opens on click or arrow keys */ }
}

/** One set of listeners on the tab's box; every control says what it is (data-act etc.) and which plan it's in. */
function wire(box) {
  const planOf = (el) => planById(el.closest('[data-plan]')?.dataset.plan);
  box.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    const plan = e.target.closest('[data-plan]') ? planOf(e.target) : null;
    if (a) {
      const act = a.dataset.act;
      if (act === 'refresh-prices') {
        refreshing = true;
        render();
        refreshPrices(true).finally(() => { refreshing = false; render(); });
        return;
      }
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
        const uses = new Map();
        walk(plan.tree, (n) => { if (n.uses) uses.set(n.id, n.uses); });
        plan.tree = structuredClone(plan.initial);
        walk(plan.tree, (n) => { if (uses.has(n.id)) n.uses = uses.get(n.id); else delete n.uses; }); // labels survive a reset
        setRows.clear();
        normalize(plan.tree);
        changed();
        refreshPrices();
      } else if (act === 'list-all') makeList(plan, null);
      else if (act === 'copy') copyList();
      else if (act === 'export-close') { exported = null; render(); }
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) { openEditor(box, ed.dataset.edit); return; }
    const be = e.target.closest('[data-bedit]');
    if (be && plan) { openBand(box, plan, be); return; }
    const t = e.target.closest('[data-tog],[data-ren],[data-uses],[data-add],[data-del],[data-list]');
    if (!t || !plan) return;
    if (t.dataset.ren) renameLine(plan, t.dataset.ren);
    else if (t.dataset.uses) labelLine(plan, t.dataset.uses);
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
    const [id, field] = k.split(':');
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) { render(); return; }
    if (field === 'local') { setLocal(plan.tree, id, v, setRows); setRows.add(id); }
    else if (field === 'gold') plan.budget = +setGoldKeepRest(plan.tree, id, v, Number(plan.budget) || 0).toFixed(4);
    changed();
  });
  // A click-in box or band list left without a change goes back to the plain display (after the focus has moved, and
  // only if a redraw hasn't already replaced it).
  box.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.dataset?.orig === undefined) return;
    setTimeout(() => { if (el.isConnected && document.activeElement !== el && el.value === el.dataset.orig) render(); }, 0);
  });
  box.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.dataset?.orig !== undefined) {
      if (e.key === 'Escape') { render(); return; }
      if (e.key === 'Enter' && el.dataset.k) {
        if (el.value === el.dataset.orig) render(); else el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if (e.key === 'Tab' && el.dataset.k) {
        // Tab / Shift+Tab: apply this one, then open the same column on the next / previous line of this plan.
        e.preventDefault();
        const field = el.dataset.k.split(':')[1];
        const cells = [...el.closest('table').querySelectorAll(`[data-edit$=":${field}"], [data-k$=":${field}"]`)];
        const nextKey = (cells[cells.indexOf(el) + (e.shiftKey ? -1 : 1)])?.dataset.edit;
        if (el.value === el.dataset.orig) render(); else el.dispatchEvent(new Event('change', { bubbles: true }));
        if (nextKey) openEditor(box, nextKey);
        return;
      }
    }
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
  // Reorder lines: drag a row's grip onto a line of the same group (the order only; no % changes). Over a sibling's
  // open contents it drops after that sibling's last row, so the marker always shows where the line will land.
  let dragLine = null; // { plan, id, sibs: ids of the lines it can move among }
  const lineSpot = (e) => {
    const tr = e.target.closest?.('tr[data-line]');
    if (!tr || !dragLine || tr.closest('[data-plan]').dataset.plan !== dragLine.plan.id) return null;
    const target = tr.dataset.anc.split(' ').find((id) => dragLine.sibs.includes(id));
    if (!target) return null;
    const self = tr.dataset.line === target;
    const r = tr.getBoundingClientRect();
    const after = !self || e.clientY > r.top + r.height / 2;
    const table = tr.closest('table');
    const mark = after ? [...table.querySelectorAll(`tr[data-anc~="${target}"]`)].pop() : table.querySelector(`tr[data-line="${target}"]`);
    return { target, after, mark };
  };
  box.addEventListener('dragstart', (e) => {
    const lg = e.target.closest?.('.pl-lgrip');
    if (lg) {
      const tr = lg.closest('tr');
      const plan = planOf(tr);
      const { parent } = find(plan.tree, tr.dataset.line);
      dragLine = { plan, id: tr.dataset.line, sibs: parent.children.map((k) => k.id) };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragLine.id);
      e.dataTransfer.setDragImage(tr.querySelector('.pl-name'), 12, 12);
      tr.closest('table').querySelectorAll(`tr[data-anc~="${dragLine.id}"]`).forEach((r) => r.classList.add('pl-dragging'));
      return;
    }
    const g = e.target.closest?.('.pl-grip');
    if (!g) return;
    dragId = g.closest('[data-plan]').dataset.plan;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    e.dataTransfer.setDragImage(g.closest('.pl-head'), 12, 12);
    g.closest('section').classList.add('pl-dragging');
  });
  box.addEventListener('dragover', (e) => {
    if (dragLine) {
      const s = lineSpot(e);
      clearMarks();
      if (!s) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (s.target !== dragLine.id) s.mark.classList.add(s.after ? 'pl-drop-after' : 'pl-drop-before');
      return;
    }
    const s = dropSpot(e);
    if (!s) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearMarks();
    if (s.sec.dataset.plan !== dragId) s.sec.classList.add(s.after ? 'pl-drop-after' : 'pl-drop-before');
  });
  box.addEventListener('drop', (e) => {
    if (dragLine) {
      const s = lineSpot(e);
      const d = dragLine;
      dragLine = null;
      if (!s) return;
      e.preventDefault();
      if (moveLine(d.plan.tree, d.id, s.target, s.after)) changed(); else render();
      return;
    }
    const s = dropSpot(e);
    if (!s) return;
    e.preventDefault();
    const next = movePlan(doc.plans, dragId, s.sec.dataset.plan, s.after);
    dragId = null;
    if (next !== doc.plans) { doc.plans = next; changed(); } else { clearMarks(); render(); }
  });
  box.addEventListener('dragend', () => {
    if (!dragId && !dragLine) return;
    dragId = null;
    dragLine = null;
    clearMarks();
    box.querySelectorAll('.pl-dragging').forEach((el) => el.classList.remove('pl-dragging'));
  });
  box.addEventListener('dblclick', (e) => {
    const u = e.target.closest('[data-uses-edit]');
    if (u) { labelLine(planOf(u), u.dataset.usesEdit); return; }
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
  const priceOf = (itemName) => refPriceOf(prices[itemName], house); // 7-day reference price, steadier than today's
  exported = { planId: plan.id, name, ...shoppingList(plan.tree, id, Number(plan.budget) || 0, priceOf, name), copied: false };
  await copyList();
}

async function copyList() {
  if (!exported) return;
  try { await navigator.clipboard.writeText(exported.text); exported.copied = true; } catch { exported.copied = false; }
  render();
  if (!exported.copied) $('.pl-export-text')?.select(); // copy by hand (Ctrl+C) if the browser refused
}
