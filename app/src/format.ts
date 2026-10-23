import type { Money } from './model'

/**
 * Copper -> "1g 23s 45c". Rounds to the nearest copper; leading zero units are dropped ("5s 0c"). Blank stays blank.
 * pad: silver and copper after a larger unit get two digits ("2s 04c"), so right-aligned columns line up.
 */
export function formatMoney(v: Money, pad = false): string {
  if (v === null || !Number.isFinite(v)) return ''
  const c = Math.round(Math.abs(v))
  if (c === 0) return '0c'
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100
  const p = (n: number) => (pad ? String(n).padStart(2, '0') : String(n))
  const parts = g ? [`${g}g`, `${p(s)}s`, `${p(cc)}c`] : s ? [`${s}s`, `${p(cc)}c`] : [`${cc}c`]
  return (v < 0 ? '-' : '') + parts.join(' ')
}

/** Compact form for lists: "16g 30s", "30s 05c", "5c" (copper dropped once there is gold). Blank stays blank. */
export function formatMoneyShort(v: Money): string {
  if (v === null || !Number.isFinite(v)) return ''
  const c = Math.round(Math.abs(v))
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100
  const pad = (n: number) => String(n).padStart(2, '0')
  const t = g ? `${g}g ${pad(s)}s` : s ? `${s}s ${pad(cc)}c` : `${cc}c`
  return (v < 0 && c ? '-' : '') + t
}

export const formatQty = (q: number) => String(Math.round(q * 100) / 100)

export const QUALITY_NAMES: Record<number, string> = { 0: 'Poor', 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic' }

/** How a price source is shown. The model and the edits file call user-entered prices "Typed"; the UI says "custom". */
const SOURCE_LABELS: Record<string, string> = { Typed: 'custom', 'Vendor buy': 'vendor buy', Imported: 'imported', Craft: 'craft' }
export const sourceLabel = (s: string | null | undefined) => (s ? SOURCE_LABELS[s] ?? s.toLowerCase() : '')
