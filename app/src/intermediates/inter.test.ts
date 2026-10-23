import { describe, expect, it } from 'vitest'
import { config } from '../data'
import { compute, emptyEdits, type Edits, type GameData } from '../model'
import { interViewRows, setAllowCrafting, setUseChains } from './inter'

const game: GameData = {
  professions: ['Tailoring'],
  items: {
    '2589': { id: 2589, name: 'Linen Cloth', sell: 13 },
    '2996': { id: 2996, name: 'Bolt of Linen Cloth', sell: 40 },
    '2570': { id: 2570, name: 'Linen Shirt', sell: 20 },
    '2580': { id: 2580, name: 'Linen Bag', sell: 50 },
  },
  recipes: [
    { id: 1, name: 'Bolt of Linen Cloth', profession: 'Tailoring', skill: 1, product: 2996, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2589, qty: 2 }] },
    { id: 2, name: 'Linen Shirt', profession: 'Tailoring', skill: 1, product: 2570, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2996, qty: 1 }] },
    { id: 3, name: 'Linen Bag', profession: 'Tailoring', skill: 1, product: 2580, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2996, qty: 3 }] },
  ],
}
const priced: Edits = { ...emptyEdits(), typedPrices: { '2589': 10, '2996': 100 } }
const view = (e: Edits) => interViewRows(game, compute(game, config, e))

describe('Intermediates view', () => {
  it('lists each intermediate with its uses and ingredients', () => {
    const [r] = view(priced)
    expect(r.row.name).toBe('Bolt of Linen Cloth')
    expect(r.usedIn).toBe(2)
    expect(r.row.craft).toBe(20)
    expect(r.row.source).toBe('Craft')
    expect(r.ingredients).toEqual([{ item: 2589, name: 'Linen Cloth', qty: 2, unit: 10, source: 'Typed', loopBreak: false }])
    expect(r.edited).toBe(false)
  })

  it('stores Allow crafting only when it differs from the default', () => {
    const row = view(priced)[0].row
    const off = setAllowCrafting(priced, row, false)
    expect(off.allowCrafting).toEqual({ '2996': false })
    const r = view(off)[0]
    expect(r.edited).toBe(true)
    expect(r.row.source).toBe('Buy')
    expect(r.row.craft).toBeNull()
    expect(r.potential).toBe(20) // still shown, though not used
    expect(setAllowCrafting(off, row, true).allowCrafting).toEqual({})
  })

  it('an edit equal to the default is not shown as edited', () => {
    expect(view({ ...priced, allowCrafting: { '2996': true } })[0].edited).toBe(false)
  })

  it('Use chains off makes one recipe buy its reagents', () => {
    const e = setUseChains(priced, 2, false)
    expect(e.useChainsNo).toEqual([2])
    const res = compute(game, config, e)
    const cost = (id: number) => res.recipes.find((r) => r.recipe.id === id)!.cheapest
    expect(cost(2)).toBe(100) // bought
    expect(cost(3)).toBe(60) // still crafted: 3 x 20
    expect(setUseChains(e, 2, true).useChainsNo).toEqual([])
  })
})
