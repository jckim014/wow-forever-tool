import { describe, expect, it } from 'vitest'
import type { Item, PriceInfo } from '../model/types'
import { chance, learnables, plan, routeItems, type LvRecipe, type PlanInput } from './plan'

const CLOTH = 1, BOLT = 2, THREAD = 3, CLOAK = 4, SHIRT = 5, RECIPE_ITEM = 90

const prices: Record<number, number> = { [CLOTH]: 100, [BOLT]: 1000, [THREAD]: 10, [RECIPE_ITEM]: 500 }
const price = (id: number): PriceInfo => {
  const p = prices[id] ?? null
  return { typed: null, vendorBuy: null, imported: p, importedSource: p == null ? null : 'Imported', reagent: p, reagentSource: p == null ? null : 'Imported', selling: p }
}
const items: Record<number, Item> = { [CLOAK]: { id: CLOAK, name: 'Cloak', sell: 50 }, [SHIRT]: { id: SHIRT, name: 'Shirt', sell: 0 } }

const r = (o: Partial<LvRecipe> & Pick<LvRecipe, 'id' | 'name' | 'colors'>): LvRecipe =>
  ({ profession: 'Tailoring', learnedat: o.colors[0] || o.colors[1], source: [], reagents: [], qtyMin: 1, qtyMax: 1, ...o })

const bolt = r({ id: 10, name: 'Bolt', colors: [0, 25, 37, 50], starter: true, product: BOLT, reagents: [{ item: CLOTH, qty: 2 }] })
const cloak = r({ id: 11, name: 'Cloak', colors: [1, 30, 45, 60], starter: true, product: CLOAK, reagents: [{ item: BOLT, qty: 1 }, { item: THREAD, qty: 1 }] })

const input = (recipes: LvRecipe[], o: Partial<PlanInput> = {}): PlanInput => ({
  profession: 'Tailoring', from: 1, to: 50, recipes, price, intermediates: new Map(), item: (id) => items[id], runs: 3000, seed: 7, ...o,
})

describe('chance', () => {
  it('follows orange / yellow / green / grey', () => {
    const x = r({ id: 1, name: 'x', colors: [10, 25, 37, 50] })
    expect(chance(x, 9)).toBe(0) // not learnable yet
    expect(chance(x, 24)).toBe(1)
    expect(chance(x, 25)).toBe(1)
    expect(chance(x, 37)).toBeCloseTo(13 / 25)
    expect(chance(x, 45)).toBeCloseTo(5 / 25)
    expect(chance(x, 50)).toBe(0)
  })
})

describe('learnables', () => {
  it('takes starters, non-specialisation trainer recipes and AH recipes with a price', () => {
    const t = r({ id: 20, name: 'T', colors: [5, 10, 15, 20], source: [6], trainer: 50 })
    const spec = r({ id: 21, name: 'S', colors: [5, 10, 15, 20], source: [6], trainer: 50, spec: 1 })
    const ah = r({ id: 22, name: 'A', colors: [5, 10, 15, 20], source: [5], recipeItems: [{ id: RECIPE_ITEM, name: 'Pattern: A' }] })
    const unseen = r({ id: 23, name: 'U', colors: [5, 10, 15, 20], source: [2], recipeItems: [{ id: 999, name: 'Pattern: U' }] })
    const l = learnables([bolt, t, spec, ah, unseen], 'Tailoring', price)
    expect(l.map((x) => [x.recipe.id, x.access, x.cost])).toEqual([[10, 'starter', 0], [20, 'trainer', 50], [22, 'ah', 500]])
  })
})

describe('plan', () => {
  it('levels on bolts alone and the simulation matches the expected crafts', () => {
    const p = plan(input([bolt], { to: 45 }))
    expect(p.gaps).toEqual([])
    expect(p.segments).toHaveLength(1)
    // 1..24 always a point, then 1 / chance per point
    let expected = 24
    for (let s = 25; s < 45; s++) expected += 1 / ((50 - s) / 25)
    expect(p.segments[0].crafts.mean).toBeCloseTo(expected, 0)
    expect(p.segments[0].crafts.safe).toBeGreaterThan(p.segments[0].crafts.mean)
    expect(p.reached.min).toBe(45)
    // bolts sell for nothing; 2 cloth each
    expect(p.segments[0].shopping).toEqual([expect.objectContaining({ item: CLOTH, price: 100 })])
    expect(p.segments[0].shopping[0].qtyMean).toBeCloseTo(2 * p.segments[0].crafts.mean)
  })

  it('crafts the bolts for the cloak when the extra points pay for it', () => {
    // cloak with bought bolt: 1010 - 50 per craft; with crafted bolt: 210 - 50 and up to 2 points
    const p = plan(input([bolt, cloak], { from: 30, to: 45 }))
    const seg = p.segments[0]
    expect(seg.action.recipe.id).toBe(11)
    expect(seg.action.crafted.map((c) => c.item)).toEqual([BOLT])
    expect(seg.makerCrafts[0].mean).toBeCloseTo(seg.crafts.mean, 0)
  })

  it('buys an AH recipe only when it saves more than its price', () => {
    const cheap = r({ id: 30, name: 'Cheap', colors: [1, 100, 110, 120], source: [5], product: SHIRT, reagents: [{ item: THREAD, qty: 1 }],
      recipeItems: [{ id: RECIPE_ITEM, name: 'Pattern: Cheap' }] })
    const yes = plan(input([bolt, cheap], { to: 45 }))
    expect(yes.learn.map((l) => [l.recipe.id, l.access])).toEqual([[30, 'ah']])
    expect(yes.learn[0].saving).toBeGreaterThan(0)
    prices[RECIPE_ITEM] = 1_000_000
    const no = plan(input([bolt, cheap], { to: 45 }))
    expect(no.learn.map((l) => l.recipe.id)).toEqual([10])
    prices[RECIPE_ITEM] = 500
  })

  it('drops a trainer recipe that does not pay for its training cost', () => {
    const t = r({ id: 40, name: 'Pricey', colors: [1, 100, 110, 120], source: [6], trainer: 1_000_000, product: SHIRT, reagents: [{ item: THREAD, qty: 1 }] })
    const p = plan(input([bolt, t], { to: 45 }))
    expect(p.learn.map((l) => l.recipe.id)).toEqual([10])
  })

  it('reports levels nothing can raise', () => {
    const p = plan(input([bolt], { to: 55 }))
    expect(p.gaps).toEqual([50, 51, 52, 53, 54])
    expect(p.reached.min).toBe(50)
  })

  it('lists the whole route to buy: reagents at the shown amounts, AH recipe items, vendor items flagged', () => {
    const cheap = r({ id: 30, name: 'Cheap', colors: [1, 100, 110, 120], source: [5], product: SHIRT, reagents: [{ item: THREAD, qty: 1 }],
      recipeItems: [{ id: RECIPE_ITEM, name: 'Pattern: Cheap' }] })
    const p = plan(input([bolt, cheap], { to: 45 }))
    const vendorPrice = (id: number) => ({ ...price(id), vendorBuy: id === THREAD ? 10 : null })
    const items = routeItems(p, vendorPrice)
    const shown = p.segments.reduce((t, s) => t + Math.ceil(s.shopping.find((l) => l.item === THREAD)!.qtySafe), 0)
    expect(items).toEqual([
      { item: RECIPE_ITEM, qty: 1, price: 500, vendor: false, recipe: true, name: 'Pattern: Cheap' },
      { item: THREAD, qty: shown, price: 10, vendor: true, recipe: false },
    ])
  })
})

describe('Working Overtime bonus', () => {
  it('adds flat points to green chances only, capped at 100%', () => {
    const x = r({ id: 1, name: 'x', colors: [10, 25, 37, 50] })
    expect(chance(x, 24, 0.12)).toBe(1)
    expect(chance(x, 37, 0.12)).toBeCloseTo(13 / 25 + 0.12)
    expect(chance(x, 26, 0.12)).toBe(1) // 24/25 + 0.12 capped
    expect(chance(x, 50, 0.12)).toBe(0) // grey stays grey
    expect(chance(x, 9, 0.12)).toBe(0)
  })

  it('makes the route need fewer crafts', () => {
    const base = plan(input([bolt], { to: 45 }))
    const ot = plan(input([bolt], { to: 45, bonus: 0.12 }))
    let expected = 24
    for (let s = 25; s < 45; s++) expected += 1 / Math.min(1, (50 - s) / 25 + 0.12)
    expect(ot.segments[0].crafts.mean).toBeCloseTo(expected, 0)
    expect(ot.totalMean).toBeLessThan(base.totalMean)
  })
})

describe('extra recipes', () => {
  // a vendor recipe never seen on the AH: cheap reagents, green up to 120
  const vend = r({ id: 50, name: 'Vendor shirt', colors: [40, 100, 110, 120], source: [5], product: SHIRT, reagents: [{ item: THREAD, qty: 1 }] })

  it('lists an unticked one with what it would save, and uses a ticked one free of charge', () => {
    const without = plan(input([bolt, vend], { to: 45 }))
    expect(without.learn.map((l) => l.recipe.id)).toEqual([10])
    const c = without.candidates.find((x) => x.recipe.id === 50)!
    expect(c.fills).toBe(0)
    expect(c.saving).toBeGreaterThan(0)
    const withIt = plan(input([bolt, vend], { to: 45, extra: new Set([50]) }))
    expect(withIt.learn.map((l) => [l.recipe.id, l.access, l.cost])).toContainEqual([50, 'extra', 0])
    expect(withIt.candidates.map((x) => x.recipe.id)).not.toContain(50)
    expect(withIt.totalMean).toBeCloseTo(without.totalMean - c.saving!, -2)
  })

  it('reports the levels a candidate would reach where the route stops', () => {
    const p = plan(input([bolt, vend], { to: 55 }))
    expect(p.gaps.length).toBe(5)
    expect(p.candidates.find((x) => x.recipe.id === 50)!.fills).toBe(5)
  })

  it('leaves out candidates that cannot raise any level of the route', () => {
    const p = plan(input([bolt, vend], { to: 30 }))
    expect(p.candidates.map((x) => x.recipe.id)).toEqual([])
  })
})
