import { describe, expect, it } from 'vitest'
import { config } from '../data'
import { compute, emptyEdits, type GameData } from '../model'
import { itemPriceRows, joinMoney, setCustomPrice, setVendorBuy, splitMoney } from './items'

const game: GameData = {
  professions: ['Tailoring'],
  items: {
    '2589': { id: 2589, name: 'Linen Cloth', sell: 13 },
    '2996': { id: 2996, name: 'Bolt of Linen Cloth', sell: 40 },
    '2320': { id: 2320, name: 'Coarse Thread', sell: 2, buy: 10 },
    '2570': { id: 2570, name: 'Linen Shirt', sell: 20, quality: 2, class: 4, ilvl: 10 },
  },
  recipes: [
    { id: 1, name: 'Bolt of Linen Cloth', profession: 'Tailoring', skill: 1, product: 2996, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2589, qty: 2 }] },
    { id: 2, name: 'Linen Shirt', profession: 'Tailoring', skill: 1, product: 2570, qtyMin: 1, qtyMax: 1,
      reagents: [{ item: 2996, qty: 1 }, { item: 2320, qty: 1 }] },
  ],
}
const de = [{ band: 'x', quality: 'Uncommon', type: 'Any', ilvlMin: 1, ilvlMax: 99, note: '',
  results: [{ item: 10940, name: 'Strange Dust', chance: 1, min: 1, max: 1 }] }]

const rows = (edits = emptyEdits()) => {
  const result = compute(game, config, edits)
  return new Map(itemPriceRows(game, de, edits, result.prices).map((r) => [r.id, r]))
}

describe('Prices view rows', () => {
  it('lists every reagent, product and DE material with its uses', () => {
    const r = rows()
    expect([...r.keys()].sort((a, b) => a - b)).toEqual([2320, 2570, 2589, 2996, 10940])
    expect(r.get(2996)!.usage).toEqual({ reagentIn: 1, product: true, deMaterial: false, craftable: true })
    expect(r.get(10940)!.name).toBe('Strange Dust')
    expect(r.get(10940)!.usage.deMaterial).toBe(true)
  })

  it('reports the price used and whether the item is unpriced for its use', () => {
    const r = rows()
    expect(r.get(2320)!.price.reagent).toBe(10) // Wowhead vendor buy
    expect(r.get(2320)!.unpriced).toBe(false)
    expect(r.get(2589)!.unpriced).toBe(true)
    const e = setCustomPrice(emptyEdits(), 2589, 25)
    expect(rows(e).get(2589)!.price.reagentSource).toBe('Typed')
    expect(rows(e).get(2589)!.unpriced).toBe(false)
  })

  it('curates vendor buy prices', () => {
    let e = setVendorBuy(emptyEdits(), 2320, null)
    expect(rows(e).get(2320)!.override).toBeNull()
    expect(rows(e).get(2320)!.price.reagent).toBeNull()
    e = setVendorBuy(e, 2320, 12)
    expect(rows(e).get(2320)!.price.reagent).toBe(12)
    e = setVendorBuy(e, 2320, 'wowhead')
    expect(e.vendorBuyOverrides).toEqual({})
    expect(rows(e).get(2320)!.override).toBeUndefined()
  })

  it('flags items whose reagent price differs from their sale price', () => {
    // Bolt of Linen Cloth is a reagent and a product; a vendor price makes the two sides differ
    const imp = { ...emptyEdits(), imports: [{ item: 2996, p1: 50, p2: null, p3: null }] }
    expect(rows(imp).get(2996)!.differs).toBe(false)
    const e = setVendorBuy(imp, 2996, 30)
    expect(rows(e).get(2996)!.price.reagent).toBe(30)
    expect(rows(e).get(2996)!.price.selling).toBe(50)
    expect(rows(e).get(2996)!.differs).toBe(true)
    expect(rows(setCustomPrice(e, 2996, 40)).get(2996)!.differs).toBe(false)
  })

  it('clears a custom price', () => {
    expect(setCustomPrice(setCustomPrice(emptyEdits(), 1, 5), 1, null).typedPrices).toEqual({})
  })

  it('splits and joins gold / silver / copper', () => {
    expect(splitMoney(12345)).toEqual({ g: 1, s: 23, c: 45 })
    expect(joinMoney(1, 23, 45)).toBe(12345)
  })
})
