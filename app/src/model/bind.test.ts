// A product that binds when picked up can't be listed on the auction house, so the AH exit doesn't apply to it.
import { describe, expect, it } from 'vitest'
import defaults from '../../../data/config/defaults.json'
import deTable from '../../../data/config/de-table.json'
import { compute, emptyEdits, makeConfig, type Bind, type DeBand, type GameData, type Settings } from './index'

const config = makeConfig(defaults as { settings: Settings; cooldownCrafts: { namePrefixes: string[]; names: string[] } }, deTable as { bands: DeBand[] })

function run(bind?: Bind) {
  const game: GameData = {
    professions: ['Tailoring'],
    recipes: [{ id: 1, name: 'Cloth Thing', profession: 'Tailoring', skill: 1, product: 20, qtyMin: 1, qtyMax: 1, reagents: [{ item: 10, qty: 1 }] }],
    items: {
      10: { id: 10, name: 'Cloth', sell: 10 },
      // white cloth item: not disenchantable, sells to a vendor for 50c
      20: { id: 20, name: 'Cloth Thing', sell: 50, quality: 1, class: 4, ilvl: 10, ...(bind ? { bind } : {}) },
    },
  } as unknown as GameData
  const edits = emptyEdits()
  edits.typedPrices = { 10: 100, 20: 10000 } // reagent 1s, product 1g on the AH
  return compute(game, config, edits).recipes[0]
}

describe('bind on pickup', () => {
  it('a product that does not bind on pickup can go to the AH', () => {
    for (const b of [undefined, 'equip', 'none'] as const) {
      const r = run(b)
      expect(r.bestExitName).toBe('AH')
      expect(r.profitAH).toBeCloseTo(10000 * 0.95 - 100)
    }
  })

  it('a BoP product has no AH exit: not valued, not best, not flagged unpriced', () => {
    const r = run('pickup')
    expect(r.ahPrice).toBe(10000) // the item's price is still known
    expect(r.ahValue).toBeNull()
    expect(r.profitAH).toBeNull()
    expect(r.ahBeats).toBeNull()
    expect(r.bestExitName).toBe('Vendor')
    expect(r.bestExit).toBe('Vendor')
    expect(r.unpricedExits).toEqual([])
    expect(r.profitBest).toBe(50 - 100)
  })
})
