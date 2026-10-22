import type { Money } from './model'

/** Copper -> "1g 23s 45c". Rounds to the nearest copper; leading zero units are dropped ("5s 0c"). Blank stays blank. */
export function formatMoney(v: Money): string {
  if (v === null || !Number.isFinite(v)) return ''
  const c = Math.round(Math.abs(v))
  if (c === 0) return '0c'
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100
  const parts = g ? [`${g}g`, `${s}s`, `${cc}c`] : s ? [`${s}s`, `${cc}c`] : [`${cc}c`]
  return (v < 0 ? '-' : '') + parts.join(' ')
}

export const formatQty = (q: number) => String(Math.round(q * 100) / 100)

export const QUALITY_NAMES: Record<number, string> = { 0: 'Poor', 1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic' }
