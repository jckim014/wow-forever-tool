// Forever Market page: tabs, item search, item detail. Talks to the local server (server.mjs).
import { formatMoney, formatMoneyAxis, QUALITY_NAMES, HOUSES } from './shared.js';
import { segments, weekdayHourGrid, daily } from './stats.js';
import { lineChart, hourHeatmap, calendar, SERIES_COLORS } from './charts.js';

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
  try { localStorage.setItem('forever-market:view', v); } catch { /* per-browser convenience */ }
}
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => showView(b.dataset.view));
try { showView(localStorage.getItem('forever-market:view') === 'faction' ? 'faction' : 'trends'); } catch { /* default */ }

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
      <div id="trends"></div>`;
    await loadTrends(id);
  } catch (e) {
    $('#detail').innerHTML = `<p class="mempty">Couldn't load item ${id}: ${esc(e.message)}</p>`;
  }
}
if (selected) select(selected);

// ---- Trends: history charts for the selected item ----
const MEASURES = [['cheapest15', 'Cheapest 15%', 3], ['lowest', 'Lowest', 1], ['median', 'Median', 2]];
const RANGES = [['1', '24 h'], ['7', '7 days'], ['30', '30 days'], ['0', 'All']];
const prefs = (() => { try { return JSON.parse(localStorage.getItem('forever-market:trends') ?? '{}'); } catch { return {}; } })();
const opt = { measure: prefs.measure ?? 'cheapest15', days: prefs.days ?? '7', heat: prefs.heat ?? 111 };
const savePrefs = () => { try { localStorage.setItem('forever-market:trends', JSON.stringify(opt)); } catch { /* convenience only */ } };
let hist = null;

async function loadTrends(id) {
  const box = $('#trends');
  if (!box) return;
  box.innerHTML = '<p class="mempty">Loading history…</p>';
  try {
    hist = await get(`/api/history?id=${id}&days=${opt.days}`);
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
  box.innerHTML = `
    <div class="mctl">
      <span class="field">Price ${segButtons('measure', MEASURES.map((m) => [m[0], m[1]]), opt.measure)}</span>
      <span class="field">Range ${segButtons('days', RANGES, opt.days)}</span>
      <span class="mcount">${n.toLocaleString()} snapshot${n === 1 ? '' : 's'} in range</span>
    </div>
    <div class="mlegend">${HOUSES.map((h, i) => `<span><i style="background:${SERIES_COLORS[i]}"></i>${h.label}</span>`).join('')}</div>
    <h3>Price per unit</h3><div id="c-price"></div>
    <h3>Units listed</h3><div id="c-units"></div>
    <div class="mctl"><span class="field">Heat maps for ${segButtons('heat', HOUSES.map((h) => [h.id, h.label]), opt.heat)}</span></div>
    <div class="mheats">
      <div><h3>By weekday and hour</h3><div id="c-hours"></div></div>
      <div><h3>By day</h3><div id="c-days"></div></div>
    </div>
    <p class="mnote">${n < 24 * 7 ? 'Patterns by hour and weekday need about a week of hourly data to mean much; the maps fill in as data arrives. ' : ''}Heat maps use the price chosen above over the selected range, in your local time.</p>
    <details class="mtablewrap"><summary>Show as a table</summary><div id="c-table"></div></details>`;

  const series = (getPts) => HOUSES.map((h, i) => ({ label: h.label, color: SERIES_COLORS[i], segments: segments(getPts(h.id), hist.snapshots) }));
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
}

let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderTrends, 150); });
