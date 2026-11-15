import { describe, expect, it } from 'vitest'
import { addSales, dismiss, mergeLogs, readMailLog, setChars, suggestions, visitOk, type MailLog, type MailRecord } from './mailSales'
import { emptyDoc, ledger, parseTradesDoc, type TradesDoc } from './model'

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
  kind: 'sale', price: received, id, t: T0 + t, char: 'Xria', faction: 'Horde', visit: 'v1', item, count, received, money: received, deposit: 0, status: 'ok', src: 'invoice', ...extra,
})

/** Horde holds 20 Silk Cloth (bought on Alliance for 2g, moved over). */
function stocked(): TradesDoc {
  return setChars({
    ...emptyDoc(),
    entries: [
      { kind: 'purchase', id: 'p', at: '2026-11-14T10:00:00.000Z', item: 'Silk Cloth', qty: 20, side: 'A', cost: 20000 },
      { kind: 'transfer', id: 't', at: '2026-11-14T11:00:00.000Z', item: 'Silk Cloth', qty: 20, from: 'A', price: 30000, purchase: 'p' },
    ],
  }, ['Xria'])
}

describe('readMailLog', () => {
  it('reads records and visits as WoW saves them', () => {
    const log = readMailLog(bytes(FILE))
    expect(log.records).toHaveLength(2)
    expect(log.records[0]).toMatchObject({ id: 'Xria-1763160010-2', item: 'Small Radiant Shard', count: 1, received: 9226, money: 9259, deposit: 33, status: 'ok', faction: 'Horde' })
    expect(log.records[1]).toMatchObject({ item: 'Silk Cloth', count: 12, received: 2292 })
    expect(log.visits[0]).toMatchObject({ id: 'Xria-1763160000-1', goldIn: 11911, sales: 2, unexplained: 0, missing: 0 })
    expect(visitOk(log.visits[0])).toBe(true)
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

describe('suggestions', () => {
  const log: MailLog = {
    records: [
      rec('r1', 'Silk Cloth', 12, 2292, 100),
      rec('r2', 'silk  cloth', 6, 1100, 200), // the game's spelling may differ in case or spaces
      rec('r3', 'Silk Cloth', 5, 900, 300), // beyond the 20 held
      rec('r4', 'Soul Dust', 3, 1280, 150),
      rec('r5', 'Silk Cloth', 1, 200, 250, { char: 'SomeAlt' }), // not a trading character
      rec('r6', 'Silk Cloth', 2, 400, 260, { faction: 'Alliance', char: 'Xria' }), // Alliance holds none
    ],
    visits: [
      { id: 'v1', t0: 90, t1: 400, char: 'Xria', faction: 'Horde', goldIn: 5572, sales: 4, received: 5572, deposits: 0, other: 0, unexplained: 0, missing: 0, buys: 0, spent: 0, buyMissing: 0 },
      { id: 'v0', t0: 10, t1: 20, char: 'Xria', faction: 'Horde', goldIn: 500, sales: 0, received: 0, deposits: 0, other: 0, unexplained: 500, missing: 0, buys: 0, spent: 0, buyMissing: 0 },
      { id: 'vx', t0: 10, t1: 20, char: 'Xria', faction: 'Horde', goldIn: 100, sales: 1, received: 100, deposits: 0, other: 0, unexplained: 0, missing: 0, buys: 0, spent: 0, buyMissing: 0 },
    ],
  }

  it('groups per item and faction, ticks up to the units held', () => {
    const s = suggestions(stocked(), log)
    expect(s.tracked.map((g) => [g.item, g.side, g.records.map((r) => r.id), g.ticked])).toEqual([
      ['Silk Cloth', 'H', ['r1', 'r2', 'r3'], ['r1', 'r2']],
      ['Silk Cloth', 'A', ['r6'], []],
    ])
    expect(s.tracked[0].held).toBe(20)
    expect(s.other.map((g) => [g.item, g.ticked])).toEqual([['Soul Dust', []]])
  })
  it('leaves out other characters; lists visits with listed records or a problem', () => {
    const s = suggestions(stocked(), log)
    expect(s.tracked.flatMap((g) => g.records).some((r) => r.char === 'SomeAlt')).toBe(false)
    expect(s.visits.map((v) => v.id)).toEqual(['v0', 'v1'])
    expect(s.chars).toEqual([{ char: 'SomeAlt', faction: 'Horde' }, { char: 'Xria', faction: 'Horde' }])
  })
  it('lists nothing until a trading character is chosen', () => {
    const s = suggestions({ ...stocked(), mail: undefined }, log)
    expect(s.tracked).toEqual([])
    expect(s.chars.length).toBe(2)
  })
  it('a sale whose gold never came starts unticked and uses up no stock', () => {
    const s = suggestions(stocked(), { records: [rec('n', 'Silk Cloth', 19, 400, 50, { status: 'nogold' }), rec('k', 'Silk Cloth', 2, 400, 60)], visits: [] })
    expect(s.tracked[0].ticked).toEqual(['k'])
  })

  it('adds ticked records as one sale per item and faction, and never lists them again', () => {
    const doc = stocked()
    const s = suggestions(doc, log)
    let n = 0
    const next = addSales(doc, [...s.tracked, ...s.other], new Set(['r1', 'r2', 'r4']), () => `new${++n}`)
    const sales = next.entries.filter((e) => e.kind === 'sale')
    expect(sales).toEqual([
      { kind: 'sale', id: 'new1', at: new Date((T0 + 200) * 1000).toISOString(), item: 'Silk Cloth', side: 'H', qty: 18, received: 3392, mail: ['r1', 'r2'] },
      { kind: 'sale', id: 'new2', at: new Date((T0 + 150) * 1000).toISOString(), item: 'Soul Dust', side: 'H', qty: 3, received: 1280, mail: ['r4'] },
    ])
    const after = suggestions(next, log)
    expect(after.tracked.flatMap((g) => g.records.map((r) => r.id))).toEqual(['r3', 'r6'])
    // Horde now holds 2, and r3 sold 5: it stays unticked.
    expect(after.tracked[0].held).toBe(2)
    expect(after.tracked[0].ticked).toEqual([])
    expect(after.other).toEqual([])
    // A deleted imported sale doesn't come back.
    const deleted = { ...next, entries: next.entries.filter((e) => e.id !== 'new1') }
    expect(suggestions(deleted, log).tracked.flatMap((g) => g.records.map((r) => r.id))).toEqual(['r3', 'r6'])
    // The ledger counts them like typed sales.
    expect(ledger(next).items.find((i) => i.key === 'silk cloth')!.received).toBe(3392)
  })
  it('dismiss hides records and visits', () => {
    const s = suggestions(dismiss(stocked(), ['r4', 'v0']), log)
    expect(s.other).toEqual([])
    expect(s.visits.map((v) => v.id)).toEqual(['v1'])
  })
  it('purchases: ticked for known items, a new item is left unticked; added as purchase cards', () => {
    const buy = (id: string, item: string, count: number, price: number, t: number, extra: Partial<MailRecord> = {}) =>
      rec(id, item, count, 0, t, { kind: 'buy', price, ...extra })
    const log2: MailLog = { records: [
      buy('b1', 'Silk Cloth', 20, 4000, 10), buy('b2', 'Silk Cloth', 20, 4200, 20),
      buy('b3', 'Pristine Leather', 100, 31066, 30),
      buy('b4', 'Silk Cloth', 20, 4000, 40, { status: 'noitem' }),
    ], visits: [] }
    const s = suggestions(stocked(), log2)
    expect(s.tracked).toEqual([])
    expect(s.buys.map((g) => [g.kind, g.item, g.side, g.ticked])).toEqual([
      ['buy', 'Silk Cloth', 'H', ['b1', 'b2']],
      ['buy', 'Pristine Leather', 'H', []],
    ])
    let n = 0
    const next = addSales(stocked(), s.buys, new Set(['b1', 'b2', 'b3']), () => `n${++n}`)
    const added = next.entries.filter((e) => e.kind === 'purchase' && e.mail)
    expect(added).toEqual([
      { kind: 'purchase', id: 'n1', at: new Date((T0 + 20) * 1000).toISOString(), item: 'Silk Cloth', side: 'H', qty: 40, cost: 8200, mail: ['b1', 'b2'] },
      { kind: 'purchase', id: 'n2', at: new Date((T0 + 30) * 1000).toISOString(), item: 'Pristine Leather', side: 'H', qty: 100, cost: 31066, mail: ['b3'] },
    ])
    expect(suggestions(next, log2).buys.flatMap((g) => g.records.map((r) => r.id))).toEqual(['b4'])
  })
  it('reads purchase records and visit purchase figures', () => {
    const f = FILE.replace('["sales"] = 2,', '["sales"] = 2, ["buys"] = 1, ["spent"] = 31066, ["buyMissing"] = 1,')
      .replace('["received"] = 2292,', '["kind"] = "buy", ["received"] = 2292,')
      .replace('["status"] = "ok",\n["cut"] = 120,', '["status"] = "noitem", ["cut"] = 120,')
    const log = readMailLog(bytes(f))
    expect(log.records[0].kind).toBe('sale')
    expect(log.records[1]).toMatchObject({ kind: 'buy', price: 2412, status: 'noitem' })
    expect(log.visits[0]).toMatchObject({ buys: 1, spent: 31066, buyMissing: 1 })
    expect(visitOk(log.visits[0])).toBe(false)
  })
  it('the mail settings survive saving and loading', () => {
    const doc = dismiss(stocked(), ['r4'])
    const back = parseTradesDoc(JSON.stringify(doc))
    expect(back.mail).toEqual({ chars: ['Xria'], handled: ['r4'] })
    expect(parseTradesDoc(JSON.stringify(emptyDoc())).mail).toBeUndefined()
  })
})
