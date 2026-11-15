// Sales and purchases from the mailbox: BavvbScan's sales log (addon/BavvbScan/Sales.lua) -> sale and purchase entries
// for the trade tracker.
//
// The addon records each auction sale when its money reaches the character's gold, each auction purchase when its
// items reach the bags (records), and one line per mailbox visit (visits). Here they become suggestions: grouped per
// kind, item and faction. Sales are ticked when the tracker holds the item on that faction (up to the units held, in
// time order); purchases are ticked when the tracker already knows the item (a new item is Josh's call); the rest
// start unticked. Josh adds what he ticks; every
// record he adds or dismisses is remembered in the trades file (doc.mail.handled), so it never comes back. Only
// records from his trading characters (doc.mail.chars) are listed. Pure; tested.
import { field, indexOf, Reader, type Lua } from '../prices/auctioneer'
import { itemKey, onHand, type Side, type TradesDoc } from './model'

export interface MailRecord {
  /** "buy": an auction won (price = total paid); "sale" (older records have no kind: sales). */
  kind: 'sale' | 'buy'
  id: string
  /** Unix seconds: when the money reached the gold (or the mail left, for "nogold"). */
  t: number
  char: string
  faction: string
  visit: string
  item: string
  count: number
  /** Gold received for the sale: sale price - AH cut (the deposit coming back is left out). */
  received: number
  /** Gold in the mail (received + the deposit returned). */
  money: number
  deposit: number | null
  /** Sale price (sales) or total paid (purchases), whole stack. */
  price: number
  /** "ok": its money reached the gold (sale) / its items reached the bags (purchase). "nogold" / "noitem": the mail
   *  left without that. */
  status: 'ok' | 'nogold' | 'noitem'
  /** "subject": only the mail subject could be read (deposit unknown, received = money). */
  src: 'invoice' | 'subject'
}

export interface MailVisit {
  id: string
  t0: number
  t1: number
  char: string
  faction: string
  goldIn: number
  sales: number
  received: number
  deposits: number
  other: number
  unexplained: number
  missing: number
  buys: number
  spent: number
  buyMissing: number
}

export interface MailLog { records: MailRecord[]; visits: MailVisit[] }

const str = (v: Lua | undefined) => (typeof v === 'string' ? v : '')
const num = (v: Lua | undefined) => (typeof v === 'number' ? v : 0)

/** BavvbScan.lua -> its sales log (empty if the addon hasn't recorded any yet). */
export function readMailLog(raw: Uint8Array): MailLog {
  const start = indexOf(raw, 'BavvbScanDB')
  if (start < 0) throw new Error('No BavvbScanDB in this file. Is it BavvbScan.lua from SavedVariables?')
  const r = new Reader(raw, true)
  r.i = raw.indexOf(123, start)
  if (r.i < 0) return { records: [], visits: [] }
  const sales = field(r.table(), 'sales')
  if (!sales || typeof sales !== 'object') return { records: [], visits: [] }
  if (field(sales, 'format') !== 'bavvbsales' || field(sales, 'version') !== 1) {
    throw new Error(`BavvbScan.lua holds a sales log in format ${String(field(sales, 'format'))} version ${String(field(sales, 'version'))}; this page reads version 1.`)
  }
  const list = (k: string) => {
    const t = field(sales, k)
    return t && typeof t === 'object' ? t.list.filter((x) => x && typeof x === 'object') : []
  }
  const records = list('records').map((x): MailRecord => {
    const deposit = field(x, 'deposit')
    const status = field(x, 'status')
    return {
      kind: field(x, 'kind') === 'buy' ? 'buy' : 'sale', price: num(field(x, 'price')),
      id: str(field(x, 'id')), t: num(field(x, 't')), char: str(field(x, 'char')), faction: str(field(x, 'faction')),
      visit: str(field(x, 'visit')), item: str(field(x, 'item')), count: num(field(x, 'count')) || 1,
      received: num(field(x, 'received')), money: num(field(x, 'money')),
      deposit: typeof deposit === 'number' ? deposit : null,
      status: status === 'ok' ? 'ok' : status === 'noitem' ? 'noitem' : 'nogold',
      src: field(x, 'src') === 'subject' ? 'subject' : 'invoice',
    }
  }).filter((x) => x.id && x.item)
  const visits: MailVisit[] = list('visits').map((x) => ({
    id: str(field(x, 'id')), t0: num(field(x, 't0')), t1: num(field(x, 't1')), char: str(field(x, 'char')),
    faction: str(field(x, 'faction')), goldIn: num(field(x, 'goldIn')), sales: num(field(x, 'sales')),
    received: num(field(x, 'received')), deposits: num(field(x, 'deposits')), other: num(field(x, 'other')),
    unexplained: num(field(x, 'unexplained')), missing: num(field(x, 'missing')),
    buys: num(field(x, 'buys')), spent: num(field(x, 'spent')), buyMissing: num(field(x, 'buyMissing')),
  })).filter((x) => x.id)
  return { records, visits }
}

/** Several files (one per WoW account) -> one log, each record once. */
export function mergeLogs(logs: MailLog[]): MailLog {
  const r = new Map<string, MailRecord>(), v = new Map<string, MailVisit>()
  for (const l of logs) {
    for (const x of l.records) r.set(x.id, x)
    for (const x of l.visits) v.set(x.id, x)
  }
  return { records: [...r.values()].sort((a, b) => a.t - b.t), visits: [...v.values()].sort((a, b) => a.t0 - b.t0) }
}

export const sideOf = (faction: string): Side | null => (faction === 'Alliance' ? 'A' : faction === 'Horde' ? 'H' : null)

export interface Suggestion {
  kind: 'sale' | 'buy'
  /** kind + itemKey + side */
  key: string
  /** The tracker's own spelling when it knows the item, else the game's. */
  item: string
  side: Side
  /** The tracker has entries for this item. */
  tracked: boolean
  /** Units the faction holds in the tracker now. */
  held: number
  records: MailRecord[]
  /** Record ids ticked by default. */
  ticked: string[]
}

export interface Suggestions {
  /** Sales of items the tracker knows (tracked = true), newest first. */
  tracked: Suggestion[]
  /** Other sales from the trading characters. */
  other: Suggestion[]
  /** Purchases, newest first (known items first). */
  buys: Suggestion[]
  /** Visits with records listed here, or with a problem, not yet dismissed. */
  visits: MailVisit[]
  /** Characters seen in the log, with their faction. */
  chars: { char: string; faction: string }[]
}

/** The mailbox records not yet added or dismissed, grouped per item and faction, with default ticks. */
export function suggestions(doc: TradesDoc, log: MailLog): Suggestions {
  const handled = new Set(doc.mail?.handled ?? [])
  const chars = new Set(doc.mail?.chars ?? [])
  const names = new Map(doc.entries.map((e) => [itemKey(e.item), e.item.trim()]))
  const groups = new Map<string, Suggestion>()
  for (const r of log.records) {
    const side = sideOf(r.faction)
    if (!side || handled.has(r.id) || !chars.has(r.char)) continue
    const k = itemKey(r.item)
    const key = `${r.kind}|${k}|${side}`
    let g = groups.get(key)
    if (!g) {
      const known = names.get(k)
      g = { kind: r.kind, key, item: known ?? r.item, side, tracked: known !== undefined, held: known ? onHand(doc, known, side).units : 0, records: [], ticked: [] }
      groups.set(key, g)
    }
    g.records.push(r)
  }
  for (const g of groups.values()) {
    if (g.kind === 'buy') {
      if (g.tracked) g.ticked.push(...g.records.filter((r) => r.status === 'ok').map((r) => r.id))
      continue
    }
    // Ticked in time order while the faction still holds units; a sale beyond that is left for Josh (and so is every
    // later one), as is one whose gold never came (it uses up no units).
    let left = g.held
    for (const r of g.records) {
      if (r.status !== 'ok') continue
      if (r.count <= left) {
        g.ticked.push(r.id)
        left -= r.count
      } else left = 0
    }
  }
  const newest = (g: Suggestion) => g.records[g.records.length - 1].t
  const all = [...groups.values()].sort((a, b) => newest(b) - newest(a))
  const shown = new Set(all.flatMap((g) => g.records.map((r) => r.visit)))
  const seen = new Map<string, string>()
  for (const r of log.records) seen.set(r.char, r.faction)
  for (const v of log.visits) seen.set(v.char, v.faction)
  return {
    tracked: all.filter((g) => g.kind === 'sale' && g.tracked),
    other: all.filter((g) => g.kind === 'sale' && !g.tracked),
    buys: [...all.filter((g) => g.kind === 'buy' && g.tracked), ...all.filter((g) => g.kind === 'buy' && !g.tracked)],
    visits: log.visits.filter((v) => !handled.has(v.id) && chars.has(v.char) && (shown.has(v.id) || !visitOk(v))).reverse(),
    chars: [...seen].map(([char, faction]) => ({ char, faction })).sort((a, b) => a.char.localeCompare(b.char)),
  }
}

/** A visit all accounted for: every gold rise matched a mail, no sale mail left without its gold, and no won mail
 *  left without its items. */
export const visitOk = (v: MailVisit) => v.unexplained === 0 && v.missing === 0 && v.buyMissing === 0

/**
 * Adds the chosen records as sale and purchase entries (one per kind, item and faction: quantity and gold summed, at
 * the latest record's time) and marks them handled. `ids`: the record ids ticked.
 */
export function addSales(doc: TradesDoc, groups: Suggestion[], ids: Set<string>, newId: () => string): TradesDoc {
  const entries = [...doc.entries]
  const done: string[] = []
  for (const g of groups) {
    const rs = g.records.filter((r) => ids.has(r.id))
    if (!rs.length) continue
    const base = {
      id: newId(), at: new Date(Math.max(...rs.map((r) => r.t)) * 1000).toISOString(), item: g.item, side: g.side,
      qty: rs.reduce((n, r) => n + r.count, 0), mail: rs.map((r) => r.id),
    }
    entries.push(g.kind === 'buy'
      ? { ...base, kind: 'purchase', cost: rs.reduce((n, r) => n + r.price, 0) }
      : { ...base, kind: 'sale', received: rs.reduce((n, r) => n + r.received, 0) })
    done.push(...rs.map((r) => r.id))
  }
  return { ...doc, entries, mail: { chars: doc.mail?.chars ?? [], handled: [...(doc.mail?.handled ?? []), ...done] } }
}

/** Hides records or visits for good without adding anything. */
export function dismiss(doc: TradesDoc, ids: string[]): TradesDoc {
  return { ...doc, mail: { chars: doc.mail?.chars ?? [], handled: [...(doc.mail?.handled ?? []), ...ids] } }
}

export function setChars(doc: TradesDoc, chars: string[]): TradesDoc {
  return { ...doc, mail: { handled: doc.mail?.handled ?? [], chars } }
}
