// Faction tab: items cheaper on one faction's AH than the other's, after moving them through Blackwater.
// Calculation in market/faction.mjs (server); this is the table, its filters and sorting.
import { formatMoney } from './shared.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const HOUSE = { 111: 'Alliance', 114: 'Horde' };
const PREFS_KEY = 'forever-market:faction';

const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'); } catch { return {}; } })();
const f = {
  search: '', dir: prefs.dir ?? 'both', minProfit: prefs.minProfit ?? '', minMargin: prefs.minMargin ?? '',
  minSold: prefs.minSold ?? '', steady: prefs.steady ?? '0', hideThin: prefs.hideThin ?? true,
  sort: prefs.sort ?? 'profit', sortDir: prefs.sortDir ?? -1,
  days: prefs.days ?? 3, // steadiness and sales window
};
const WINDOWS = [3, 7, 30];
const save = () => { try { const { search, ...rest } = f; localStorage.setItem(PREFS_KEY, JSON.stringify(rest)); } catch { /* convenience only */ } };

let data = null;
let openItem = () => {};
let loadedFor = null;

const steadyShare = (r) => (r.steady.seen ? r.steady.profitable / r.steady.seen : 0);
const COLS = [
  ['name', 'Item', (r) => r.name, 'mleft'],
  ['dir', 'Direction', (r) => r.from, 'mleft'],
  ['buy', 'Buy', (r) => r.buy, 'Cheap side: average of the cheapest 15% of units'],
  ['sell', 'Sell', (r) => r.sell, 'Dear side: lowest listing (or its cheapest-15% average when the lowest is a lone outlier)'],
  ['profit', 'Profit / unit', (r) => r.profit, 'Sell x 0.95 (AH cut) - buy x 1.15 (15% Blackwater cut on a transfer listed at the buy price)'],
  ['margin', 'Margin', (r) => r.margin, 'Profit as a share of the buy price'],
  ['cheapUnits', 'Units to buy', (r) => r.cheapUnits, 'Units listed on the cheap side'],
  ['ours', 'Sales / day*', (r) => r.oursPerDay ?? -1, 'Dear side, your realm: estimated units sold per day over the window (see the note below the filters)'],
  ['tsm', 'TSM sales / day', (r) => r.tsmPerDay ?? -1, 'TSM: sold per day across the whole Forever-US region (TSM users only)'],
  ['steady', 'Steady', steadyShare, 'Share of hourly snapshots in the window where this trade was profitable'],
];

export function initFaction(open) { openItem = open; }

export async function showFaction() {
  const box = $('#faction');
  if (!data) box.innerHTML = '<p class="mempty">Comparing Alliance and Horde…</p>';
  try {
    const status = await (await fetch('/api/status')).json();
    const want = `${status.latest}:${f.days}`;
    if (data && loadedFor === want) return;
    data = await (await fetch(`/api/faction?days=${f.days}`)).json();
    if (data.error) throw new Error(data.error);
    loadedFor = want;
    render();
  } catch (e) {
    box.innerHTML = `<p class="mempty">Couldn't compare the factions: ${esc(e.message)}</p>`;
  }
}

function filtered() {
  const q = f.search.trim().toLowerCase();
  const minP = f.minProfit === '' ? null : Number(f.minProfit) * 10000;
  const minM = f.minMargin === '' ? null : Number(f.minMargin) / 100;
  const minS = f.minSold === '' ? null : Number(f.minSold);
  const minSteady = Number(f.steady) / 100;
  const rows = data.rows.filter((r) =>
    (f.dir === 'both' || String(r.from) === f.dir)
    && (!q || r.name.toLowerCase().includes(q))
    && (minP === null || r.profit >= minP)
    && (minM === null || r.margin >= minM)
    && (minS === null || Math.max(r.tsmPerDay ?? 0, r.oursPerDay ?? 0) >= minS)
    && (!f.hideThin || !r.thin)
    && (minSteady === 0 || (r.steady.seen > 0 && steadyShare(r) >= minSteady)));
  const get = COLS.find((c) => c[0] === f.sort)[2];
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * f.sortDir;
  });
}

function render() {
  const box = $('#faction');
  const rows = filtered();
  const shown = rows.slice(0, 500);
  const n = (v) => (v === null || v === undefined ? '<span class="blank">—</span>' : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
  box.innerHTML = `
    <div class="mfilters">
      <input id="f-search" class="search" type="search" placeholder="Search items…" value="${esc(f.search)}">
      <span class="field">Direction <span class="seg" id="f-dir">
        ${[['both', 'Both'], ['111', 'Alliance → Horde'], ['114', 'Horde → Alliance']].map(([k, l]) => `<button data-v="${k}" class="${f.dir === k ? 'on' : ''}">${l}</button>`).join('')}
      </span></span>
      <label class="field">Min profit <input id="f-profit" type="number" step="any" min="0" placeholder="gold" value="${esc(f.minProfit)}"> g</label>
      <label class="field">Min margin <input id="f-margin" type="number" step="any" min="0" placeholder="%" value="${esc(f.minMargin)}"> %</label>
      <label class="field" title="Dear side: our sales estimate or TSM's region figure, whichever is higher">Min sales/day <input id="f-sold" type="number" step="any" min="0" value="${esc(f.minSold)}"></label>
      <span class="field" title="The period used for Steady and for Sales / day">Window <span class="seg" id="f-window">
        ${WINDOWS.map((d) => `<button data-v="${d}" class="${f.days === d ? 'on' : ''}">${d} days</button>`).join('')}
        <button data-v="custom" class="${WINDOWS.includes(f.days) ? '' : 'on'}">${WINDOWS.includes(f.days) ? 'Custom' : `${f.days} day${f.days === 1 ? '' : 's'}`}</button>
      </span>
      <span id="f-custom" hidden><input id="f-days" type="number" min="1" max="365" step="1" value="${f.days}"> days <button id="f-days-apply" class="mbtn">Apply</button></span></span>
      <label class="field">Steady <select id="f-steady">${[['0', 'any'], ['50', '50%+'], ['75', '75%+'], ['100', 'always']].map(([v, l]) => `<option value="${v}"${f.steady === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" title="Cheap side with 2 or fewer units, or dear side with 2 or fewer listings"><input id="f-thin" type="checkbox"${f.hideThin ? ' checked' : ''}> Hide thin markets</label>
      <span class="count">${rows.length.toLocaleString()} of ${data.rows.length.toLocaleString()} profitable${rows.length > shown.length ? `, first ${shown.length} shown` : ''}</span>
    </div>
    <p class="mhint2">Profit per unit = sell × 0.95 − buy × 1.15 (AH cut on the sale; 15% Blackwater cut on a transfer listed at the buy price;
      deposits left out). Latest snapshot ${esc(new Date(data.latest * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))};
      Steady and Sales / day over the last ${data.days} day${data.days === 1 ? '' : 's'} (${data.snapshots} hourly snapshots). Click a row to see the item in Trends.<br>
      * Sales / day is estimated from hourly listings: it includes some cancellations and misses items bought within the hour. See Method check.</p>
    <div class="mfaction">
      <table class="mtable mft">
        <tr>${COLS.map(([k, label, , cls]) => {
          const title = cls && cls !== 'mleft' ? cls : '';
          return `<th class="${cls === 'mleft' ? 'mleft' : ''}" ${title ? `title="${esc(title)}"` : ''}><button data-sort="${k}">${label}${f.sort === k ? (f.sortDir < 0 ? ' ▾' : ' ▴') : ''}</button></th>`;
        }).join('')}</tr>
        ${shown.map((r) => `<tr data-item="${r.item}" class="mfrow">
          <td class="mleft"><span class="q${r.quality ?? 1}">${esc(r.name)}</span>${r.outlier ? ' <span class="mflag" title="The dear side\'s lowest listing was far below the rest (bait?), so its cheapest-15% average is used">outlier ignored</span>' : ''}${r.thin ? ' <span class="mflag">thin</span>' : ''}</td>
          <td class="mleft">${HOUSE[r.from]} → ${HOUSE[r.to]}</td>
          <td>${esc(formatMoney(r.buy))}</td><td>${esc(formatMoney(r.sell))}</td>
          <td><strong>${esc(formatMoney(r.profit))}</strong></td><td>${Math.round(r.margin * 100)}%</td>
          <td>${r.cheapUnits.toLocaleString()}</td><td>${n(r.oursPerDay)}</td><td>${n(r.tsmPerDay)}</td>
          <td>${r.steady.seen ? `${Math.round(steadyShare(r) * 100)}% <span class="mest-sub">(${r.steady.profitable}/${r.steady.seen})</span>` : '<span class="blank">—</span>'}</td>
        </tr>`).join('')}
      </table>
    </div>`;

  const rerender = () => { save(); render(); };
  const search = $('#f-search');
  search.addEventListener('input', () => { f.search = search.value; const pos = search.selectionStart; render(); const s = $('#f-search'); s.focus(); s.setSelectionRange(pos, pos); });
  for (const [id, key] of [['#f-profit', 'minProfit'], ['#f-margin', 'minMargin'], ['#f-sold', 'minSold']]) {
    $(id).addEventListener('change', (e) => { f[key] = e.target.value; rerender(); });
  }
  $('#f-steady').addEventListener('change', (e) => { f.steady = e.target.value; rerender(); });
  const setDays = (d) => { f.days = d; save(); showFaction(); };
  $('#f-window').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'custom') { $('#f-custom').hidden = false; $('#f-days').focus(); return; }
    setDays(Number(b.dataset.v));
  });
  const applyDays = () => { const d = Math.round(Number($('#f-days').value)); if (d >= 1 && d <= 365) setDays(d); };
  $('#f-days-apply').addEventListener('click', applyDays);
  $('#f-days').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyDays(); });
  $('#f-thin').addEventListener('change', (e) => { f.hideThin = e.target.checked; rerender(); });
  $('#f-dir').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { f.dir = b.dataset.v; rerender(); } });
  box.querySelector('.mft').addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]');
    if (s) {
      const k = s.dataset.sort;
      f.sortDir = f.sort === k ? -f.sortDir : k === 'name' || k === 'dir' ? 1 : -1;
      f.sort = k;
      rerender();
      return;
    }
    const row = e.target.closest('[data-item]');
    if (row) openItem(Number(row.dataset.item));
  });
}
