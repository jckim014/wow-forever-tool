// Cross-faction trade tracker: the data (one JSON document) and every figure the page shows. Money in copper.
//
// No batches (Josh, 2026-11-14: matching sales to purchases was unwieldy). Purchases, transfers and sales are separate
// entries, each naming an item and a quantity. The page keeps one stock pool per item and faction, with a running
// average cost:
// - a purchase adds its units and gold to the pool of the faction it was bought on;
// - a transfer moves units, with their share of the pool's cost, to the other faction's pool. The sending side lists
//   them on Blackwater at the transfer price and receives that minus 15%; the other side pays the transfer price. The
//   15% counts as a cost of the item at once;
// - a sale takes units out at the pool's average cost; its profit = gold received (in the mailbox, after the AH cut)
//   - that cost.
// Entries are applied in time order. Taking more units than a pool holds is allowed but flagged (the extra units cost
// nothing). Adjustments change a balance for anything outside the trades and never count as trading profit.

export type Side = 'A' | 'H'
export const other = (s: Side): Side => (s === 'A' ? 'H' : 'A')
export const SIDE_NAME: Record<Side, string> = { A: 'Alliance', H: 'Horde' }
export const BLACKWATER_CUT = 0.15

interface EntryBase { id: string; at: string; item: string; qty: number }
/** `mail`: the BavvbScan log records it was added from (mailSales.ts); typed purchases have none. */
export interface Purchase extends EntryBase { kind: 'purchase'; side: Side; cost: number; mail?: string[] }
/** `purchase`: the purchase this transfer moved units of (made from its card; a purchase can be moved in several
 *  parts); a free transfer has none. */
export interface Transfer extends EntryBase { kind: 'transfer'; from: Side; price: number; purchase?: string; mail?: string[] }
/** `mail`: the BavvbScan sales-log records it was added from (mailSales.ts); typed sales have none. */
export interface Sale extends EntryBase { kind: 'sale'; side: Side; received: number; mail?: string[] }
export type Entry = Purchase | Transfer | Sale
export type EntryKind = Entry['kind']

export interface Adjustment { id: string; side: Side; amount: number; note: string; at: string }
export interface TradesDoc {
  format: 'forever-trades'
  version: 2
  savedAt?: string
  start: { A: number; H: number; at: string | null }
  entries: Entry[]
  adjustments: Adjustment[]
  /** Sales from the mailbox (mailSales.ts): the trading characters, and the log records / visits added or dismissed. */
  mail?: { chars: string[]; handled: string[]; roles?: Record<string, 'trader' | 'transfer' | 'none'> }
}

export const emptyDoc = (): TradesDoc => ({ format: 'forever-trades', version: 2, start: { A: 0, H: 0, at: null }, entries: [], adjustments: [] })

/** Version 1 (batches): each batch becomes its purchase, its transfer (all units) and its sales. */
interface V1Batch {
  id: string; item: string; qty: number; side: Side; cost: number; at: string
  transfer: { price: number; at: string } | null
  sales: { id: string; qty: number; received: number; at: string }[]
}
function fromV1(batches: V1Batch[]): Entry[] {
  const out: Entry[] = []
  for (const b of batches) {
    out.push({ kind: 'purchase', id: b.id, at: b.at, item: b.item, qty: b.qty, side: b.side, cost: b.cost })
    if (b.transfer) out.push({ kind: 'transfer', id: `${b.id}-t`, at: b.transfer.at, item: b.item, qty: b.qty, from: b.side, price: b.transfer.price, purchase: b.id })
    const sellSide = b.transfer ? other(b.side) : b.side
    for (const s of b.sales) out.push({ kind: 'sale', id: s.id, at: s.at, item: b.item, qty: s.qty, side: sellSide, received: s.received })
  }
  return out
}

export function parseTradesDoc(text: string): TradesDoc {
  const d = JSON.parse(text)
  if (d?.format !== 'forever-trades' || (d.version !== 1 && d.version !== 2)) throw new Error('not a trades file')
  const entries: Entry[] = d.version === 1 ? fromV1(d.batches ?? []) : d.entries ?? []
  return { format: 'forever-trades', version: 2, savedAt: d.savedAt, start: { ...emptyDoc().start, ...d.start }, entries, adjustments: d.adjustments ?? [], ...(d.mail ? { mail: { chars: d.mail.chars ?? [], handled: d.mail.handled ?? [], ...(d.mail.roles ? { roles: d.mail.roles } : {}) } } : {}) }
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

/** What Blackwater keeps from a transfer. */
export const transferLoss = (price: number) => Math.round(price * BLACKWATER_CUT)

/** Items are matched by name, ignoring case and extra spaces. */
export const itemKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

export interface Stock { units: number; cost: number }
export interface ItemSummary {
  key: string
  name: string
  stock: Record<Side, Stock>
  /** All purchases of the item: units and gold spent (for the average buy price). */
  boughtUnits: number
  boughtCost: number
  soldUnits: number
  received: number
  /** Purchase cost of the units sold (at the average when sold). */
  costOfSold: number
  transferLoss: number
  /** received - costOfSold - transferLoss */
  profit: number
  lastAt: string
}
export interface Ledger {
  items: ItemSummary[]
  /** Entry id -> units it took beyond what the pool held at the time. */
  short: Record<string, number>
  /** Sale id -> its profit (received - cost of its units). */
  saleProfit: Record<string, number>
}

/** Entries in the order they are applied: by time, then as recorded. */
export const ordered = (entries: Entry[]) =>
  entries.map((e, i) => ({ e, i })).sort((x, y) => (x.e.at < y.e.at ? -1 : x.e.at > y.e.at ? 1 : x.i - y.i)).map((x) => x.e)

/** Takes qty units out of a pool at its average cost; returns that cost and the units it was short. */
function take(p: Stock, qty: number): { cost: number; short: number } {
  const n = Math.min(qty, p.units)
  const cost = n <= 0 ? 0 : n === p.units ? p.cost : Math.round((p.cost * n) / p.units)
  p.units -= Math.max(0, n)
  p.cost -= cost
  return { cost, short: qty - Math.max(0, n) }
}

export function ledger(d: TradesDoc): Ledger {
  const items = new Map<string, ItemSummary>()
  const short: Record<string, number> = {}
  const saleProfit: Record<string, number> = {}
  for (const e of ordered(d.entries)) {
    const key = itemKey(e.item)
    let it = items.get(key)
    if (!it) {
      it = { key, name: e.item.trim(), stock: { A: { units: 0, cost: 0 }, H: { units: 0, cost: 0 } }, boughtUnits: 0, boughtCost: 0, soldUnits: 0, received: 0, costOfSold: 0, transferLoss: 0, profit: 0, lastAt: e.at }
      items.set(key, it)
    }
    it.lastAt = e.at
    if (e.kind === 'purchase') {
      it.stock[e.side].units += e.qty
      it.stock[e.side].cost += e.cost
      it.boughtUnits += e.qty
      it.boughtCost += e.cost
    } else if (e.kind === 'transfer') {
      const t = take(it.stock[e.from], e.qty)
      if (t.short) short[e.id] = t.short
      it.stock[other(e.from)].units += e.qty
      it.stock[other(e.from)].cost += t.cost
      it.transferLoss += transferLoss(e.price)
    } else {
      const t = take(it.stock[e.side], e.qty)
      if (t.short) short[e.id] = t.short
      it.soldUnits += e.qty
      it.received += e.received
      it.costOfSold += t.cost
      saleProfit[e.id] = e.received - t.cost
    }
  }
  for (const it of items.values()) it.profit = it.received - it.costOfSold - it.transferLoss
  return { items: [...items.values()], short, saleProfit }
}

/** Units of an item a faction holds now (all entries applied). */
export function onHand(d: TradesDoc, item: string, side: Side): Stock {
  const it = ledger(d).items.find((x) => x.key === itemKey(item))
  return it ? it.stock[side] : { units: 0, cost: 0 }
}

/** The transfers made from a purchase's card (each moves part or all of its units). */
export const transfersOf = (d: TradesDoc, p: Purchase) =>
  d.entries.filter((e): e is Transfer => e.kind === 'transfer' && e.purchase === p.id)

/** Units of a purchase not yet moved by its card transfers. */
export const leftToTransfer = (d: TradesDoc, p: Purchase) => p.qty - transfersOf(d, p).reduce((n, t) => n + t.qty, 0)

/**
 * Purchases still waiting for transfer, oldest first: some of their units not yet moved from the card, and the faction
 * they were bought on still holds some of the item (so a purchase moved or sold some other way drops out by itself).
 */
export function awaitingTransfer(d: TradesDoc, l: Ledger = ledger(d)): Purchase[] {
  const held = new Map(l.items.map((it) => [it.key, it.stock]))
  const moved = movedFromCards(d)
  return ordered(d.entries).filter((e): e is Purchase => e.kind === 'purchase' && e.qty - (moved.get(e.id) ?? 0) > 0 && (held.get(itemKey(e.item))?.[e.side].units ?? 0) > 0)
}

/** Units moved from each purchase's card by its transfers, in one pass (leftToTransfer per card would go over all
 *  entries for every card: ~1.4 s a year in). */
export function movedFromCards(d: TradesDoc): Map<string, number> {
  const moved = new Map<string, number>()
  for (const e of d.entries) if (e.kind === 'transfer' && e.purchase) moved.set(e.purchase, (moved.get(e.purchase) ?? 0) + e.qty)
  return moved
}

/** Change to each side's balance from one entry. */
export function entryDelta(e: Entry): Partial<Record<Side, number>> {
  if (e.kind === 'purchase') return { [e.side]: -e.cost }
  if (e.kind === 'transfer') return { [e.from]: e.price - transferLoss(e.price), [other(e.from)]: -e.price }
  return { [e.side]: e.received }
}

export interface Totals {
  balance: Record<Side, number>
  total: number
  /** Purchase cost of the units still held. */
  tiedUp: number
  /** Total gold + tied up - starting gold - adjustments = the sum of the items' profit. */
  profit: number
  itemsInStock: number
}

export function totals(d: TradesDoc, l: Ledger = ledger(d)): Totals {
  const balance: Record<Side, number> = { A: d.start.A, H: d.start.H }
  for (const a of d.adjustments) balance[a.side] += a.amount
  for (const e of d.entries) for (const [s, v] of Object.entries(entryDelta(e)) as [Side, number][]) balance[s] += v
  let tied = 0, profit = 0, inStock = 0
  for (const it of l.items) {
    tied += it.stock.A.cost + it.stock.H.cost
    profit += it.profit
    if (it.stock.A.units > 0 || it.stock.H.units > 0) inStock++
  }
  return { balance, total: balance.A + balance.H, tiedUp: tied, profit, itemsInStock: inStock }
}

export type EventKind = 'start' | EntryKind | 'adjustment'
export interface HistoryEvent {
  kind: EventKind
  at: string
  entry?: Entry
  adjustment?: Adjustment
  /** Change to each side's balance. */
  delta: Partial<Record<Side, number>>
}

/** Every recorded step, newest first. */
export function history(d: TradesDoc): HistoryEvent[] {
  const ev: HistoryEvent[] = []
  if (d.start.at) ev.push({ kind: 'start', at: d.start.at, delta: { A: d.start.A, H: d.start.H } })
  for (const a of d.adjustments) ev.push({ kind: 'adjustment', at: a.at, adjustment: a, delta: { [a.side]: a.amount } })
  ordered(d.entries).forEach((e) => ev.push({ kind: e.kind, at: e.at, entry: e, delta: entryDelta(e) }))
  // Newest first; equal times keep the reverse of the applied order.
  return ev.map((x, i) => ({ x, i })).sort((a, b) => (a.x.at < b.x.at ? 1 : a.x.at > b.x.at ? -1 : b.i - a.i)).map((a) => a.x)
}

/** An ISO time -> its local calendar day, "YYYY-MM-DD". */
export const localDay = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface HistoryDay {
  /** Local day, "YYYY-MM-DD". */
  day: string
  /** That day's events, newest first. */
  events: HistoryEvent[]
  /** Change to each side's balance that day (starting gold left out). */
  delta: Record<Side, number>
  /** Trading profit made that day: its sales' profit minus Blackwater's cut on its transfers. */
  profit: number
  /** The day has sales or transfers (else there is no profit to show). */
  trades: boolean
}

/** History grouped by local day, newest day first (Josh, 2026-11-14: the flat list got too long). */
export function historyDays(events: HistoryEvent[], l: Ledger, dayOf: (iso: string) => string = localDay): HistoryDay[] {
  const days = new Map<string, HistoryDay>()
  for (const e of events) {
    const day = dayOf(e.at)
    let d = days.get(day)
    if (!d) { d = { day, events: [], delta: { A: 0, H: 0 }, profit: 0, trades: false }; days.set(day, d) }
    d.events.push(e)
    if (e.kind !== 'start') for (const [s, v] of Object.entries(e.delta) as [Side, number][]) d.delta[s] += v
    const en = e.entry
    if (en?.kind === 'sale') { d.profit += l.saleProfit[en.id] ?? 0; d.trades = true }
    if (en?.kind === 'transfer') { d.profit -= transferLoss(en.price); d.trades = true }
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
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
