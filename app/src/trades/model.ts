// Cross-faction trade tracker: the data (one JSON document) and every figure the page shows. Money in copper.
//
// A batch is one purchase. Its transfer moves it to the other faction through Blackwater: the buying side lists it at
// the transfer price and receives that minus 15%; the other side pays the transfer price. Sales are recorded on the
// selling side with the gold that arrived in the mailbox (already after the AH cut). Adjustments change a balance for
// anything outside the trades and never count as trading profit.

export type Side = 'A' | 'H'
export const other = (s: Side): Side => (s === 'A' ? 'H' : 'A')
export const SIDE_NAME: Record<Side, string> = { A: 'Alliance', H: 'Horde' }
export const BLACKWATER_CUT = 0.15

export interface Sale { id: string; qty: number; received: number; at: string }
export interface Batch {
  id: string
  item: string
  qty: number
  side: Side // where it was bought
  cost: number
  at: string
  transfer: { price: number; at: string } | null
  sales: Sale[]
}
export interface Adjustment { id: string; side: Side; amount: number; note: string; at: string }
export interface TradesDoc {
  format: 'forever-trades'
  version: 1
  savedAt?: string
  start: { A: number; H: number; at: string | null }
  batches: Batch[]
  adjustments: Adjustment[]
}

export const emptyDoc = (): TradesDoc => ({ format: 'forever-trades', version: 1, start: { A: 0, H: 0, at: null }, batches: [], adjustments: [] })

export function parseTradesDoc(text: string): TradesDoc {
  const d = JSON.parse(text)
  if (d?.format !== 'forever-trades' || d.version !== 1) throw new Error('not a trades file')
  return { ...emptyDoc(), ...d, start: { ...emptyDoc().start, ...d.start }, batches: d.batches ?? [], adjustments: d.adjustments ?? [] }
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

/** What Blackwater keeps from a transfer. */
export const transferLoss = (price: number) => Math.round(price * BLACKWATER_CUT)

export const soldQty = (b: Batch) => b.sales.reduce((s, x) => s + x.qty, 0)
export const received = (b: Batch) => b.sales.reduce((s, x) => s + x.received, 0)
export const unsoldQty = (b: Batch) => Math.max(0, b.qty - soldQty(b))
export const isFinished = (b: Batch) => b.qty > 0 && unsoldQty(b) === 0

/** Gold still in unsold items: the unsold share of the purchase price. */
export const tiedUp = (b: Batch) => (b.qty > 0 ? Math.round((b.cost * unsoldQty(b)) / b.qty) : 0)

/** Received - purchase cost of the units sold - transfer loss. For a finished batch: its profit. */
export function batchProfit(b: Batch): number {
  const loss = b.transfer ? transferLoss(b.transfer.price) : 0
  return received(b) - (b.cost - tiedUp(b)) - loss
}

export interface Totals {
  balance: Record<Side, number>
  total: number
  tiedUp: number
  /** Total gold + tied up - starting gold - adjustments = the sum of batchProfit. */
  profit: number
  openBatches: number
}

export function totals(d: TradesDoc): Totals {
  const balance: Record<Side, number> = { A: d.start.A, H: d.start.H }
  for (const a of d.adjustments) balance[a.side] += a.amount
  let tied = 0, profit = 0, open = 0
  for (const b of d.batches) {
    balance[b.side] -= b.cost
    if (b.transfer) {
      balance[b.side] += b.transfer.price - transferLoss(b.transfer.price)
      balance[other(b.side)] -= b.transfer.price
    }
    const sellSide = b.transfer ? other(b.side) : b.side
    balance[sellSide] += received(b)
    tied += tiedUp(b)
    profit += batchProfit(b)
    if (!isFinished(b)) open++
  }
  return { balance, total: balance.A + balance.H, tiedUp: tied, profit, openBatches: open }
}

export type EventKind = 'start' | 'purchase' | 'transfer' | 'sale' | 'adjustment'
export interface HistoryEvent {
  kind: EventKind
  at: string
  batch?: Batch
  sale?: Sale
  adjustment?: Adjustment
  /** Change to each side's balance. */
  delta: Partial<Record<Side, number>>
}

/** Every recorded step, newest first. */
export function history(d: TradesDoc): HistoryEvent[] {
  const ev: HistoryEvent[] = []
  if (d.start.at) ev.push({ kind: 'start', at: d.start.at, delta: { A: d.start.A, H: d.start.H } })
  for (const a of d.adjustments) ev.push({ kind: 'adjustment', at: a.at, adjustment: a, delta: { [a.side]: a.amount } })
  for (const b of d.batches) {
    ev.push({ kind: 'purchase', at: b.at, batch: b, delta: { [b.side]: -b.cost } })
    if (b.transfer) {
      const p = b.transfer.price
      ev.push({ kind: 'transfer', at: b.transfer.at, batch: b, delta: { [b.side]: p - transferLoss(p), [other(b.side)]: -p } })
    }
    const sellSide = b.transfer ? other(b.side) : b.side
    for (const s of b.sales) ev.push({ kind: 'sale', at: s.at, batch: b, sale: s, delta: { [sellSide]: s.received } })
  }
  return ev.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
}

/**
 * Money typed by the user -> copper, or null if unreadable. Accepts "12g 40s 5c", "12g40s", "40s", "5c", and a bare
 * number as gold ("12.5" = 12g 50s). A leading "-" makes it negative.
 */
export function parseMoney(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/,/g, '')
  if (!t) return null
  const neg = t.startsWith('-')
  const body = neg ? t.slice(1).trim() : t
  let c: number
  if (/^\d+(\.\d+)?$/.test(body)) c = Math.round(Number(body) * 10000)
  else {
    const m = /^(?:(\d+)\s*g)?\s*(?:(\d+)\s*s)?\s*(?:(\d+)\s*c)?$/.exec(body)
    if (!m || (!m[1] && !m[2] && !m[3])) return null
    c = Number(m[1] ?? 0) * 10000 + Number(m[2] ?? 0) * 100 + Number(m[3] ?? 0)
  }
  return neg ? -c : c
}
