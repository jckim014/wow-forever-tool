import { describe, expect, it } from 'vitest'
import { addRecord, dismiss, mergeLogs, plan, readMailLog, setRole, visitOk, type MailLog, type MailRecord } from './mailSales'
import { emptyDoc, leftToTransfer, ledger, parseTradesDoc, type Purchase, type TradesDoc, type Transfer } from './model'

/** BavvbScan.lua as WoW writes SavedVariables, with a scan and a sales log. */
const FILE = `
BavvbScanDB = {
["lastRequest"] = 1763150000,
["scan"] = {
["format"] = "bavvbscan",
["items"] = {
[2589] = "20:1000",
},
},
["sales"] = {
["visits"] = {
{
["goldIn"] = 11911,
["t1"] = 1763160100,
["faction"] = "Horde",
["deposits"] = 393,
["received"] = 11518,
["realm"] = "CAMWOW US1 Realm 3 PvE",
["char"] = "Xria",
["id"] = "Xria-1763160000-1",
["sales"] = 2,
["t0"] = 1763160000,
["other"] = 0,
["unexplained"] = 0,
["missing"] = 0,
["goldOut"] = 0,
}, -- [1]
},
["format"] = "bavvbsales",
["records"] = {
{
["received"] = 9226,
["deposit"] = 33,
["char"] = "Xria",
["src"] = "invoice",
["count"] = 1,
["id"] = "Xria-1763160010-2",
["status"] = "ok",
["cut"] = 485,
["item"] = "Small Radiant Shard",
["realm"] = "CAMWOW US1 Realm 3 PvE",
["money"] = 9259,
["price"] = 9711,
["faction"] = "Horde",
["visit"] = "Xria-1763160000-1",
["t"] = 1763160010,
}, -- [1]
{
["received"] = 2292,
["deposit"] = 360,
["char"] = "Xria",
["src"] = "invoice",
["count"] = 12,
["id"] = "Xria-1763160020-3",
["status"] = "ok",
["cut"] = 120,
["item"] = "Silk Cloth",
["realm"] = "CAMWOW US1 Realm 3 PvE",
["money"] = 2652,
["price"] = 2412,
["faction"] = "Horde",
["visit"] = "Xria-1763160000-1",
["t"] = 1763160020,
}, -- [2]
},
["version"] = 1,
["next"] = 4,
},
}
`
/** Times in the tests are seconds after this (after the purchase and transfer below). */
const T0 = Date.parse('2026-11-14T12:00:00Z') / 1000
const bytes = (s: string) => new TextEncoder().encode(s)

const rec = (id: string, item: string, count: number, received: number, t: number, extra: Partial<MailRecord> = {}): MailRecord => ({
  kind: 'sale', price: received, id, t: T0 + t, char: 'Xria', faction: 'Horde', visit: 'v1', item, count, received, money: received,
  deposit: 0, status: 'ok', src: 'invoice', cut: null, ...extra,
})
const buy = (id: string, char: string, faction: string, item: string, count: number, price: number, t: number, extra: Partial<MailRecord> = {}) =>
  rec(id, item, count, 0, t, { kind: 'buy', price, char, faction, ...extra })
/** A Blackwater listing sold: price, the 15% cut and what came in the mail. */
const bwSale = (id: string, char: string, faction: string, item: string, count: number, price: number, t: number, cut = Math.round(price * 0.15)) =>
  rec(id, item, count, price - cut, t, { price, cut, char, faction })

/** Josh's chain: Xfaction trades on Alliance, Jeder and Horde move goods through Blackwater, Xria trades on Horde. */
function roles(doc: TradesDoc = emptyDoc()): TradesDoc {
  let d = setRole(doc, 'Xfaction', 'trader')
  d = setRole(d, 'Jeder', 'transfer')
  d = setRole(d, 'Horde', 'transfer')
  d = setRole(d, 'Xria', 'trader')
  return setRole(d, 'Bavvb', 'none')
}
let n = 0
const id = () => `e${++n}`
const of = <K extends string>(d: TradesDoc, kind: K) => d.entries.filter((e) => e.kind === kind)

describe('readMailLog', () => {
  it('reads records and visits as WoW saves them', () => {
    const log = readMailLog(bytes(FILE))
    expect(log.records).toHaveLength(2)
    expect(log.records[0]).toMatchObject({ kind: 'sale', id: 'Xria-1763160010-2', item: 'Small Radiant Shard', count: 1, received: 9226, money: 9259, deposit: 33, cut: 485, price: 9711, status: 'ok', faction: 'Horde' })
    expect(log.records[1]).toMatchObject({ item: 'Silk Cloth', count: 12, received: 2292 })
    expect(log.visits[0]).toMatchObject({ id: 'Xria-1763160000-1', goldIn: 11911, sales: 2, unexplained: 0, missing: 0 })
    expect(visitOk(log.visits[0])).toBe(true)
  })
  it('reads purchase records and visit purchase figures', () => {
    const f = FILE.replace('["sales"] = 2,', '["sales"] = 2, ["buys"] = 1, ["spent"] = 31066, ["buyMissing"] = 1,')
      .replace('["received"] = 2292,', '["kind"] = "buy", ["received"] = 2292,')
      .replace('["status"] = "ok",\n["cut"] = 120,', '["status"] = "noitem", ["cut"] = 120,')
    const log = readMailLog(bytes(f))
    expect(log.records[1]).toMatchObject({ kind: 'buy', price: 2412, status: 'noitem' })
    expect(log.visits[0]).toMatchObject({ buys: 1, spent: 31066, buyMissing: 1 })
    expect(visitOk(log.visits[0])).toBe(false)
  })
  it('a file with only a scan has no sales', () => {
    expect(readMailLog(bytes('BavvbScanDB = {\n["scan"] = {\n},\n}\n'))).toEqual({ records: [], visits: [] })
  })
  it('rejects other files', () => {
    expect(() => readMailLog(bytes('AuctionatorData = {}'))).toThrow('No BavvbScanDB')
  })
  it('merges two accounts\' files, each record once', () => {
    const a = readMailLog(bytes(FILE))
    const b: MailLog = { records: [rec('Other-1', 'Linen Cloth', 5, 100, 1763150000 - T0, { char: 'Bavvb', faction: 'Alliance' }), a.records[0]], visits: [] }
    const m = mergeLogs([a, b])
    expect(m.records.map((r) => r.id)).toEqual(['Other-1', 'Xria-1763160010-2', 'Xria-1763160020-3'])
  })
})

describe('plan (roles)', () => {
  // The whole chain once: Xfaction buys 40 Silk Cloth; Jeder lists 20 on Blackwater twice; Horde Xria has bought the
  // first 20 so far; Xria Two sells 12, then 10 (more than Horde holds until the second 20 arrive).
  const log: MailLog = {
    records: [
      buy('b1', 'Xfaction', 'Alliance', 'Silk Cloth', 40, 8000, 10, { visit: 'va' }),
      bwSale('s1', 'Jeder', 'Alliance', 'Silk Cloth', 20, 6000, 20),
      buy('r1', 'Horde', 'Horde', 'silk cloth', 20, 6000, 25),
      bwSale('s2', 'Jeder', 'Alliance', 'Silk Cloth', 20, 6000, 30),
      rec('x1', 'Silk Cloth', 12, 3000, 40, { visit: 'vh' }),
      rec('x2', 'Silk Cloth', 10, 2500, 50, { visit: 'vh' }),
      rec('x3', 'Red Linen Bag', 1, 328, 55, { char: 'Xfaction', faction: 'Alliance' }),
      buy('n1', 'Xfaction', 'Alliance', 'Iron Ore', 5, 500, 56, { status: 'noitem' }),
      rec('o1', 'Silk Cloth', 1, 100, 57, { char: 'Bavvb', faction: 'Alliance' }),
      rec('u1', 'Silk Cloth', 1, 100, 58, { char: 'Stranger', faction: 'Alliance' }),
    ],
    visits: [],
  }

  it('adds purchases, paired transfers and covered sales by itself; leaves the rest', () => {
    const p = plan(roles(), log, id)
    expect(p.added).toEqual({ purchases: 1, transfers: 1, sales: 1 })
    const [card] = of(p.doc, 'purchase') as Purchase[]
    expect(card).toMatchObject({ item: 'Silk Cloth', side: 'A', qty: 40, cost: 8000, mail: ['b1'] })
    const [t] = of(p.doc, 'transfer') as Transfer[]
    expect(t).toMatchObject({ item: 'Silk Cloth', from: 'A', qty: 20, price: 6000, purchase: card.id, mail: ['s1', 'r1'], at: new Date((T0 + 25) * 1000).toISOString() })
    expect(leftToTransfer(p.doc, card)).toBe(20)
    expect(of(p.doc, 'sale')).toMatchObject([{ item: 'Silk Cloth', side: 'H', qty: 12, received: 3000, mail: ['x1'] }])
    expect(p.waiting.map((r) => r.id)).toEqual(['s2'])
    expect(p.look.map((l) => [l.record.id, l.reason])).toEqual([
      ['x2', 'more than Horde holds (8)'],
      ['x3', 'not in your tracker'],
      ['n1', "the mail went but its items didn't reach the bags"],
    ])
    // Characters without a role, or marked "none", are ignored.
    expect([...p.waiting, ...p.look.map((l) => l.record)].some((r) => r.id === 'o1' || r.id === 'u1')).toBe(false)
    expect(p.chars.find((c) => c.char === 'Stranger')?.role).toBeUndefined()
    // It settles: a second pass adds nothing.
    expect(plan(p.doc, log, id).added).toEqual({ purchases: 0, transfers: 0, sales: 0 })
    // Figures: Alliance spent 80s, got 51s back from Blackwater (60s - 15%); Horde paid 60s and received 30s.
    expect(ledger(p.doc).items[0]).toMatchObject({ soldUnits: 12, received: 3000, transferLoss: 900 })
  })

  it('the second half arriving later completes the transfer, and the held-back sale follows', () => {
    const first = plan(roles(), log, id).doc
    const later = { ...log, records: [...log.records, buy('r2', 'Horde', 'Horde', 'Silk Cloth', 20, 6000, 60)] }
    const p = plan(first, later, id)
    expect(p.added).toEqual({ purchases: 0, transfers: 1, sales: 1 })
    const card = of(p.doc, 'purchase')[0] as Purchase
    expect(leftToTransfer(p.doc, card)).toBe(0)
    expect(p.waiting).toEqual([])
    expect(p.look.map((l) => l.record.id)).toEqual(['x3', 'n1'])
  })

  it('a transfer spanning two cards is split between them; the rest is a free transfer', () => {
    const lg: MailLog = { records: [
      buy('b1', 'Xfaction', 'Alliance', 'Silk Cloth', 15, 3000, 1, { visit: 'a1' }),
      buy('b2', 'Xfaction', 'Alliance', 'Silk Cloth', 10, 2000, 2, { visit: 'a2' }),
      bwSale('s', 'Jeder', 'Alliance', 'Silk Cloth', 30, 9000, 3),
      buy('r', 'Horde', 'Horde', 'Silk Cloth', 30, 9000, 4),
    ], visits: [] }
    const p = plan(roles(), lg, id)
    const ts = of(p.doc, 'transfer') as Transfer[]
    const cards = of(p.doc, 'purchase') as Purchase[]
    expect(ts.map((t) => [t.qty, t.price, t.purchase])).toEqual([[15, 4500, cards[0].id], [10, 3000, cards[1].id], [5, 1500, undefined]])
    expect(p.added.transfers).toBe(1)
  })

  it('a Blackwater cut that isn\'t 15% needs a look (both halves)', () => {
    const lg: MailLog = { records: [
      bwSale('s', 'Jeder', 'Alliance', 'Iron Bar', 5, 1000, 1, 50),
      buy('r', 'Horde', 'Horde', 'Iron Bar', 5, 1000, 2),
    ], visits: [] }
    const p = plan(roles(), lg, id)
    expect(p.added.transfers).toBe(0)
    expect(p.look.map((l) => l.record.id)).toEqual(['s', 'r'])
  })

  it('halves only pair across factions with the same item, quantity and price', () => {
    const lg: MailLog = { records: [
      bwSale('s', 'Jeder', 'Alliance', 'Iron Bar', 5, 1000, 1),
      buy('r1', 'Horde', 'Horde', 'Iron Bar', 4, 1000, 2),
      buy('r2', 'Horde', 'Horde', 'Iron Bar', 5, 999, 3),
      buy('r3', 'Horde', 'Horde', 'Gold Bar', 5, 1000, 4),
    ], visits: [] }
    const p = plan(roles(), lg, id)
    expect(p.added.transfers).toBe(0)
    expect(p.waiting.map((r) => r.id)).toEqual(['s', 'r1', 'r2', 'r3'])
  })

  it('Add and Dismiss take a record out for good', () => {
    const p = plan(roles(), log, id)
    let d = addRecord(p.doc, p.look[1].record, id) // the Red Linen Bag, as a sale
    expect(of(d, 'sale').at(-1)).toMatchObject({ item: 'Red Linen Bag', side: 'A', qty: 1, received: 328, mail: ['x3'] })
    d = addRecord(d, p.waiting[0], id) // a stranger bought the second Blackwater listing
    expect(of(d, 'sale').at(-1)).toMatchObject({ item: 'Silk Cloth', side: 'A', qty: 20, received: 5100 })
    d = dismiss(d, ['n1'])
    const after = plan(d, log, id)
    expect(after.waiting).toEqual([])
    expect(after.look.map((l) => l.record.id)).toEqual(['x2'])
  })

  it('characters ticked under the earlier "trading characters" list count as traders', () => {
    const old: TradesDoc = { ...emptyDoc(), mail: { chars: ['Xria'], handled: [] } }
    const p = plan(old, { records: [buy('b', 'Xria', 'Horde', 'Pristine Leather', 100, 31066, 1)], visits: [] }, id)
    expect(of(p.doc, 'purchase')).toMatchObject([{ item: 'Pristine Leather', side: 'H', qty: 100, cost: 31066 }])
  })

  it('roles and handled records survive saving and loading', () => {
    const doc = dismiss(roles(), ['r4'])
    const back = parseTradesDoc(JSON.stringify(doc))
    expect(back.mail).toEqual({ chars: [], handled: ['r4'], roles: { Xfaction: 'trader', Jeder: 'transfer', Horde: 'transfer', Xria: 'trader', Bavvb: 'none' } })
    expect(parseTradesDoc(JSON.stringify(emptyDoc())).mail).toBeUndefined()
  })
})
