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
import { BLACKWATER_CUT, awaitingTransfer, itemKey, leftToTransfer, onHand, other, type Entry, type Side, type TradesDoc } from './model'

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
  /** AH cut taken from a sale (copper), null for purchases. */
  cut: number | null
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
      cut: typeof field(x, 'cut') === 'number' ? (field(x, 'cut') as number) : null,
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

/**
 * A character's part in the trades (Josh, 2026-11-14; roles are strict):
 * - trader: buys and sells on its own faction's auction house (Xfaction on Alliance, Xria Two on Horde);
 * - transfer: lists on and buys from Blackwater (Jeder Hillmont on Alliance, Horde Xria on Horde);
 * - none: not part of the trades (its mail is ignored).
 * Mails between a faction's own characters don't change the faction's stock, so they don't matter here.
 */
export type Role = 'trader' | 'transfer' | 'none'

/** The role set for a character; characters ticked under the earlier "trading characters" list count as traders. */
export const roleOf = (doc: TradesDoc, char: string): Role | undefined =>
  doc.mail?.roles?.[char] ?? (doc.mail?.chars?.includes(char) ? 'trader' : undefined)

export interface LookItem { record: MailRecord; reason: string }

export interface Plan {
  /** The document with every automatic entry added and its records marked handled. */
  doc: TradesDoc
  added: { purchases: number; transfers: number; sales: number }
  /** Transfer halves whose other half hasn't been collected yet (or never will be: someone else bought it). */
  waiting: MailRecord[]
  /** Records that need Josh's decision: Add or Dismiss. */
  look: LookItem[]
  /** Visits of the trading characters with a problem, or with records listed here, not yet dismissed. */
  visits: MailVisit[]
  /** Characters seen in the log, with their faction and role. */
  chars: { char: string; faction: string; role: Role | undefined }[]
}

const isoOf = (t: number) => new Date(t * 1000).toISOString()

/** Blackwater keeps 15% of the listing price: the cut on the sending side's sale should match (to 1%, at least 2c). */
export const blackwaterCutOk = (r: MailRecord) =>
  r.cut === null || Math.abs(r.cut - r.price * BLACKWATER_CUT) <= Math.max(2, r.price * 0.01)

/**
 * Everything the mailbox log adds by itself, given the roles:
 * 1. trader purchases -> purchase entries (one per item, faction and mailbox visit: a card each);
 * 2. transfers: a transfer character's Blackwater sale + the other faction's transfer character's Blackwater purchase of
 *    the same item, quantity and price -> a transfer from the selling side, at the purchase's time, applied to that
 *    item's oldest waiting purchase cards first (split across cards when it spans several; the rest is a free transfer);
 * 3. trader sales -> sale entries (one per item, faction and visit) while the tracker holds the units on that faction.
 * Anything amber, a sale beyond the stock or of an item the tracker doesn't know, and a Blackwater cut that isn't 15%
 * goes to `look`. Pure; tested.
 */
export function plan(doc0: TradesDoc, log: MailLog, newId: () => string): Plan {
  const handled = new Set(doc0.mail?.handled ?? [])
  const look: LookItem[] = []
  const added = { purchases: 0, transfers: 0, sales: 0 }
  const done: string[] = []
  let doc = doc0
  const push = (es: Entry[]) => { doc = { ...doc, entries: [...doc.entries, ...es] } }
  const names = () => new Map(doc.entries.map((e) => [itemKey(e.item), e.item.trim()]))

  const open = log.records.filter((r) => {
    if (handled.has(r.id) || !sideOf(r.faction)) return false
    const role = roleOf(doc0, r.char)
    return role === 'trader' || role === 'transfer'
  })
  const ok: MailRecord[] = []
  for (const r of open) {
    if (r.status === 'nogold') look.push({ record: r, reason: 'the mail went but no matching gold came' })
    else if (r.status === 'noitem') look.push({ record: r, reason: "the mail went but its items didn't reach the bags" })
    else ok.push(r)
  }
  const trader = (r: MailRecord) => roleOf(doc0, r.char) === 'trader'

  // 1. purchases
  const groups = new Map<string, MailRecord[]>()
  for (const r of ok.filter((x) => trader(x) && x.kind === 'buy')) {
    const k = `${itemKey(r.item)}|${r.faction}|${r.visit}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  for (const rs of groups.values()) {
    const known = names().get(itemKey(rs[0].item))
    push([{
      kind: 'purchase', id: newId(), at: isoOf(Math.max(...rs.map((r) => r.t))), item: known ?? rs[0].item, side: sideOf(rs[0].faction)!,
      qty: rs.reduce((n, r) => n + r.count, 0), cost: rs.reduce((n, r) => n + r.price, 0), mail: rs.map((r) => r.id),
    }])
    added.purchases++
    done.push(...rs.map((r) => r.id))
  }

  // 2. transfers
  const sends = ok.filter((r) => !trader(r) && r.kind === 'sale')
  const receives = ok.filter((r) => !trader(r) && r.kind === 'buy')
  const paired = new Set<string>()
  for (const snd of sends) {
    const from = sideOf(snd.faction)!
    const rcv = receives.find((x) => !paired.has(x.id) && sideOf(x.faction) === other(from) && itemKey(x.item) === itemKey(snd.item)
      && x.count === snd.count && x.price === snd.price)
    if (!rcv) continue
    paired.add(snd.id).add(rcv.id)
    if (!blackwaterCutOk(snd)) {
      look.push({ record: snd, reason: `Blackwater took ${snd.cut}c, not 15% of the price` }, { record: rcv, reason: 'its other half has a Blackwater cut that isn\'t 15%' })
      continue
    }
    const item = names().get(itemKey(snd.item)) ?? snd.item
    const at = isoOf(Math.max(snd.t, rcv.t))
    // Oldest waiting cards of this item on the sending side first.
    let left = snd.count
    const parts: { qty: number; purchase?: string }[] = []
    for (const p of awaitingTransfer(doc)) {
      if (left <= 0) break
      if (p.side !== from || itemKey(p.item) !== itemKey(item)) continue
      const n = Math.min(left, leftToTransfer(doc, p))
      if (n > 0) { parts.push({ qty: n, purchase: p.id }); left -= n }
    }
    if (left > 0) parts.push({ qty: left })
    let priceLeft = snd.price
    parts.forEach((pt, i) => {
      const price = i === parts.length - 1 ? priceLeft : Math.round((snd.price * pt.qty) / snd.count)
      priceLeft -= price
      push([{ kind: 'transfer', id: newId(), at, item, qty: pt.qty, from, price, ...(pt.purchase ? { purchase: pt.purchase } : {}), mail: [snd.id, rcv.id] }])
    })
    added.transfers++
    done.push(snd.id, rcv.id)
  }
  const waiting = [...sends, ...receives].filter((r) => !paired.has(r.id)).sort((a, b) => a.t - b.t)

  // 3. sales, in time order, while the faction holds the units
  const sales = new Map<string, MailRecord[]>()
  const used = new Map<string, number>()
  for (const r of ok.filter((x) => trader(x) && x.kind === 'sale')) {
    const side = sideOf(r.faction)!
    const known = names().get(itemKey(r.item))
    if (!known) { look.push({ record: r, reason: 'not in your tracker' }); continue }
    const uk = `${itemKey(r.item)}|${side}`
    const held = onHand(doc, known, side).units - (used.get(uk) ?? 0)
    if (r.count > held) { look.push({ record: r, reason: `more than ${side === 'A' ? 'Alliance' : 'Horde'} holds (${Math.max(0, held)})` }); continue }
    used.set(uk, (used.get(uk) ?? 0) + r.count)
    const k = `${uk}|${r.visit}`
    sales.set(k, [...(sales.get(k) ?? []), r])
  }
  for (const rs of sales.values()) {
    push([{
      kind: 'sale', id: newId(), at: isoOf(Math.max(...rs.map((r) => r.t))), item: names().get(itemKey(rs[0].item))!, side: sideOf(rs[0].faction)!,
      qty: rs.reduce((n, r) => n + r.count, 0), received: rs.reduce((n, r) => n + r.received, 0), mail: rs.map((r) => r.id),
    }])
    added.sales++
    done.push(...rs.map((r) => r.id))
  }

  if (done.length) doc = { ...doc, mail: { ...mailOf(doc), handled: [...mailOf(doc).handled, ...done] } }
  const listed = new Set([...waiting, ...look.map((l) => l.record)].map((r) => r.visit))
  const seen = new Map<string, string>()
  for (const r of log.records) seen.set(r.char, r.faction)
  for (const v of log.visits) seen.set(v.char, v.faction)
  const trading = (c: string) => { const r = roleOf(doc0, c); return r === 'trader' || r === 'transfer' }
  return {
    doc, added, waiting, look: look.sort((a, b) => a.record.t - b.record.t),
    visits: log.visits.filter((v) => !handled.has(v.id) && trading(v.char) && (listed.has(v.id) || !visitOk(v))).reverse(),
    chars: [...seen].map(([char, faction]) => ({ char, faction, role: roleOf(doc0, char) })).sort((a, b) => a.char.localeCompare(b.char)),
  }
}

/** A visit all accounted for: every gold rise matched a mail, no sale mail left without its gold, and no won mail
 *  left without its items. */
export const visitOk = (v: MailVisit) => v.unexplained === 0 && v.missing === 0 && v.buyMissing === 0

const mailOf = (doc: TradesDoc) => ({ chars: doc.mail?.chars ?? [], handled: doc.mail?.handled ?? [], ...(doc.mail?.roles ? { roles: doc.mail.roles } : {}) })

/** Adds one record as it is (a sale or a purchase), for "Add" on a record that needed a look or never got its other half. */
export function addRecord(doc: TradesDoc, r: MailRecord, newId: () => string): TradesDoc {
  const item = doc.entries.find((e) => itemKey(e.item) === itemKey(r.item))?.item.trim() ?? r.item
  const base = { id: newId(), at: isoOf(r.t), item, side: sideOf(r.faction)!, qty: r.count, mail: [r.id] }
  const e: Entry = r.kind === 'buy' ? { ...base, kind: 'purchase', cost: r.price } : { ...base, kind: 'sale', received: r.received }
  const m = mailOf(doc)
  return { ...doc, entries: [...doc.entries, e], mail: { ...m, handled: [...m.handled, r.id] } }
}

/** Hides records or visits for good without adding anything. */
export function dismiss(doc: TradesDoc, ids: string[]): TradesDoc {
  const m = mailOf(doc)
  return { ...doc, mail: { ...m, handled: [...m.handled, ...ids] } }
}

export function setRole(doc: TradesDoc, char: string, role: Role): TradesDoc {
  const m = mailOf(doc)
  return { ...doc, mail: { ...m, roles: { ...(m.roles ?? {}), [char]: role } } }
}
