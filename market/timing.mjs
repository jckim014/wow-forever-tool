// Timing tab (Forever Market step 7, 2026-11-13): items whose price follows the time of day reliably enough to buy in
// the cheap hours and relist in the expensive hours. Per item and house, from the hourly cheapest-15% prices:
//   1. Days: local calendar days with the item priced in at least MIN_DAY_HOURS hours. Each price is divided by that
//      day's median, so a price drifting over the week doesn't look like a time-of-day pattern.
//   2. Hour profile: per hour of day, the median of those ratios across days.
//   3. Cheap window / expensive window: the `width` consecutive hours (wrapping past midnight) with the lowest / highest
//      average profile; the two windows don't overlap.
//   4. Swing = expensive / cheap - 1. Typical price = median of the day medians; cheap and expensive prices = typical x
//      the window's ratio. Profit per unit = expensive x 0.95 - cheap (AH cut on the sale; deposits left out), so a
//      swing above 1 / 0.95 - 1 = 5.3% makes money.
//   5. Held on N of M days: each day is checked against windows picked from the OTHER days (leave one out), so a pattern
//      can't pass just by fitting the days it was found in. A day counts when buying in those cheap hours and selling
//      in those expensive hours would have made money that day after the cut.
// Pure; tested in timing.test.mjs.
import { AH_CUT } from './faction.mjs';

export const MIN_DAY_HOURS = 12;
export const MIN_DAYS = 2;
export const BREAK_EVEN_SWING = 1 / (1 - AH_CUT) - 1;

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Median of a sorted array with the element at index `skip` left out (skip -1 = none); null when empty. */
function medianSkip(sorted, skip) {
  const n = sorted.length - (skip >= 0 ? 1 : 0);
  if (n <= 0) return null;
  const at = (k) => sorted[skip >= 0 && k >= skip ? k + 1 : k];
  const m = n >> 1;
  return n % 2 ? at(m) : (at(m - 1) + at(m)) / 2;
}

/** Local day number * 24 + hour for Unix seconds t (tzOffsetMin: minutes east of UTC; default this machine's zone).
 *  Memoised per zone: every item shares the same snapshot times. */
const slotCaches = new Map();
function localSlot(t, tzOffsetMin) {
  let cache = slotCaches.get(tzOffsetMin);
  if (!cache) slotCaches.set(tzOffsetMin, (cache = new Map()));
  let s = cache.get(t);
  if (s === undefined) {
    if (cache.size > 100000) cache.clear();
    const off = tzOffsetMin ?? -new Date(t * 1000).getTimezoneOffset();
    s = Math.floor((t + off * 60) / 3600);
    cache.set(t, s);
  }
  return s;
}

/**
 * points [[t, price], ...] -> qualifying days, oldest first: [{ day (local day number), median, ratios }] where
 * ratios is a 24-slot array of price / day median (NaN where that hour had no price). Two prices in one hour average.
 */
export function days(points, { tzOffsetMin = null, minDayHours = MIN_DAY_HOURS } = {}) {
  const byDay = new Map();
  for (const [t, v] of points) {
    if (!(v > 0)) continue;
    const slot = localSlot(t, tzOffsetMin);
    const day = Math.floor(slot / 24), hour = slot - day * 24;
    let acc = byDay.get(day);
    if (!acc) byDay.set(day, (acc = { sum: new Float64Array(24), cnt: new Uint8Array(24) }));
    acc.sum[hour] += v;
    acc.cnt[hour]++;
  }
  const out = [];
  for (const [day, { sum, cnt }] of byDay) {
    const vals = [];
    for (let h = 0; h < 24; h++) if (cnt[h]) vals.push(sum[h] / cnt[h]);
    if (vals.length < minDayHours) continue;
    const med = median(vals);
    const ratios = new Float64Array(24).fill(NaN);
    for (let h = 0; h < 24; h++) if (cnt[h]) ratios[h] = sum[h] / cnt[h] / med;
    out.push({ day, median: med, ratios });
  }
  return out.sort((a, b) => a.day - b.day);
}

/** Per hour, the median ratio across days, where at least minDays days have that hour; else null. */
export function profile(dayList, minDays) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const vals = dayList.map((d) => d.ratios[h]).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    out.push(vals.length >= minDays ? medianSkip(vals, -1) : null);
  }
  return out;
}

/** Do two circular windows of `width` hours overlap? */
export function overlaps(a, b, width) {
  const d = (((b - a) % 24) + 24) % 24;
  return d < width || d > 24 - width;
}

/** Lowest and highest windows of the profile, not overlapping: { cheap: { start, ratio }, exp: { start, ratio } } or null. */
export function bestWindows(prof, width) {
  const means = [];
  for (let s = 0; s < 24; s++) {
    let sum = 0, ok = true;
    for (let i = 0; i < width && ok; i++) { const v = prof[(s + i) % 24]; if (v === null) ok = false; else sum += v; }
    means.push(ok ? sum / width : null);
  }
  let cheap = null;
  means.forEach((m, s) => { if (m !== null && (cheap === null || m < means[cheap])) cheap = s; });
  if (cheap === null) return null;
  let exp = null;
  means.forEach((m, s) => { if (m !== null && !overlaps(cheap, s, width) && (exp === null || m > means[exp])) exp = s; });
  if (exp === null) return null;
  return { cheap: { start: cheap, ratio: means[cheap] }, exp: { start: exp, ratio: means[exp] } };
}

/** One day's average ratio over a window (needs at least half the window's hours that day), else null. */
function dayWindow(day, start, width) {
  let sum = 0, n = 0;
  for (let i = 0; i < width; i++) { const v = day.ratios[(start + i) % 24]; if (!Number.isNaN(v)) { sum += v; n++; } }
  return n >= Math.ceil(width / 2) ? sum / n : null;
}

/**
 * The time-of-day pattern of one item in one house. Returns { days } when there are too few days or no usable
 * windows; otherwise { days, cheapStart, expStart, width, swing, typical, cheapPrice, expPrice, profit, held, tested }.
 */
export function analyse(points, { width = 4, tzOffsetMin = null, minDayHours = MIN_DAY_HOURS, minDays = MIN_DAYS } = {}) {
  const ds = days(points, { tzOffsetMin, minDayHours });
  if (ds.length < minDays) return { days: ds.length };
  // per hour, that hour's ratios over all days, sorted (for the profile and for "the profile without day i")
  const cols = [];
  for (let h = 0; h < 24; h++) cols.push(ds.map((d) => d.ratios[h]).filter((v) => !Number.isNaN(v)).sort((a, b) => a - b));
  const profileWithout = (day, minN) => cols.map((col, h) => {
    const skip = day ? col.indexOf(day.ratios[h]) : -1; // -1 when the day has no price that hour
    return col.length - (skip >= 0 ? 1 : 0) >= minN ? medianSkip(col, skip) : null;
  });
  const w = bestWindows(profileWithout(null, Math.max(2, Math.ceil(ds.length / 2))), width);
  if (!w) return { days: ds.length };
  // held on: each day against the windows picked from the other days
  let held = 0, tested = 0;
  const minOthers = Math.max(1, Math.ceil((ds.length - 1) / 2));
  for (const day of ds) {
    const ww = bestWindows(profileWithout(day, minOthers), width);
    if (!ww) continue;
    const c = dayWindow(day, ww.cheap.start, width), e = dayWindow(day, ww.exp.start, width);
    if (c === null || e === null) continue;
    tested++;
    if (e * (1 - AH_CUT) > c) held++;
  }
  const typical = median(ds.map((d) => d.median));
  const cheapPrice = typical * w.cheap.ratio, expPrice = typical * w.exp.ratio;
  return {
    days: ds.length, cheapStart: w.cheap.start, expStart: w.exp.start, width,
    swing: w.exp.ratio / w.cheap.ratio - 1, typical, cheapPrice, expPrice,
    profit: expPrice * (1 - AH_CUT) - cheapPrice, held, tested,
  };
}
