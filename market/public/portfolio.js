// Portfolio tab (Josh, 2026-11-23): what he owns, laid out like his Plans (same plans, wallets, groups and items; an
// item added to or removed from a plan shows up or goes here too). Descriptive only: held, average paid, value now.
// Held comes from TSM (bags, bank, mailbox, AH listings, unopened mail between his characters, guild banks); what he
// paid from the mail ledger; units TSM seems to have lost are kept and flagged (market/holdings.mjs).
import { moneyHtml, iconHtml } from './shared.js';
import { portfolioRows, lookupName, drift } from './portfolioLib.js';
import { walk, validPlan, toV2 } from './planLib.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CLOSED_KEY = 'forever-market:portfolio-closed';
const PLANS_CLOSED_KEY = 'forever-market:portfolio-sections-closed';
const readSet = (k) => new Set((() => { try { return JSON.parse(localStorage.getItem(k) ?? '[]'); } catch { return []; } })());
const keepSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch { /* per browser */ } };

const closed = readSet(CLOSED_KEY);
const closedPlans = readSet(PLANS_CLOSED_KEY);
let doc = null, holdings = null, prices = {};
let wired = false, loading = false;

/** "8:34 PM", or "Nov 13, 8:34 PM" when not today. */
function when(t) {
  const d = new Date(t * 1000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
const units = (n) => Math.round(n).toLocaleString();

export async function showPortfolio() {
  const box = $('#portfolio');
  if (!wired) { wire(box); wired = true; }
  if (!doc) box.innerHTML = '<p class="mempty">Loading…</p>';
  await load();
}

async function load() {
  if (loading) return;
  loading = true;
  render();
  const json = (url) => fetch(url).then(async (r) => { const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`); return j; });
  try {
    const [p, h] = await Promise.all([json('/api/plan'), json('/api/holdings')]);
    doc = validPlan(p.plan) ? toV2(p.plan) : { plans: [] };
    holdings = h;
    const names = new Set();
    for (const pl of doc.plans) walk(pl.tree, (n) => { if (!n.children?.length) names.add(lookupName(n)); });
    prices = names.size ? await json(`/api/prices?names=${encodeURIComponent([...names].join('|'))}`) : {};
  } catch (e) {
    $('#portfolio').innerHTML = `<p class="mempty">Couldn't read the portfolio: ${esc(e.message)}</p>`;
    loading = false;
    return;
  }
  loading = false;
  render();
}

function render() {
  if (!doc || !holdings) return;
  const files = holdings.files.map((f) => `<span title="TSM writes this account's file when you log out or /reload; a character's counts are as of its last login">${esc(f.account)}: ${when(f.t)}</span>`).join(' · ');
  $('#portfolio').innerHTML = `
    <div class="mfilters">
      <button class="mbtn2" data-act="refresh"${loading ? ' disabled' : ''}>${loading ? 'Reading…' : 'Refresh'}</button>
      <span class="mfaint">TSM data: ${files || 'no TradeSkillMaster.lua found'}${holdings.notCounted?.length ? ` · not counted: ${esc(holdings.notCounted.join(', '))}` : ''}</span>
      ${holdings.logError ? `<span class="mwarn-text" title="${esc(holdings.logError)}">Couldn't save this TSM reading to the holdings log</span>` : ''}
    </div>
    <p class="mhint2">Your holdings, organised like your plans. Held: every character's bags, bank, mailbox and auctions, mail sent between your characters that isn't opened yet, and guild banks
      (from TSM, on the plan's faction). Crafting, sending things away and selling lower it, as they should; ${esc((holdings.notCounted ?? []).join(', ') || 'nobody')} isn't counted (what goes there leaves, what comes back counts again). Avg paid: what you paid per unit for your auction purchases (mail ledger, since 2026-11-16 on every character).
      Value: held × the 7-day price (median of the hourly cheapest 15% over the last week; steadier than today's price, and your own buying or a /bscan doesn't move it), before the AH cut. Refresh reads TSM again: log out or /reload in game first (TSM saves its counts then). Amber = units TSM lost to the 100-mail mailbox limit, still counted (hover for details).</p>
    ${doc.plans.length ? doc.plans.map(planHtml).join('') : '<p class="mempty">No plans yet: make one in the Plan tab.</p>'}`;
}

function heldCell(r) {
  if (r.noItem) return '<span class="blank" title="No AH item with this name">—</span>';
  if (!r.flag) return r.held ? units(r.held) : '<span class="blank">0</span>';
  const f = r.flag;
  const who = f.lost.map((x) => `${units(x.units)} on ${x.char}`).join(', ');
  const tip = `TSM shows ${units(r.tsm)}. Since ${when(f.since)}, ${who} left unopened mail without turning up in that character's mailbox, bags or bank: `
    + 'most likely the 100-mail mailbox limit (TSM cannot see mails over the cap). They are still counted here: '
    + `showing ${units(r.held)}. Opening the rest of those mails (then log out or /reload, and Refresh) brings TSM's count back. `
    + 'If they really are gone, click "TSM is right".';
  return `<span class="pf-flag" title="${esc(tip)}">${units(r.held)}</span>
    <button class="pf-accept" data-accept="${esc(r.key)}" data-tsm="${r.tsm}" title="Use TSM's count (${units(r.tsm)}) for this item until it changes again">TSM is right</button>`;
}

function paidCell(r) {
  if (r.group || r.noItem) return '';
  if (r.avgPaid === null) return r.held ? '<span class="blank" title="No auction purchases of it in the mail ledger">—</span>' : '';
  const money = moneyHtml(Math.round(r.avgPaid));
  return r.held > r.bought ? `<span title="Bought ${units(r.bought)} of the ${units(r.held)} held: the rest is from before the ledger covered every character (2026-11-16), crafted, looted or farmed. The average covers the bought units only.">${money}</span>` : money;
}

/** Copper as plain text for hovers, e.g. 1g 05s 20c. */
const moneyText = (c) => { c = Math.round(c); const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, cc = c % 100; return g ? `${g}g ${String(s).padStart(2, '0')}s ${String(cc).padStart(2, '0')}c` : s ? `${s}s ${String(cc).padStart(2, '0')}c` : `${cc}c`; };

function valueCell(r) {
  if (r.noItem) return '';
  if (r.group) return r.missingPrice ? `<span title="${r.missingPrice} item${r.missingPrice === 1 ? '' : 's'} held with no price on this faction right now (not counted)">${moneyHtml(Math.round(r.value))}</span>` : moneyHtml(Math.round(r.value));
  if (!r.held) return '';
  return r.value === null ? '<span class="blank" title="No price on this faction">—</span>' : `<span title="${r.held} × ${moneyText(r.price)} (7-day price)">${moneyHtml(Math.round(r.value))}</span>`;
}

const pct = (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

/** Held share of the parent line, then how far it is from the plan's weight (drift in portfolioLib.js). */
function shareCell(r) {
  if (r.noItem || r.share === null || (!r.group && !r.held)) return Number(r.node.w) > 0 ? '' : '<span class="pf-noweight" title="No weight in the plan: left out of the % and of the group total">–</span>';
  const target = Number(r.node.w);
  const d = drift(r.share, target);
  const share = `${pct(r.share)}%`;
  if (!d) return '';
  const sign = d.diff >= 0 ? '+' : '−';
  const tip = `Plan weight ${pct(target)}% of the line above · held ${pct(r.share)}% (${d.ratio.toFixed(2)}× the weight)`;
  return `<span title="${tip}">${share}<span class="pf-drift pf-${d.level}">${sign}${pct(Math.abs(d.diff))}</span></span>`;
}

function planHtml(plan) {
  const { rows, total, faction } = portfolioRows(plan, holdings.items, prices);
  const open = !closedPlans.has(plan.id);
  const head = `<tr class="pf-phead">
      <td class="mleft"><button class="pl-ptog" data-act="toggle-plan" data-plan="${plan.id}" title="${open ? 'Fold away' : 'Open'}">${open ? '▾' : '▸'} <span class="pl-pname">${esc(plan.name)}</span></button>
        <span class="pl-psum"><span class="f${plan.house === 114 ? 114 : 111}">${faction}</span></span></td>
      <td><span class="pf-lab">Held</span>${total.flagged ? ` <span class="pf-flag-text">${total.flagged} flagged</span>` : ''}</td>
      <td><span class="pf-lab">Avg paid</span></td>
      <td><span class="pf-lab">Value</span> ${moneyHtml(Math.round(total.value))}</td>
      <td class="pf-share"><span class="pf-lab" title="Each line's value as a share of the line it sits in (an item's group, a group's plan), then the difference from the plan's weight in points. Green: over the weight, red: under it, once 5 or more points off or over double / under half the weight; grey otherwise. Lines with no weight (0%) are left out.">% of group</span></td>
    </tr>`;
  if (!open) return `<section class="pl-plan"><table class="mtable pf-table"><tbody>${head}</tbody></table></section>`;
  const hidden = new Set();
  const body = rows.map((r) => {
    if (hidden.has(r.node.id)) return '';
    const n = r.node;
    if (r.group && closed.has(n.id)) walk(n, (c) => hidden.add(c.id));
    const p = r.group ? null : prices[lookupName(n)];
    return `<tr class="pf-d${Math.min(r.depth, 3)}${r.group ? ' pf-grow' : ''}">
      <td class="mleft pl-name" style="padding-left:${28 + r.depth * 22}px">
        ${r.group ? `<button class="pl-tog" data-tog="${n.id}" title="${closed.has(n.id) ? 'Open' : 'Close'}">${closed.has(n.id) ? '▸' : '▾'}</button>` : '<span class="pl-tog-sp"></span>'}
        ${r.group ? '' : p ? iconHtml(p.icon) : '<span class="micon-none"></span>'}<span class="${r.group ? 'pl-group' : `q${p?.quality ?? 1}`}"${n.item ? ` title="Counted as ${esc(n.item)}"` : ''}>${esc(n.name)}</span>
        ${n.uses ? `<span class="pl-uses">· ${esc(n.uses.length > 45 ? `${n.uses.slice(0, 43).trimEnd()}…` : n.uses)}</span>` : ''}</td>
      <td>${r.group ? (r.flagged ? `<span class="pf-flag-text" title="Items in it with a flagged count">${r.flagged} flagged</span>` : '') : heldCell(r)}</td>
      <td>${paidCell(r)}</td>
      <td>${valueCell(r)}</td>
      <td class="pf-share">${shareCell(r)}</td>
    </tr>`;
  }).join('');
  return `<section class="pl-plan">
    <table class="mtable pf-table">
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table></section>`;
}

function wire(box) {
  box.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.act === 'refresh') return load();
    if (t.dataset.act === 'toggle-plan') {
      const id = t.dataset.plan;
      if (closedPlans.has(id)) closedPlans.delete(id); else closedPlans.add(id);
      keepSet(PLANS_CLOSED_KEY, closedPlans);
      return render();
    }
    if (t.dataset.tog) {
      const id = t.dataset.tog;
      if (closed.has(id)) closed.delete(id); else closed.add(id);
      keepSet(CLOSED_KEY, closed);
      return render();
    }
    if (t.dataset.accept) {
      t.disabled = true;
      try {
        const r = await fetch('/api/portfolio/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: t.dataset.accept, tsm: Number(t.dataset.tsm) }) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      } catch (err) {
        alert(`Couldn't save: ${err.message}`);
      }
      return load();
    }
  });
}
