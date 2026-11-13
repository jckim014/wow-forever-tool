// Trends charts as plain SVG (no library). Rules from the dataviz guidance: one y-axis per chart (price and units are
// separate charts), 2px lines, recessive grid, a legend plus direct end labels, a crosshair with one readout listing
// every series, per-cell tooltips on heat maps, sequential = one hue light->dark. Text never wears series colour.
import { niceTicks, nearest } from './stats.js';

/** Categorical slots 1-3 of the validated reference palette (light), one per house, in fixed order. */
export const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
/** Sequential blue ramp (steps 100-700) for heat maps. */
const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const text = (parent, x, y, s, attrs = {}) => { const t = el('text', { x, y, ...attrs }, parent); t.textContent = s; return t; };

function timeTicks(t0, t1) {
  const span = t1 - t0;
  const step = span <= 8 * 3600 ? 3600 : span <= 36 * 3600 ? 3 * 3600 : span <= 10 * 86400 ? 86400 : 7 * 86400;
  const out = [];
  const first = new Date(t0 * 1000);
  first.setMinutes(0, 0, 0);
  if (step >= 86400) first.setHours(0);
  let t = first.getTime() / 1000;
  while (t < t0) t += step;
  for (; t <= t1; t += step) out.push(t);
  return { ticks: out, label: (x) => new Date(x * 1000).toLocaleString(undefined, step < 86400 ? { hour: 'numeric' } : { month: 'short', day: 'numeric' }) };
}

/** Tooltip box inside a chart's wrapper (position: relative). Built with textContent only. */
function tooltip(wrap) {
  const tip = document.createElement('div');
  tip.className = 'ctip';
  tip.hidden = true;
  wrap.appendChild(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren();
      const h = document.createElement('div'); h.className = 'ctip-title'; h.textContent = title; tip.appendChild(h);
      for (const r of rows) {
        const line = document.createElement('div'); line.className = 'ctip-row';
        if (r.color) { const sw = document.createElement('span'); sw.className = 'ctip-sw'; sw.style.background = r.color; line.appendChild(sw); }
        const v = document.createElement('strong'); v.textContent = r.value; line.appendChild(v);
        const l = document.createElement('span'); l.textContent = ` ${r.label}`; line.appendChild(l);
        tip.appendChild(line);
      }
      tip.hidden = false;
      const w = wrap.clientWidth;
      const left = x + 14 + tip.offsetWidth > w ? x - 14 - tip.offsetWidth : x + 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight / 2)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/**
 * Line chart. series: [{ label, color, segments: [[[t, v], ...], ...] }]; times: every snapshot time in range (the
 * x-axis and crosshair positions). format(v) -> text. Draws into `wrap` (emptied first).
 */
export function lineChart(wrap, { series, times, format, axisFormat = format, height = 240, zero = false, integer = true }) {
  wrap.replaceChildren();
  wrap.classList.add('cwrap');
  const W = Math.max(320, wrap.clientWidth), H = height;
  const m = { l: 64, r: 92, t: 10, b: 26 };
  const values = series.flatMap((s) => s.segments.flat().map((p) => p[1]));
  if (!values.length || !times.length) {
    const p = document.createElement('p'); p.className = 'mempty'; p.textContent = 'No data in this range.'; wrap.appendChild(p);
    return;
  }
  let lo = zero ? 0 : Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo = zero ? 0 : lo * 0.9; hi = hi * 1.1 || 1; }
  const pad = (hi - lo) * 0.08; hi += pad; if (!zero) lo = Math.max(0, lo - pad);
  const t0 = times[0], t1 = times[times.length - 1] === t0 ? t0 + 3600 : times[times.length - 1];
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const svg = el('svg', { width: W, height: H, class: 'cline', role: 'img' }, wrap);
  // grid + y labels
  for (const v of niceTicks(lo, hi, 4, integer)) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'cgrid' }, svg);
    text(svg, m.l - 8, y(v) + 4, axisFormat(v), { class: 'caxis', 'text-anchor': 'end' });
  }
  const tt = timeTicks(t0, t1);
  for (const t of tt.ticks) text(svg, x(t), H - 8, tt.label(t), { class: 'caxis', 'text-anchor': 'middle' });
  el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'cbase' }, svg);

  // lines (a lone point gets a small dot so it is visible)
  for (const s of series) {
    for (const seg of s.segments) {
      if (seg.length === 1) el('circle', { cx: x(seg[0][0]), cy: y(seg[0][1]), r: 3, fill: s.color }, svg);
      else el('path', { d: seg.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(''), class: 'cpath', stroke: s.color }, svg);
    }
  }
  // direct end labels (text in ink, a short colour tick beside it), nudged apart when they would overlap
  const ends = series.map((s) => { const last = s.segments.at(-1)?.at(-1); return last ? { s, ty: y(last[1]), tx: x(last[0]) } : null; }).filter(Boolean)
    .sort((a, b) => a.ty - b.ty);
  for (let i = 1; i < ends.length; i++) if (ends[i].ty - ends[i - 1].ty < 14) ends[i].ty = ends[i - 1].ty + 14;
  for (const e of ends) {
    el('line', { x1: W - m.r + 6, x2: W - m.r + 14, y1: e.ty, y2: e.ty, stroke: e.s.color, 'stroke-width': 2 }, svg);
    text(svg, W - m.r + 18, e.ty + 4, e.s.label, { class: 'clabel' });
  }

  // crosshair + one readout for every series
  const hair = el('line', { y1: m.t, y2: H - m.b, class: 'chair', visibility: 'hidden' }, svg);
  const dots = series.map((s) => el('circle', { r: 4.5, fill: s.color, class: 'cdot', visibility: 'hidden' }, svg));
  const tip = tooltip(wrap);
  const lookup = series.map((s) => new Map(s.segments.flat().map((p) => [p[0], p[1]])));
  const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ev.clientX - box.left;
    const i = nearest(times, t0 + ((px - m.l) / (W - m.l - m.r)) * (t1 - t0));
    const t = times[i];
    hair.setAttribute('x1', x(t)); hair.setAttribute('x2', x(t)); hair.setAttribute('visibility', 'visible');
    const rows = [];
    series.forEach((s, k) => {
      const v = lookup[k].get(t);
      if (v === undefined) { dots[k].setAttribute('visibility', 'hidden'); rows.push({ color: s.color, value: '—', label: `${s.label} (not listed)` }); return; }
      dots[k].setAttribute('cx', x(t)); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('visibility', 'visible');
      rows.push({ color: s.color, value: format(v), label: s.label });
    });
    tip.show(x(t), ev.clientY - box.top, new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), rows);
  });
  hit.addEventListener('pointerleave', () => {
    hair.setAttribute('visibility', 'hidden');
    for (const d of dots) d.setAttribute('visibility', 'hidden');
    tip.hide();
  });
}

/** Colour step for a value among all values shown (quantile bins, so a few outliers don't wash out the rest). */
function rampFor(values) {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return (v) => {
    if (v === null || !sorted.length) return null;
    if (sorted[0] === sorted.at(-1)) return RAMP[3];
    let below = 0; while (below < sorted.length && sorted[below] < v) below++;
    return RAMP[Math.min(RAMP.length - 1, Math.floor((below / sorted.length) * RAMP.length))];
  };
}

function legendRamp(wrap, lowText, highText) {
  const l = document.createElement('div'); l.className = 'cramp';
  const a = document.createElement('span'); a.textContent = lowText; l.appendChild(a);
  for (const c of RAMP) { const s = document.createElement('i'); s.style.background = c; l.appendChild(s); }
  const b = document.createElement('span'); b.textContent = highText; l.appendChild(b);
  wrap.appendChild(l);
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Weekday x hour heat map. grid[7][24] of { value, n }. */
export function hourHeatmap(wrap, grid, format) {
  wrap.replaceChildren();
  wrap.classList.add('cwrap');
  const cell = 22, gap = 2, left = 40, top = 18;
  const W = left + 24 * (cell + gap), H = top + 7 * (cell + gap);
  const svg = el('svg', { width: W, height: H, class: 'cheat', role: 'img' }, wrap);
  const color = rampFor(grid.flat().map((c) => c.value));
  for (let h = 0; h < 24; h += 3) text(svg, left + h * (cell + gap) + cell / 2, 12, new Date(2026, 0, 1, h).toLocaleString(undefined, { hour: 'numeric' }), { class: 'caxis', 'text-anchor': 'middle' });
  const tip = tooltip(wrap);
  grid.forEach((row, d) => {
    text(svg, left - 6, top + d * (cell + gap) + cell / 2 + 4, DAYS[d], { class: 'caxis', 'text-anchor': 'end' });
    row.forEach((c, h) => {
      const r = el('rect', { x: left + h * (cell + gap), y: top + d * (cell + gap), width: cell, height: cell, rx: 3,
        class: c.value === null ? 'cempty' : 'ccell', fill: color(c.value) ?? 'none' }, svg);
      r.addEventListener('pointermove', (ev) => {
        const box = wrap.getBoundingClientRect();
        const label = `${DAYS[d]} ${new Date(2026, 0, 1, h).toLocaleString(undefined, { hour: 'numeric' })}`;
        tip.show(ev.clientX - box.left, ev.clientY - box.top, label,
          c.value === null ? [{ value: 'no data', label: '' }] : [{ value: format(c.value), label: `median of ${c.n} snapshot${c.n === 1 ? '' : 's'}` }]);
      });
      r.addEventListener('pointerleave', () => tip.hide());
    });
  });
  legendRamp(wrap, 'cheaper', 'dearer');
}

/** Calendar heat map: one row per week (Mon-Sun), one cell per day. days: [{ date, weekday, value, n }]. */
export function calendar(wrap, days, format) {
  wrap.replaceChildren();
  wrap.classList.add('cwrap');
  if (!days.length) { const p = document.createElement('p'); p.className = 'mempty'; p.textContent = 'No data yet.'; wrap.appendChild(p); return; }
  const cell = 26, gap = 2, left = 70, top = 18;
  const monday = (iso) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const weeks = [...new Set(days.map((d) => monday(d.date)))].sort();
  const W = left + 7 * (cell + gap), H = top + weeks.length * (cell + gap);
  const svg = el('svg', { width: W, height: H, class: 'cheat', role: 'img' }, wrap);
  const color = rampFor(days.map((d) => d.value));
  DAYS.forEach((d, i) => text(svg, left + i * (cell + gap) + cell / 2, 12, d[0], { class: 'caxis', 'text-anchor': 'middle' }));
  const tip = tooltip(wrap);
  weeks.forEach((w, row) => text(svg, left - 6, top + row * (cell + gap) + cell / 2 + 4,
    new Date(`${w}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }), { class: 'caxis', 'text-anchor': 'end' }));
  for (const d of days) {
    const row = weeks.indexOf(monday(d.date));
    const r = el('rect', { x: left + d.weekday * (cell + gap), y: top + row * (cell + gap), width: cell, height: cell, rx: 3, class: 'ccell', fill: color(d.value) }, svg);
    r.addEventListener('pointermove', (ev) => {
      const box = wrap.getBoundingClientRect();
      tip.show(ev.clientX - box.left, ev.clientY - box.top,
        new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
        [{ value: format(d.value), label: `median of ${d.n} snapshot${d.n === 1 ? '' : 's'}` }]);
    });
    r.addEventListener('pointerleave', () => tip.hide());
  }
  legendRamp(wrap, 'cheaper', 'dearer');
}
