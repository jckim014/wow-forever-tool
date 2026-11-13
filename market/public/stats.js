// Pure calculations behind the Trends charts (no DOM). Tested in market/stats.test.mjs.
// A point is [t (Unix seconds), value]; value null = no price.

export function median(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Splits a series into line segments: a new segment starts wherever a snapshot passed without this item listed
 * (snapshots = every snapshot time in range), so the line has a gap instead of bridging it.
 */
export function segments(points, snapshots) {
  const have = new Map(points.filter((p) => p[1] !== null).map((p) => [p[0], p[1]]));
  const out = [];
  let cur = [];
  for (const t of snapshots) {
    if (have.has(t)) cur.push([t, have.get(t)]);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Median per local weekday (0 = Monday) and hour: grid[7][24] of { value, n } (value null where no data). */
export function weekdayHourGrid(points, tzOffsetMin = null) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (const [t, v] of points) {
    if (v === null) continue;
    const d = local(t, tzOffsetMin);
    cells[(d.getUTCDay() + 6) % 7][d.getUTCHours()].push(v);
  }
  return cells.map((row) => row.map((vals) => ({ value: median(vals), n: vals.length })));
}

/** Median per local calendar day, oldest first: [{ date: 'YYYY-MM-DD', weekday (0 = Monday), value, n }]. */
export function daily(points, tzOffsetMin = null) {
  const byDay = new Map();
  for (const [t, v] of points) {
    if (v === null) continue;
    const d = local(t, tzOffsetMin);
    const key = d.toISOString().slice(0, 10);
    if (!byDay.has(key)) byDay.set(key, { date: key, weekday: (d.getUTCDay() + 6) % 7, vals: [] });
    byDay.get(key).vals.push(v);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
    .map(({ vals, ...d }) => ({ ...d, value: median(vals), n: vals.length }));
}

/** A Date whose UTC fields show local time (tzOffsetMin: minutes east of UTC; default this browser's zone). */
function local(t, tzOffsetMin) {
  const off = tzOffsetMin ?? -new Date(t * 1000).getTimezoneOffset();
  return new Date((t + off * 60) * 1000);
}

/** About `count` round tick values covering [min, max] (1, 2, 2.5 or 5 x 10^k steps; whole steps only with `integer`, e.g. copper). */
export function niceTicks(min, max, count = 5, integer = false) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = integer
    ? Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.75)) // whole units; a little finer is fine
    : [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** Index of the value in a sorted array closest to x. */
export function nearest(sorted, x) {
  let lo = 0, hi = sorted.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid; else hi = mid;
  }
  return Math.abs(sorted[lo] - x) <= Math.abs(sorted[hi] - x) ? lo : hi;
}
