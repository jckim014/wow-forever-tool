// Cycles tab (code name "timing"): items whose price follows the time of day (cheap hours vs expensive hours), per faction.
// Calculation in market/timing.mjs (server); this is the table, its filters and sorting.
import { formatMoney } from './shared.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const HOUSE = { 111: 'Alliance', 114: 'Horde' };
const PREFS_KEY = 'forever-market:timing';
const WINDOWS = [7, 14, 30];
const WIDTHS = [2, 3, 4, 6];
const EARLY_DAYS = 7; // fewer days than this: results are rough (shown in amber)

const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'); } catch { return {}; } })();
const f = {
  search: '', house: prefs.house ?? 'both', minSwing: prefs.minSwing ?? '', minProfit: prefs.minProfit ?? '',
  minSold: prefs.minSold ?? '', held: prefs.held ?? '0', hideThin: prefs.hideThin ?? true,
  sort: prefs.sort ?? 'gold', sortDir: prefs.sortDir ?? -1, days: prefs.days ?? 14, width: prefs.width ?? 4,
};
const save = () => { try { const { search, ...rest } = f; localStorage.setItem(PREFS_KEY, JSON.stringify(rest)); } catch { /* convenience only */ } };

let data = null;
let openItem = () => {};
let loadedFor = null;

/** Hour 0-23 -> "4 am"; a window -> "4–8 am" or "10 pm–2 am". */
const ampm = (h) => (h < 12 ? 'am' : 'pm');
const h12 = (h) => h % 12 || 12;
export function hoursLabel(start, width) {
  const end = (start + width) % 24;
  return ampm(start) === ampm(end) && end > start ? `${h12(start)}–${h12(end)} ${ampm(end)}` : `${h12(start)} ${ampm(start)}–${h12(end)} ${ampm(end)}`;
}

const heldShare = (r) => (r.tested ? r.held / r.tested : 0);
const num = (v) => v ?? -1;
const COLS = [
  ['name', 'Item', (r) => r.name, 'mleft'],
  ['house', 'Faction', (r) => r.house, 'mleft'],
  ['cheap', 'Cheap hours', (r) => r.cheapStart, 'mleft', 'The hours of the day when the price is usually lowest (your local time)'],
  ['buy', 'Buy around', (r) => r.cheapPrice, '', 'Typical price in the cheap hours: the median day price x how far below it these hours usually are'],
  ['exp', 'Expensive hours', (r) => r.expStart, 'mleft', 'The hours of the day when the price is usually highest (your local time)'],
  ['sell', 'Sell around', (r) => r.expPrice, '', 'Typical price in the expensive hours'],
  ['swing', 'Swing', (r) => r.swing, '', 'How much more expensive the expensive hours usually are than the cheap hours. Above 5.3% makes money after the 5% AH cut'],
  ['profit', 'Profit / unit', (r) => r.profit, '', 'Sell around x 0.95 (AH cut) - buy around. Deposits left out'],
  ['held', 'Held on', heldShare, '', 'Days when buying in the cheap hours and selling in the expensive hours would have made money. Each day is checked against hours picked from the other days, so a pattern can\'t pass just by fitting the days it was found in'],
  ['days', 'Days', (r) => r.days, '', 'Days with the item priced in at least half the hours. Under 7 days the result is rough'],
  ['units', 'Units listed', (r) => r.units, '', 'Median units listed per snapshot in this faction'],
  ['ours', 'Sales / day*', (r) => num(r.oursPerDay), '', 'This faction, NA PvE: estimated units sold per day over the window (see the note below the filters)'],
  ['tsm', 'TSM sales / day', (r) => num(r.tsmPerDay), '', 'TSM: sold per day across the whole Forever-US region (TSM users only)'],
  ['gold', 'Max gold / day*', (r) => num(r.goldPerDay), '', 'Profit per unit x Sales / day: a ceiling, as you would never make every sale'],
];

export function initTiming(open) { openItem = open; }

export async function showTiming() {
  const box = $('#timing');
  if (!data) box.innerHTML = '<p class="mempty">Looking for daily price patterns…</p>';
  try {
    const status = await (await fetch('/api/status')).json();
    const want = `${status.latest}:${f.days}:${f.width}`;
    if (data && loadedFor === want) return;
    data = await (await fetch(`/api/timing?days=${f.days}&width=${f.width}`)).json();
    if (data.error) throw new Error(data.error);
    loadedFor = want;
    render();
  } catch (e) {
    box.innerHTML = `<p class="mempty">Couldn't look for patterns: ${esc(e.message)}</p>`;
  }
}

function filtered() {
  const q = f.search.trim().toLowerCase();
  const minSw = f.minSwing === '' ? null : Number(f.minSwing) / 100;
  const minP = f.minProfit === '' ? null : Number(f.minProfit) * 10000;
  const minS = f.minSold === '' ? null : Number(f.minSold);
  const minHeld = Number(f.held) / 100;
  const rows = data.rows.filter((r) =>
    (f.house === 'both' || String(r.house) === f.house)
    && (!q || r.name.toLowerCase().includes(q))
    && (minSw === null || r.swing >= minSw)
    && (minP === null || r.profit >= minP)
    && (minS === null || Math.max(r.tsmPerDay ?? 0, r.oursPerDay ?? 0) >= minS)
    && (!f.hideThin || r.units > 2)
    && (minHeld === 0 || (r.tested > 0 && heldShare(r) >= minHeld)));
  const get = COLS.find((c) => c[0] === f.sort)[2];
  return rows.sort((a, b) => {
    const x = get(a), y = get(b);
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * f.sortDir;
  });
}

function render() {
  const box = $('#timing');
  const rows = filtered();
  const shown = rows.slice(0, 500);
  const n = (v) => (v === null || v === undefined ? '<span class="blank">—</span>' : v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
  const early = data.bestDays < EARLY_DAYS;
  const notYet = data.bestDays < data.minDays;
  box.innerHTML = `
    <div class="mfilters">
      <input id="t-search" class="search" type="search" placeholder="Search items…" value="${esc(f.search)}">
      <span class="field">Faction <span class="seg" id="t-house">
        ${[['both', 'Both'], ['111', 'Alliance'], ['114', 'Horde']].map(([k, l]) => `<button data-v="${k}" class="${f.house === k ? 'on' : ''}">${l}</button>`).join('')}
      </span></span>
      <label class="field">Min swing <input id="t-swing" type="number" step="any" min="0" placeholder="%" value="${esc(f.minSwing)}"> %</label>
      <label class="field">Min profit <input id="t-profit" type="number" step="any" min="0" placeholder="gold" value="${esc(f.minProfit)}"> g</label>
      <label class="field" title="Our sales estimate for that faction or TSM's region figure, whichever is higher">Min sales/day <input id="t-sold" type="number" step="any" min="0" value="${esc(f.minSold)}"></label>
      <label class="field">Held on <select id="t-held">${[['0', 'any'], ['50', '50%+ of days'], ['75', '75%+ of days'], ['100', 'every day']].map(([v, l]) => `<option value="${v}"${f.held === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field" title="Items with 2 or fewer units usually listed in that faction"><input id="t-thin" type="checkbox"${f.hideThin ? ' checked' : ''}> Hide thin markets</label>
    </div>
    <div class="mfilters">
      <span class="field" title="How many days back to look">Window <span class="seg" id="t-window">
        ${WINDOWS.map((d) => `<button data-v="${d}" class="${f.days === d ? 'on' : ''}">${d} days</button>`).join('')}
        <button data-v="custom" class="${WINDOWS.includes(f.days) ? '' : 'on'}">${WINDOWS.includes(f.days) ? 'Custom' : `${f.days} day${f.days === 1 ? '' : 's'}`}</button>
      </span>
      <span id="t-custom" hidden><input id="t-days" type="number" min="1" max="365" step="1" value="${f.days}"> days <button id="t-days-apply" class="mbtn">Apply</button></span></span>
      <span class="field" title="How many hours long the cheap and the expensive stretch of the day are">Hours to buy or sell in <span class="seg" id="t-width">
        ${WIDTHS.map((w) => `<button data-v="${w}" class="${f.width === w ? 'on' : ''}">${w} h</button>`).join('')}
      </span></span>
      <span class="count">${rows.length.toLocaleString()} of ${data.rows.length.toLocaleString()} with a profitable swing${rows.length > shown.length ? `, first ${shown.length} shown` : ''}</span>
    </div>
    ${early ? `<p class="mearly">${notYet
      ? `Still collecting: a pattern needs at least ${data.minDays} days with an item priced in ${data.minDayHours}+ hours each; so far the most any item has is ${data.bestDays}. Results appear by themselves as days complete.`
      : `Early results: at most ${data.bestDays} days of data. Treat these as rough until there are about ${EARLY_DAYS} days (the Days column turns black).`}</p>` : ''}
    <p class="mhint2">For each item and faction: the ${f.width}-hour stretch of the day when its price (cheapest 15%) is usually lowest and the one when it's usually highest,
      measured against each day's own typical price so a price drifting over the week doesn't count. Profit per unit = sell around × 0.95 − buy around (AH cut; deposits left out).
      Window: last ${data.days} day${data.days === 1 ? '' : 's'} (${data.snapshots} hourly snapshots); times are your local time. Click a row to see the item in Price history, with its hour heat map.<br>
      * Sales / day is estimated from hourly listings: it includes some cancellations and misses items bought within the hour. See Method check. Max gold / day = profit per unit × Sales / day: a ceiling.</p>
    ${data.rows.length ? `<div class="mfaction">
      <table class="mtable mft">
        <tr>${COLS.map(([k, label, , cls, title]) => `<th class="${cls}" ${title ? `title="${esc(title)}"` : ''}><button data-sort="${k}">${label}${f.sort === k ? (f.sortDir < 0 ? ' ▾' : ' ▴') : ''}</button></th>`).join('')}</tr>
        ${shown.map((r) => `<tr data-item="${r.item}" data-house="${r.house}" class="mfrow">
          <td class="mleft"><span class="q${r.quality ?? 1}">${esc(r.name)}</span>${r.units <= 2 ? ' <span class="mflag">thin</span>' : ''}</td>
          <td class="mleft">${HOUSE[r.house]}</td>
          <td class="mleft">${hoursLabel(r.cheapStart, r.width)}</td><td>${esc(formatMoney(r.cheapPrice))}</td>
          <td class="mleft">${hoursLabel(r.expStart, r.width)}</td><td>${esc(formatMoney(r.expPrice))}</td>
          <td>${Math.round(r.swing * 100)}%</td><td><strong>${esc(formatMoney(r.profit))}</strong></td>
          <td>${r.tested ? `${Math.round(heldShare(r) * 100)}% <span class="mest-sub">(${r.held}/${r.tested})</span>` : '<span class="blank">—</span>'}</td>
          <td class="${r.days < EARLY_DAYS ? 'mwarn' : ''}">${r.days}</td>
          <td>${Math.round(r.units).toLocaleString()}</td><td>${n(r.oursPerDay)}</td><td>${n(r.tsmPerDay)}</td>
          <td>${r.goldPerDay === null ? '<span class="blank">—</span>' : esc(formatMoney(r.goldPerDay))}</td>
        </tr>`).join('')}
      </table>
    </div>` : ''}`;

  const rerender = () => { save(); render(); };
  const search = $('#t-search');
  search.addEventListener('input', () => { f.search = search.value; const pos = search.selectionStart; render(); const s = $('#t-search'); s.focus(); s.setSelectionRange(pos, pos); });
  for (const [id, key] of [['#t-swing', 'minSwing'], ['#t-profit', 'minProfit'], ['#t-sold', 'minSold']]) {
    $(id).addEventListener('change', (e) => { f[key] = e.target.value; rerender(); });
  }
  $('#t-held').addEventListener('change', (e) => { f.held = e.target.value; rerender(); });
  $('#t-thin').addEventListener('change', (e) => { f.hideThin = e.target.checked; rerender(); });
  $('#t-house').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { f.house = b.dataset.v; rerender(); } });
  const reload = () => { save(); showTiming(); };
  $('#t-window').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'custom') { $('#t-custom').hidden = false; $('#t-days').focus(); return; }
    f.days = Number(b.dataset.v); reload();
  });
  const applyDays = () => { const d = Math.round(Number($('#t-days').value)); if (d >= 1 && d <= 365) { f.days = d; reload(); } };
  $('#t-days-apply').addEventListener('click', applyDays);
  $('#t-days').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyDays(); });
  $('#t-width').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { f.width = Number(b.dataset.v); reload(); } });
  box.querySelector('.mft')?.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]');
    if (s) {
      const k = s.dataset.sort;
      f.sortDir = f.sort === k ? -f.sortDir : ['name', 'house', 'cheap', 'exp'].includes(k) ? 1 : -1;
      f.sort = k;
      rerender();
      return;
    }
    const row = e.target.closest('[data-item]');
    if (row) openItem(Number(row.dataset.item), Number(row.dataset.house));
  });
}
