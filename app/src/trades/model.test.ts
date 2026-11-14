import { describe, expect, it } from 'vitest'
import { batchProfit, emptyDoc, history, parseMoney, tiedUp, totals, type Batch, type TradesDoc } from './model'

const g = 10000
const at = (h: number) => `2026-11-14T${String(h).padStart(2, '0')}:00:00.000Z`

function example(): TradesDoc {
  // The worked example agreed with Josh: 1,000g each side; 100g bought on Alliance, transferred at 100g, sold on Horde.
  const d = emptyDoc()
  d.start = { A: 1000 * g, H: 1000 * g, at: at(1) }
  const b: Batch = { id: 'b', item: 'Boar Meat', qty: 200, side: 'A', cost: 100 * g, at: at(2), transfer: { price: 100 * g, at: at(3) }, sales: [] }
  d.batches.push(b)
  return d
}

describe('trade tracker figures', () => {
  it('match the agreed example when everything has sold', () => {
    const d = example()
    d.batches[0].sales.push({ id: 's', qty: 200, received: 142.5 * g, at: at(4) })
    const t = totals(d)
    expect(t.balance).toEqual({ A: 985 * g, H: 1042.5 * g })
    expect(t.total).toBe(2027.5 * g)
    expect(t.tiedUp).toBe(0)
    expect(t.profit).toBe(27.5 * g)
    expect(t.openBatches).toBe(0)
  })

  it('count the unsold share as tied up, outside the balances', () => {
    const d = example()
    d.batches[0].sales.push({ id: 's1', qty: 80, received: 55 * g, at: at(4) }, { id: 's2', qty: 40, received: 32.3 * g, at: at(5) })
    const t = totals(d)
    expect(tiedUp(d.batches[0])).toBe(40 * g) // 80 of 200 unsold
    expect(t.balance).toEqual({ A: 985 * g, H: 987.3 * g })
    expect(t.profit).toBe(t.total + t.tiedUp - 2000 * g)
    expect(batchProfit(d.batches[0])).toBe(87.3 * g - 60 * g - 15 * g)
  })

  it('keep adjustments out of the profit', () => {
    const d = example()
    d.adjustments.push({ id: 'a', side: 'H', amount: 50 * g, note: 'quest gold', at: at(6) })
    const t = totals(d)
    expect(t.balance.H).toBe(950 * g)
    expect(t.profit).toBe(-15 * g) // only the transfer loss so far
  })

  it('list the history newest first with each side\'s change', () => {
    const d = example()
    d.batches[0].sales.push({ id: 's', qty: 10, received: 7 * g, at: at(4) })
    expect(history(d).map((e) => [e.kind, e.delta])).toEqual([
      ['sale', { H: 7 * g }],
      ['transfer', { A: 85 * g, H: -100 * g }],
      ['purchase', { A: -100 * g }],
      ['start', { A: 1000 * g, H: 1000 * g }],
    ])
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
