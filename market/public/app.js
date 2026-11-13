// Forever Market page: tabs, item search, item detail. Talks to the local server (server.mjs).
import { formatMoney, formatMoneyAxis, QUALITY_NAMES, HOUSES } from './shared.js';
import { segments, weekdayHourGrid, daily } from './stats.js';
import { lineChart, hourHeatmap, calendar, SERIES_COLORS } from './charts.js';
import { showCheck } from './check.js';
import { initFaction, showFaction } from './faction.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const money = (v) => (v === null || v === undefined ? '<span class="blank">—</span>' : esc(formatMoney(v)));
const when = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const ago = (t) => {
  const min = (Date.now() / 1000 - t) / 60;
  return min < 90 ? `${Math.round(min)} min ago` : min < 2880 ? `${(min / 60).toFixed(1)} h ago` : `${Math.round(min / 1440)} days ago`;
};

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

// ---- server alive? Tabs check in every minute; the server stops 10 minutes after the last check-in. ----
async function heartbeat() {
  try {
    await fetch('/api/heartbeat', { method: 'POST' });
    $('#stopped').hidden = true;
  } catch {
    $('#stopped').hidden = false;
  }
}
heartbeat();
setInterval(heartbeat, 60 * 1000);

// ---- status line ----
async function status() {
  try {
    const s = await get('/api/status');
    const old = Date.now() / 1000 - s.latest > 3 * 3600;
    $('#status').innerHTML = `${s.snapshots.toLocaleString()} hourly snapshots since ${esc(when(s.first))} · latest `
      + `<span class="${old ? 'warn' : ''}">${esc(when(s.latest))} (${esc(ago(s.latest))})</span> · `
      + `${s.named.toLocaleString()} of ${s.itemIds.toLocaleString()} items named`;
  } catch (e) {
    $('#status').textContent = `Can't read the price database: ${e.message}`;
  }
}
status();
setInterval(status, 5 * 60 * 1000);

// ---- tabs ----
function showView(v) {
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === v);
  $('#view-trends').hidden = v !== 'trends';
  $('#view-faction').hidden = v !== 'faction';
  $('#view-check').hidden = v !== 'check';
  if (v === 'check') showCheck();
  if (v === 'faction') showFaction();
  try { localStorage.setItem('forever-market:view', v); } catch { /* per-browser convenience */ }
}
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => showView(b.dataset.view));
try { const v = localStorage.getItem('forever-market:view'); showView(v === 'faction' || v === 'check' ? v : 'trends'); } catch { /* default */ }

// ---- search ----
let selected = Number(new URLSearchParams(location.hash.slice(1)).get('item')) || null;
let searchSeq = 0;
const cheap = (l, h) => l?.[h]?.cheapest15 ?? null;

function renderResults(list, q) {
  if (!q.trim()) { $('#results').innerHTML = ''; return; }
  if (!list.length) { $('#results').innerHTML = '<p class="mempty">No item matches.</p>'; return; }
  $('#results').innerHTML = `<div class="mhead"><div>Item</div>${HOUSES.map((h) => `<div class="mnum">${h.short}</div>`).join('')}</div>`
    + list.map((it) => `<div class="mrow${it.id === selected ? ' on' : ''}" data-id="${it.id}">
        <div class="mname"><span class="q${it.quality ?? 1}">${esc(it.name)}</span> <span class="mid">${it.id}</span></div>
        ${HOUSES.map((h) => `<div class="mnum">${money(cheap(it.latest, h.id))}</div>`).join('')}
      </div>`).join('');
}

let timer = null;
$('#q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const q = $('#q').value;
    const seq = ++searchSeq;
    try {
      const list = q.trim() ? await get(`/api/search?q=${encodeURIComponent(q)}`) : [];
      if (seq === searchSeq) renderResults(list, q);
    } catch (e) {
      $('#results').innerHTML = `<p class="mempty">Search failed: ${esc(e.message)}</p>`;
    }
  }, 150);
});
$('#results').addEventListener('click', (e) => {
  const row = e.target.closest('.mrow');
  if (row) select(Number(row.dataset.id));
});

/** Our own sales estimate from the hourly snapshots, per faction (approximate: see the footnote and Method check). */
function estimateBlock(e) {
  if (!e) return '';
  const n = (v) => (v === null ? '—' : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const hours = Math.min(...HOUSES.map((h) => e[h.id].hours));
  const tip = 'Worked out by comparing each hour\'s listings with the next. Confirmed = part of a stack was bought (that can only be a '
    + 'sale). The rest = listings that disappeared while they still had 2+ hours left, so they were bought or cancelled; likely '
    + 'reposts are left out. The Method check tab tests this against your own TSM sales.';
  return `<div class="mtsm mest" title="${esc(tip)}"><span class="mtsm-h">Sales · your realm (estimated*)</span>
    ${HOUSES.map((h) => {
      const x = e[h.id];
      return `<span>${h.label}: <strong>~${n(x.certain === null ? null : x.certain + x.probable)}</strong> sold per day*
        ${x.certain > 0.05 ? `<span class="mest-sub">(${n(x.certain)} confirmed)</span>` : ''}</span>`;
    }).join('')}
    <span class="mtsm-when">last ${e.days} days · ${hours} h of data</span>
    <span class="mfoot">* Estimated from hourly listings: includes some cancellations and misses items bought within the hour. See Method check.</span></div>`;
}

/** TSM's region sale figures (pooled TSM users' real sales across Forever-US, not this realm). */
function tsmBlock(t) {
  if (!t) return '<p class="mnote">TSM data: not found (the TSM desktop app writes it).</p>';
  const when = t.downloadTime ? new Date(t.downloadTime * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '?';
  if (t.soldPerDay === null && t.saleAvg === null) return `<p class="mnote">TSM (${esc(t.region)} region): no sales recorded for this item.</p>`;
  const sold = t.soldPerDay === null ? '—' : t.soldPerDay >= 100 ? Math.round(t.soldPerDay).toLocaleString() : t.soldPerDay.toFixed(1);
  const rate = t.saleRate === null ? '—' : `${(t.saleRate * 100).toFixed(1)}%`;
  return `<div class="mtsm"><span class="mtsm-h">TSM sales · ${esc(t.region)} region</span>
    <span><strong>${sold}</strong> sold per day</span><span><strong>${rate}</strong> sale rate</span>
    <span><strong>${money(t.saleAvg)}</strong> average sale price</span>
    <span class="mtsm-when" title="Pooled real sales recorded by TSM users across the whole region, not just your realm. Updated about daily by the TSM desktop app.">data from ${esc(when)}</span></div>`;
}

// ---- item detail (charts come in step 5) ----
async function select(id) {
  selected = id;
  location.hash = `item=${id}`;
  for (const r of document.querySelectorAll('.mrow')) r.classList.toggle('on', Number(r.dataset.id) === id);
  try {
    const it = await get(`/api/item?id=${id}`);
    $('#detail').innerHTML = `
      <h2 class="q${it.quality ?? 1}">${esc(it.name)}</h2>
      <div class="msub">${esc(QUALITY_NAMES[it.quality] ?? '')} · item ${it.id} ·
        <a href="https://www.wowhead.com/forever/item=${it.id}" target="_blank" rel="noopener">Wowhead</a></div>
      <table class="mtable">
        <tr><th>House</th><th>Cheapest 15%</th><th>Lowest</th><th>Units listed</th><th>As of</th></tr>
        ${HOUSES.map((h) => {
          const l = it.latest[h.id];
          return `<tr><td>${h.label} (${h.id})</td><td>${money(l?.cheapest15)}</td><td>${money(l?.lowest)}</td>
            <td>${l ? l.units.toLocaleString() : '<span class="blank">not listed</span>'}</td><td>${l ? esc(ago(l.t)) : ''}</td></tr>`;
        }).join('')}
      </table>
      ${estimateBlock(it.estimate)}
      ${tsmBlock(it.tsm)}
      <div id="trends"></div>`;
    await loadTrends(id);
  } catch (e) {
    $('#detail').innerHTML = `<p class="mempty">Couldn't load item ${id}: ${esc(e.message)}</p>`;
  }
}
if (selected) select(selected);

// ---- Trends: history charts for the selected item ----
const MEASURES = [['cheapest15', 'Cheapest 15%', 3], ['lowest', 'Lowest', 1], ['median', 'Median', 2]];
const RANGES = [['1', '24 h'], ['7', '7 days'], ['30', '30 days'], ['0', 'All'], ['custom', 'Custom']];
const SHOW = [['both', 'Both'], ...HOUSES.map((h) => [String(h.id), h.label])];
/** "YYYY-MM-DDTHH:MM" in local time, for datetime-local inputs. */
const localInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const prefs = (() => { try { return JSON.parse(localStorage.getItem('forever-market:trends') ?? '{}'); } catch { return {}; } })();
const opt = {
  measure: prefs.measure ?? 'cheapest15', days: prefs.days ?? '7', show: prefs.show ?? 'both',
  heat: HOUSES.some((h) => h.id === prefs.heat) ? prefs.heat : HOUSES[0].id,
  from: prefs.from ?? localInput(Date.now() - 7 * 86400000), to: prefs.to ?? localInput(Date.now()),
};
const savePrefs = () => { try { localStorage.setItem('forever-market:trends', JSON.stringify(opt)); } catch { /* convenience only */ } };
let hist = null;

async function loadTrends(id) {
  const box = $('#trends');
  if (!box) return;
  box.innerHTML = '<p class="mempty">Loading history…</p>';
  try {
    const range = opt.days === 'custom'
      ? `from=${Math.floor(new Date(opt.from).getTime() / 1000)}&to=${Math.floor(new Date(opt.to).getTime() / 1000)}`
      : `days=${opt.days}`;
    hist = await get(`/api/history?id=${id}&${range}`);
    if (selected === id) renderTrends();
  } catch (e) {
    box.innerHTML = `<p class="mempty">Couldn't load the history: ${esc(e.message)}</p>`;
  }
}

const segButtons = (name, items, current) => `<span class="seg" data-opt="${name}">${items.map(([k, label]) =>
  `<button data-v="${k}" class="${String(k) === String(current) ? 'on' : ''}">${label}</button>`).join('')}</span>`;

function renderTrends() {
  const box = $('#trends');
  if (!box || !hist) return;
  const col = MEASURES.find((m) => m[0] === opt.measure)[2];
  const pts = (h) => (hist.houses[h] ?? []).map((r) => [r[0], r[col]]);
  const unitPts = (h) => (hist.houses[h] ?? []).map((r) => [r[0], r[4]]);
  const n = hist.snapshots.length;
  // Colour follows the house, not its position in the list shown (Alliance always slot 1, Horde slot 2).
  const colorOf = (h) => SERIES_COLORS[HOUSES.indexOf(h)];
  const shown = opt.show === 'both' ? HOUSES : HOUSES.filter((h) => String(h.id) === opt.show);
  box.innerHTML = `
    <div class="mctl">
      <span class="field">Price ${segButtons('measure', MEASURES.map((m) => [m[0], m[1]]), opt.measure)}</span>
      <span class="field">Range ${segButtons('days', RANGES, opt.days)}</span>
      ${opt.days === 'custom' ? `<span class="field mrange"><input type="datetime-local" id="r-from" value="${esc(opt.from)}"> to
        <input type="datetime-local" id="r-to" value="${esc(opt.to)}"> <button id="r-apply" class="mbtn">Apply</button></span>` : ''}
      <span class="mcount">${n.toLocaleString()} snapshot${n === 1 ? '' : 's'} in range</span>
    </div>
    <div class="mctl"><span class="field">Show ${segButtons('show', SHOW, opt.show)}</span>
      <span class="mlegend">${shown.map((h) => `<span><i style="background:${colorOf(h)}"></i>${h.label}</span>`).join('')}</span></div>
    <h3>Price per unit</h3><div id="c-price"></div>
    <h3>Units listed</h3><div id="c-units"></div>
    <div class="mctl"><span class="field">Heat maps for ${segButtons('heat', HOUSES.map((h) => [h.id, h.label]), opt.heat)}</span></div>
    <div class="mheats">
      <div><h3>By weekday and hour</h3><div id="c-hours"></div></div>
      <div><h3>By day</h3><div id="c-days"></div></div>
    </div>
    <p class="mnote">${n < 24 * 7 ? 'Patterns by hour and weekday need about a week of hourly data to mean much; the maps fill in as data arrives. ' : ''}Heat maps use the price chosen above over the selected range, in your local time.</p>
    <details class="mtablewrap"><summary>Show as a table</summary><div id="c-table"></div></details>`;

  const series = (getPts) => shown.map((h) => ({ label: h.label, color: colorOf(h), segments: segments(getPts(h.id), hist.snapshots) }));
  lineChart($('#c-price'), { series: series(pts), times: hist.snapshots, format: (v) => formatMoney(v), axisFormat: formatMoneyAxis });
  lineChart($('#c-units'), { series: series(unitPts), times: hist.snapshots, format: (v) => Math.round(v).toLocaleString(), height: 150, zero: true });
  hourHeatmap($('#c-hours'), weekdayHourGrid(pts(opt.heat)), (v) => formatMoney(v));
  calendar($('#c-days'), daily(pts(opt.heat)), (v) => formatMoney(v));

  // table view: every snapshot, newest first
  const byT = HOUSES.map((h) => new Map((hist.houses[h.id] ?? []).map((r) => [r[0], r])));
  const rows = [...hist.snapshots].reverse().map((t) => {
    const cells = byT.map((m) => {
      const r = m.get(t);
      return r ? `<td>${money(r[col])}</td><td>${r[4].toLocaleString()}</td>` : '<td class="blank">—</td><td class="blank">—</td>';
    }).join('');
    return `<tr><td>${esc(new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</td>${cells}</tr>`;
  }).join('');
  $('#c-table').innerHTML = `<table class="mtable"><tr><th>Time</th>${HOUSES.map((h) => `<th>${h.label}</th><th>Units</th>`).join('')}</tr>${rows}</table>`;

  for (const g of box.querySelectorAll('[data-opt]')) {
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const name = g.dataset.opt;
      opt[name] = name === 'heat' ? Number(b.dataset.v) : b.dataset.v;
      savePrefs();
      if (name === 'days') loadTrends(selected); else renderTrends();
    });
  }
  $('#r-apply')?.addEventListener('click', () => {
    const from = $('#r-from').value, to = $('#r-to').value;
    if (!from || !to || new Date(from) >= new Date(to)) { $('#r-from').setCustomValidity('Pick a start before the end'); $('#r-from').reportValidity(); return; }
    opt.from = from; opt.to = to;
    savePrefs();
    loadTrends(selected);
  });
}

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderTrends, 150); });

// The Faction tab opens an item in Trends (with both factions shown).
initFaction((id) => {
  opt.show = 'both';
  showView('trends');
  select(id);
});
