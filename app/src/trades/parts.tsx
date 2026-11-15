// Small display pieces shared by the trade tracker's views.
import type { ReactNode } from 'react'
import { SIDE_NAME, type Side } from './model'

/** Copper -> coin-coloured "12g 40s 05c" (zero parts after a larger one kept, so amounts read evenly). */
export function Money({ v, sign = false }: { v: number; sign?: boolean }) {
  const c = Math.round(Math.abs(v))
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100
  const parts: ReactNode[] = []
  if (g) parts.push(<span key="g" className="t-g">{g.toLocaleString()}g</span>)
  if (g || s) parts.push(<span key="s" className="t-s">{g ? String(s).padStart(2, '0') : s}s</span>)
  parts.push(<span key="c" className="t-c">{g || s ? String(cc).padStart(2, '0') : cc}c</span>)
  const pre = v < 0 && c ? '−' : sign && c ? '+' : ''
  return <span className="t-money">{pre}{parts.reduce<ReactNode[]>((a, p, i) => (i ? [...a, ' ', p] : [p]), [])}</span>
}

export const Fac = ({ s }: { s: Side }) => <span className={s === 'A' ? 't-ally' : 't-horde'}>{SIDE_NAME[s]}</span>
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
export const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`
export const Profit = ({ v }: { v: number }) => <span className={v >= 0 ? 't-pos' : 't-neg'}><Money v={v} sign /></span>

