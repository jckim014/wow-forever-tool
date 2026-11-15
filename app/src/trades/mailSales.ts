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
import { BLACKWATER_CUT, GOLD_ITEM, awaitingTransfer, itemKey, movedFromCards, onHand, other, type Entry, type GoldSent, type Side, type TradesDoc } from './model'

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
  /** The character's GUID and name as shown in game (addon 2026-11-14 on; older records have neither: `char` is only
   *  the first word of the name, which Xria Two, Xria Forever and Xria Blacksmith share). */
  guid?: string
  full?: string
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
  guid?: string
  full?: string
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
      ...(str(field(x, 'guid')) ? { guid: str(field(x, 'guid')) } : {}), ...(str(field(x, 'full')) ? { full: str(field(x, 'full')) } : {}),
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
    ...(str(field(x, 'guid')) ? { guid: str(field(x, 'guid')) } : {}), ...(str(field(x, 'full')) ? { full: str(field(x, 'full')) } : {}),
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

/** Records older than this many days are ignored (the addon keeps 60), and handled ids older than FORGET_DAYS dropped. */
export const IGNORE_DAYS = 70
export const FORGET_DAYS = 75
/** The time in an addon id ("<char>-<unix time>-<counter>"), or null for an id of another shape. */
export const idTime = (id: string) => { const m = /-(\d{9,})-\d+$/.exec(id); return m ? Number(m[1]) : null }

/**
 * Who made a record or visit: the character's GUID; for an older record (no GUID) the GUID of the only character with
 * that short name on that faction, or "name|faction" when there is none or several.
 */
/** `pair`: "name|faction" when this character is the only one of that short name and faction (a role set on its older
 *  records before it had a GUID still applies). */
export interface Who { key: string; name: string; faction: string; pair?: string }
export function whoFinder(log: MailLog) {
  const guids = new Map<string, Set<string>>()
  const names = new Map<string, string>()
  for (const x of [...log.records, ...log.visits]) {
    if (!x.guid) continue
    const pair = `${x.char}|${x.faction}`
    guids.set(pair, (guids.get(pair) ?? new Set()).add(x.guid))
    if (x.full) names.set(x.guid, x.full)
  }
  return (x: { char: string; faction: string; guid?: string }): Who => {
    const pair = `${x.char}|${x.faction}`
    const only = guids.get(pair)?.size === 1 ? [...guids.get(pair)!][0] : undefined
    const key = x.guid ?? only ?? pair
    return { key, name: names.get(key) ?? x.char, faction: x.faction, ...(only && key === only ? { pair } : {}) }
  }
}

/**
 * The role set for a character (by its key). Before keys, roles were per short name and the "trading characters" list
 * named traders: those still count, but only for a name that belongs to a single character in the log.
 */
export function roleOf(doc: TradesDoc, who: Who, single: (name: string) => boolean): Role | undefined {
  const set = doc.mail?.roles?.[who.key] ?? (who.pair ? doc.mail?.roles?.[who.pair] : undefined)
  if (set) return set
  const short = who.key.includes('|') ? who.key.split('|')[0] : undefined
  const legacy = (n: string) => doc.mail?.roles?.[n] ?? (doc.mail?.chars?.includes(n) ? 'trader' : undefined)
  for (const n of [short, who.name.split(' ')[0]]) {
    if (n && single(n)) { const r = legacy(n); if (r) return r }
  }
  return undefined
}

export interface LookItem { record: MailRecord; reason: string }

export interface Plan {
  /** The document with every automatic entry added and its records marked handled. */
  doc: TradesDoc
  /** doc differs from the one given (something to save: entries added or a seller's gold matched). */
  changed: boolean
  added: { purchases: number; transfers: number; sales: number; gold: number }
  /** Transfer halves whose other half hasn't been collected yet (or never will be: someone else bought it). */
  waiting: MailRecord[]
  /** Records that need Josh's decision: Add or Dismiss. */
  look: LookItem[]
  /** Visits of the trading characters with a problem, or with records listed here, not yet dismissed. */
  visits: MailVisit[]
  /** Characters seen in the log, with their faction and role. */
  chars: { key: string; name: string; faction: string; role: Role | undefined }[]
  /** Who made a record or visit (key and display name). */
  who: (x: { char: string; faction: string; guid?: string }) => Who
}

const isoOf = (t: number) => new Date(t * 1000).toISOString()

/** Blackwater keeps 15% of the listing price: the cut on the sending side's sale should match (to 1%, at least 2c). */
export const blackwaterCutOk = (r: MailRecord) =>
  r.cut === null || Math.abs(r.cut - r.price * BLACKWATER_CUT) <= Math.max(2, r.price * 0.01)

/**
 * Everything the mailbox log adds by itself, given the roles:
 * 1. trader purchases -> purchase entries (one per item, faction and mailbox visit: a card each);
 * 2. transfers: a transfer character's Blackwater purchase -> a transfer from the other faction at the price paid, at
 *    once, applied to that item's oldest waiting purchase cards first (split across cards when it spans several; the
 *    rest is a free transfer); the selling side's Blackwater sale is matched to it later and its 15% cut checked;
 * 3. trader sales -> sale entries (one per item, faction and visit) while the tracker holds the units on that faction.
 * Anything amber, a sale beyond the stock or of an item the tracker doesn't know, and a Blackwater cut that isn't 15%
 * goes to `look`. Pure; tested.
 */
export function plan(doc0: TradesDoc, log: MailLog, newId: () => string, now = Date.now() / 1000): Plan {
  const handled = new Set(doc0.mail?.handled ?? [])
  // The addon keeps 60 days of records; anything older than 70 days is left alone here (so a record dropped from the
  // handled list below can never come back as new), and handled ids older than 75 days are dropped.
  const fresh = (t: number) => t >= now - IGNORE_DAYS * 86400
  const look: LookItem[] = []
  const added = { purchases: 0, transfers: 0, sales: 0, gold: 0 }
  const done: string[] = []
  let doc = doc0
  const push = (es: Entry[]) => { doc = { ...doc, entries: [...doc.entries, ...es] } }
  const names = () => new Map(doc.entries.map((e) => [itemKey(e.item), e.item.trim()]))

  const who = whoFinder(log)
  const keysOf = new Map<string, Set<string>>()
  for (const x of [...log.records, ...log.visits]) {
    const w = who(x)
    keysOf.set(x.char, (keysOf.get(x.char) ?? new Set()).add(w.key))
  }
  const single = (name: string) => (keysOf.get(name)?.size ?? 0) <= 1
  const role = (x: { char: string; faction: string; guid?: string }) => roleOf(doc0, who(x), single)
  const open = log.records.filter((r) => {
    if (!fresh(r.t)) return false
    if (handled.has(r.id) || !sideOf(r.faction)) return false
    const rl = role(r)
    return rl === 'trader' || rl === 'transfer'
  })
  const ok: MailRecord[] = []
  for (const r of open) {
    if (r.status === 'nogold') look.push({ record: r, reason: 'the mail went but no matching gold came' })
    else if (r.status === 'noitem') look.push({ record: r, reason: "the mail went but its items didn't reach the bags" })
    else ok.push(r)
  }
  const trader = (r: MailRecord) => role(r) === 'trader'

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

  // 2. transfers. The receiving side's won mail is the transfer (Josh, 2026-11-14: the seller's gold can sit in the
  // mailbox for hours, and with strict roles a transfer character's Blackwater purchase is always a transfer): it is
  // added at once, from the other faction, at the price paid. The sending side's Blackwater sale, whenever it is
  // collected, is matched to it (same item, quantity and price) and its 15% cut checked; a sale with no such transfer
  // waits (the buyer hasn't collected yet, or a stranger bought the listing).
  const log2 = new Map(log.records.map((r) => [r.id, r]))
  // Gold sent (Josh, 2026-11-14): a transfer character buying GOLD_ITEM on Blackwater pays gold to the other faction
  // (whose transfer character listed it). Recorded at once, like a transfer, but with no item or stock.
  const isGold = (r: MailRecord) => itemKey(r.item) === itemKey(GOLD_ITEM)
  for (const rcv of ok.filter((r) => !trader(r) && r.kind === 'buy' && isGold(r))) {
    const g: GoldSent = { id: newId(), at: isoOf(rcv.t), to: other(sideOf(rcv.faction)!), price: rcv.price, mail: [rcv.id] }
    doc = { ...doc, gold: [...(doc.gold ?? []), g] }
    added.gold++
    done.push(rcv.id)
  }
  for (const rcv of ok.filter((r) => !trader(r) && r.kind === 'buy' && !isGold(r))) {
    const from = other(sideOf(rcv.faction)!)
    const item = names().get(itemKey(rcv.item)) ?? rcv.item
    // Oldest waiting cards of this item on the sending side first.
    let left = rcv.count
    const parts: { qty: number; purchase?: string }[] = []
    const moved = movedFromCards(doc)
    for (const p of awaitingTransfer(doc)) {
      if (left <= 0) break
      if (p.side !== from || itemKey(p.item) !== itemKey(item)) continue
      const n = Math.min(left, p.qty - (moved.get(p.id) ?? 0))
      if (n > 0) { parts.push({ qty: n, purchase: p.id }); left -= n }
    }
    if (left > 0) parts.push({ qty: left })
    let priceLeft = rcv.price
    parts.forEach((pt, k) => {
      const price = k === parts.length - 1 ? priceLeft : Math.round((rcv.price * pt.qty) / rcv.count)
      priceLeft -= price
      push([{ kind: 'transfer', id: newId(), at: isoOf(rcv.t), item, qty: pt.qty, from, price, ...(pt.purchase ? { purchase: pt.purchase } : {}), mail: [rcv.id] }])
    })
    added.transfers++
    done.push(rcv.id)
  }
  const waiting: MailRecord[] = []
  for (const snd of ok.filter((r) => !trader(r) && r.kind === 'sale')) {
    const from = sideOf(snd.faction)!
    if (isGold(snd)) {
      // The listing side's gold: matched to gold sent to it for the same price.
      const g = (doc.gold ?? []).find((x) => {
        if (x.to !== from || x.mail?.length !== 1) return false
        const r = log2.get(x.mail[0])
        return !!r && r.kind === 'buy' && r.count === snd.count && r.price === snd.price
      })
      if (!g) { waiting.push(snd); continue }
      if (!blackwaterCutOk(snd)) { look.push({ record: snd, reason: `Blackwater took ${snd.cut}c, not 15% of the price: check this gold sent` }); continue }
      doc = { ...doc, gold: doc.gold!.map((x) => (x.id === g.id ? { ...x, mail: [x.mail![0], snd.id] } : x)) }
      done.push(snd.id)
      continue
    }
    // A transfer from this side made from a won mail of the same item, quantity and price, not yet matched to a sale.
    const match = doc.entries.find((e) => {
      if (e.kind !== 'transfer' || e.from !== from || !e.mail || e.mail.length !== 1) return false
      const r = log2.get(e.mail[0])
      return !!r && r.kind === 'buy' && itemKey(r.item) === itemKey(snd.item) && r.count === snd.count && r.price === snd.price
    })
    if (!match) { waiting.push(snd); continue }
    // A wrong cut leaves the sale for Josh (and the transfer unmatched, so the same holds on the next pass).
    if (!blackwaterCutOk(snd)) { look.push({ record: snd, reason: `Blackwater took ${snd.cut}c, not 15% of the price: check this transfer` }); continue }
    const rcvId = match.mail![0]
    doc = { ...doc, entries: doc.entries.map((e) => (e.kind === 'transfer' && e.mail?.length === 1 && e.mail[0] === rcvId ? { ...e, mail: [rcvId, snd.id] } : e)) }
    done.push(snd.id)
  }

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
  const kept = mailOf(doc).handled.filter((id) => { const t = idTime(id); return t === null || t >= now - FORGET_DAYS * 86400 })
  if (kept.length !== mailOf(doc).handled.length) doc = { ...doc, mail: { ...mailOf(doc), handled: kept } }
  const listed = new Set([...waiting, ...look.map((l) => l.record)].map((r) => r.visit))
  const seen = new Map<string, Who>()
  for (const x of [...log.records, ...log.visits]) { const w = who(x); seen.set(w.key, w) }
  const trading = (x: MailVisit) => { const r = role(x); return r === 'trader' || r === 'transfer' }
  return {
    doc, changed: doc !== doc0, added, waiting, look: look.sort((a, b) => a.record.t - b.record.t),
    visits: log.visits.filter((v) => fresh(v.t0) && !handled.has(v.id) && trading(v) && (listed.has(v.id) || !visitOk(v))).reverse(),
    chars: [...seen.values()].map((w) => ({ key: w.key, name: w.name, faction: w.faction, role: roleOf(doc0, w, single) }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.faction.localeCompare(b.faction)),
    who,
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

/** Sets a character's role, by its key (see whoFinder). */
export function setRole(doc: TradesDoc, key: string, role: Role): TradesDoc {
  const m = mailOf(doc)
  return { ...doc, mail: { ...m, roles: { ...(m.roles ?? {}), [key]: role } } }
}
