// Forever Market page: tabs, item search, item detail. Talks to the local server (server.mjs).
import { formatMoney, QUALITY_NAMES, HOUSES } from './shared.js';

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
      <p class="mnote">Price history charts and patterns come in step 5.</p>`;
  } catch (e) {
    $('#detail').innerHTML = `<p class="mempty">Couldn't load item ${id}: ${esc(e.message)}</p>`;
  }
}
if (selected) select(selected);
