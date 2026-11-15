import { describe, expect, it } from 'vitest'
import { awaitingTransfer, leftToTransfer, emptyDoc, history, ledger, parseMoney, parseTradesDoc, totals, type Entry, type TradesDoc, historyDays } from './model'

const g = 10000
const at = (h: number) => `2026-11-14T${String(h).padStart(2, '0')}:00:00.000Z`

function doc(...entries: Entry[]): TradesDoc {
  const d = emptyDoc()
  d.start = { A: 1000 * g, H: 1000 * g, at: at(1) }
  d.entries = entries
  return d
}
// The worked example agreed with Josh: 1,000g each side; 200 Boar Meat bought on Alliance for 100g, transferred at 100g.
const buy: Entry = { kind: 'purchase', id: 'p', at: at(2), item: 'Boar Meat', qty: 200, side: 'A', cost: 100 * g }
const move: Entry = { kind: 'transfer', id: 't', at: at(3), item: 'Boar Meat', qty: 200, from: 'A', price: 100 * g }
const sale = (id: string, h: number, qty: number, rec: number, item = 'Boar Meat'): Entry => ({ kind: 'sale', id, at: at(h), item, qty, side: 'H', received: rec * g })

const identity = (d: TradesDoc) => {
  const t = totals(d)
  const adj = d.adjustments.reduce((s, a) => s + a.amount, 0)
  expect(t.profit).toBe(t.total + t.tiedUp - d.start.A - d.start.H - adj)
}

describe('trade tracker figures', () => {
  it('match the agreed example when everything has sold', () => {
    const d = doc(buy, move, sale('s', 4, 200, 142.5))
    const t = totals(d)
    expect(t.balance).toEqual({ A: 985 * g, H: 1042.5 * g })
    expect(t.total).toBe(2027.5 * g)
    expect(t.tiedUp).toBe(0)
    expect(t.profit).toBe(27.5 * g)
    expect(t.itemsInStock).toBe(0)
  })

  it('count unsold units as tied up at their average cost', () => {
    const d = doc(buy, move, sale('s1', 4, 80, 55), sale('s2', 5, 40, 32.3))
    const l = ledger(d)
    expect(l.items[0].stock).toEqual({ A: { units: 0, cost: 0 }, H: { units: 80, cost: 40 * g } })
    expect(l.saleProfit).toEqual({ s1: 15 * g, s2: 12.3 * g })
    const t = totals(d)
    expect(t.balance).toEqual({ A: 985 * g, H: 987.3 * g })
    expect(t.profit).toBe(87.3 * g - 60 * g - 15 * g)
    identity(d)
  })

  it('average overlapping purchases without batches', () => {
    const d = doc(
      buy, move,
      { kind: 'purchase', id: 'p2', at: at(4), item: 'boar  meat', qty: 100, side: 'A', cost: 140 * g },
      { kind: 'transfer', id: 't2', at: at(5), item: 'Boar Meat', qty: 100, from: 'A', price: 140 * g },
      sale('s', 6, 150, 200),
    )
    const it = ledger(d).items
    expect(it).toHaveLength(1) // name matched ignoring case and spaces
    // Horde pool: 300 units for 240g (0.8g each); 150 sold -> 120g cost.
    expect(it[0].stock.H).toEqual({ units: 150, cost: 120 * g })
    expect(it[0].costOfSold).toBe(120 * g)
    expect(it[0].transferLoss).toBe(36 * g)
    expect(it[0].profit).toBe(200 * g - 120 * g - 36 * g)
    // Average buy: 240g over 300 units bought, whatever has moved or sold since.
    expect([it[0].boughtUnits, it[0].boughtCost]).toEqual([300, 240 * g])
    identity(d)
  })

  it('apply entries in time order, whatever order they were typed', () => {
    const d = doc(sale('s', 6, 100, 80), move, buy)
    expect(ledger(d).short).toEqual({})
    expect(ledger(d).saleProfit.s).toBe(30 * g)
  })

  it('flag taking more than is held, counting the extra units at no cost', () => {
    const d = doc(buy, move, sale('s', 4, 250, 150))
    const l = ledger(d)
    expect(l.short).toEqual({ s: 50 })
    expect(l.items[0].stock.H).toEqual({ units: 0, cost: 0 })
    expect(l.saleProfit.s).toBe(50 * g)
    identity(d)
  })

  it('keep adjustments out of the profit', () => {
    const d = doc(buy, move)
    d.adjustments.push({ id: 'a', side: 'H', amount: 50 * g, note: 'quest gold', at: at(6) })
    const t = totals(d)
    expect(t.balance.H).toBe(950 * g)
    expect(t.profit).toBe(-15 * g) // only the transfer loss so far
    identity(d)
  })

  it('list the history newest first with each side\'s change', () => {
    const d = doc(buy, move, sale('s', 4, 10, 7))
    expect(history(d).map((e) => [e.kind, e.delta])).toEqual([
      ['sale', { H: 7 * g }],
      ['transfer', { A: 85 * g, H: -100 * g }],
      ['purchase', { A: -100 * g }],
      ['start', { A: 1000 * g, H: 1000 * g }],
    ])
  })

  it('read a version 1 (batches) file as entries', () => {
    const v1 = {
      format: 'forever-trades', version: 1, savedAt: at(9), start: { A: 1000 * g, H: 1000 * g, at: at(1) }, adjustments: [],
      batches: [
        { id: 'b', item: 'Boar Meat', qty: 200, side: 'A', cost: 100 * g, at: at(2), transfer: { price: 100 * g, at: at(3) }, sales: [{ id: 's', qty: 200, received: 142.5 * g, at: at(4) }] },
        { id: 'c', item: 'Linen Cloth', qty: 20, side: 'H', cost: 2 * g, at: at(5), transfer: null, sales: [] },
      ],
    }
    const d = parseTradesDoc(JSON.stringify(v1))
    expect(d.version).toBe(2)
    expect(d.entries[1]).toMatchObject({ kind: 'transfer', purchase: 'b' })
    expect(awaitingTransfer(d).map((e) => e.item)).toEqual(['Linen Cloth'])
    expect(d.entries.map((e) => [e.kind, e.item, e.qty])).toEqual([
      ['purchase', 'Boar Meat', 200], ['transfer', 'Boar Meat', 200], ['sale', 'Boar Meat', 200], ['purchase', 'Linen Cloth', 20],
    ])
    const t = totals(d)
    expect(t.profit).toBe(27.5 * g)
    expect(t.tiedUp).toBe(2 * g)
    identity(d)
  })

  it('list purchases waiting for their transfer', () => {
    const p2: Entry = { kind: 'purchase', id: 'p2', at: at(4), item: 'Runecloth', qty: 20, side: 'A', cost: 10 * g }
    const p3: Entry = { kind: 'purchase', id: 'p3', at: at(5), item: 'Linen Cloth', qty: 5, side: 'A', cost: 1 * g }
    const free: Entry = { kind: 'transfer', id: 't3', at: at(6), item: 'Linen Cloth', qty: 5, from: 'A', price: 1 * g }
    expect(awaitingTransfer(doc(buy, p2)).map((e) => e.id)).toEqual(['p', 'p2'])
    // p: moved from its card; p3: moved by a free transfer (Alliance holds none left).
    expect(awaitingTransfer(doc(buy, { ...move, purchase: 'p' } as Entry, p2, p3, free)).map((e) => e.id)).toEqual(['p2'])
  })

  it('keep a purchase waiting until all its units are moved from its card', () => {
    const p2 = { kind: 'purchase', id: 'p2', at: at(4), item: 'Runecloth', qty: 20, side: 'A', cost: 10 * g } as const
    const part1: Entry = { kind: 'transfer', id: 'x1', at: at(5), item: 'Runecloth', qty: 8, from: 'A', price: 4 * g, purchase: 'p2' }
    const part2: Entry = { kind: 'transfer', id: 'x2', at: at(6), item: 'Runecloth', qty: 12, from: 'A', price: 6 * g, purchase: 'p2' }
    const d1 = doc(p2, part1)
    expect(leftToTransfer(d1, p2)).toBe(12)
    expect(awaitingTransfer(d1).map((e) => e.id)).toEqual(['p2'])
    expect(ledger(d1).items[0].stock).toEqual({ A: { units: 12, cost: 6 * g }, H: { units: 8, cost: 4 * g } })
    const d2 = doc(p2, part1, part2)
    expect(leftToTransfer(d2, p2)).toBe(0)
    expect(awaitingTransfer(d2)).toEqual([])
    identity(d2)
  })

  it('read money as typed', () => {
    expect(parseMoney('12g 40s 5c')).toBe(124005)
    expect(parseMoney('12g40s')).toBe(124000)
    expect(parseMoney('40s')).toBe(4000)
    expect(parseMoney('12.5')).toBe(125000)
    expect(parseMoney('1,250')).toBe(12500000)
    expect(parseMoney('-50g')).toBe(-500000)
    expect(parseMoney('abc')).toBeNull()
    expect(parseMoney('')).toBeNull()
  })
})

describe('historyDays', () => {
  it('groups by day, newest first, with each day\'s gold change and trading profit', () => {
    const d: TradesDoc = {
      ...emptyDoc(), start: { A: 1000, H: 0, at: '2026-11-12T08:00:00.000Z' },
      entries: [
        { kind: 'purchase', id: 'p', at: '2026-11-12T10:00:00.000Z', item: 'Silk', qty: 10, side: 'A', cost: 1000 },
        { kind: 'transfer', id: 't', at: '2026-11-13T10:00:00.000Z', item: 'Silk', qty: 10, from: 'A', price: 2000, purchase: 'p' },
        { kind: 'sale', id: 's', at: '2026-11-13T12:00:00.000Z', item: 'Silk', qty: 10, side: 'H', received: 3000 },
      ],
      adjustments: [{ id: 'a', side: 'A', amount: -50, note: 'repairs', at: '2026-11-13T13:00:00.000Z' }],
    }
    const days = historyDays(history(d), ledger(d), (iso) => iso.slice(0, 10))
    expect(days.map((x) => [x.day, x.events.map((e) => e.kind), x.delta, x.profit, x.trades])).toEqual([
      // transfer: Alliance +2000 - 300, Horde -2000; sale: Horde +3000; adjustment: Alliance -50.
      // profit: the sale made 3000 - 1000 = 2000, Blackwater kept 300.
      ['2026-11-13', ['adjustment', 'sale', 'transfer'], { A: 1650, H: 1000 }, 1700, true],
      ['2026-11-12', ['purchase', 'start'], { A: -1000, H: 0 }, 0, false],
    ])
    expect(days.reduce((n, x) => n + x.profit, 0)).toBe(totals(d).profit)
  })
})
