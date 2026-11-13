// Shared by the page and the server's tests (plain ES module, no build step).

/** Copper -> "1g 23s 45c" (same rules as the shuffle app's formatMoney). Blank stays blank. */
export function formatMoney(v, pad = false) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const c = Math.round(Math.abs(v));
  if (c === 0) return '0c';
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100;
  const p = (n) => (pad ? String(n).padStart(2, '0') : String(n));
  const parts = g ? [`${g}g`, `${p(s)}s`, `${p(cc)}c`] : s ? [`${s}s`, `${p(cc)}c`] : [`${cc}c`];
  return (v < 0 ? '-' : '') + parts.join(' ');
}

/** Compact money for chart axes: zero parts dropped ("40g", "39g 75s", "2s 50c", "5c"). */
export function formatMoneyAxis(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  const c = Math.round(Math.abs(v));
  const g = Math.floor(c / 10000), sv = Math.floor((c % 10000) / 100), cc = c % 100;
  const parts = g ? [`${g}g`, sv && `${sv}s`] : sv ? [`${sv}s`, cc && `${cc}c`] : [`${cc}c`];
  return (v < 0 ? '-' : '') + parts.filter(Boolean).join(' ');
}

export const QUALITY_NAMES = { 0: 'Poor', 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic', 5: 'Legendary', 6: 'Artifact', 7: 'Heirloom' };

/** Josh's realm (confirmed by in-game scans, 2026-11-12/13). Only the two faction houses are shown: Blackwater is
 *  just the transfer route between them, its prices don't matter (Josh, 2026-11-13). */
export const HOUSES = [
  { id: 111, label: 'Alliance', short: 'A' },
  { id: 114, label: 'Horde', short: 'H' },
];
/** The neutral house on Josh's realm: used only as the transfer route (15% cut, Josh confirmed 2026-11-13). */
export const BLACKWATER = { id: 117, label: 'Blackwater', cut: 0.15 };
