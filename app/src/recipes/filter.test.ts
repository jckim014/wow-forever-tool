import { describe, expect, it } from 'vitest'
import type { Money, RecipeRow } from '../model'
import { filterRecipes, type RecipeFilters } from './filter'

const row = (id: number, o: { vendor?: [Money, Money]; de?: [Money, Money] | 'none'; ah?: [Money, Money]; best?: Money; bind?: string }) =>
  ({
    recipe: { id, name: `R${id}`, profession: 'Tailoring' }, productName: '', reagentsText: '',
    vendorValue: o.vendor?.[0] ?? null, profitVendor: o.vendor?.[1] ?? null,
    deBand: o.de === 'none' || !o.de ? null : { band: 'b' }, deValue: o.de && o.de !== 'none' ? o.de[0] : null,
    profitDE: o.de && o.de !== 'none' ? o.de[1] : null,
    ahValue: o.ah?.[0] ?? null, profitAH: o.ah?.[1] ?? null,
    profitBest: o.best ?? null, bestValue: null, bind: o.bind ?? null,
  }) as unknown as RecipeRow

const rows = [
  row(1, { vendor: [50000, 20000], ah: [120000, 90000], best: 90000 }), // vendor makes money, the AH makes more
  row(2, { vendor: [50000, -10000], ah: [120000, 90000], best: 90000 }), // the vendor loses money, the AH makes it look good
  row(3, { de: [80000, 30000], ah: [120000, 90000], best: 90000 }), // disenchantable, no vendor price
  row(4, { vendor: [50000, null] }), // sells to a vendor, reagents unpriced
  row(5, { de: [null, null], ah: [40000, -5000], best: -5000 }), // disenchantable, DE materials unpriced
  row(6, { vendor: [30000, 10000], de: [60000, 40000], ah: [200000, 180000], best: 180000, bind: 'pickup' }), // BoP
]
const base: RecipeFilters = { search: '', professions: new Set(), minProfitGold: null, hideUnpriced: false, hideBop: false, exit: 'all' }
const ids = (f: Partial<RecipeFilters>) => filterRecipes(rows, { ...base, ...f }, new Map()).map((r) => r.recipe.id)

describe('filterRecipes', () => {
  it('judges the best exit by default', () => {
    expect(ids({})).toEqual([1, 2, 3, 4, 5, 6])
    expect(ids({ minProfitGold: 5 })).toEqual([1, 2, 3, 6])
    expect(ids({ hideUnpriced: true })).toEqual([1, 2, 3, 5, 6])
  })

  it('vendor: only recipes with a vendor price, judged on vendor profit', () => {
    expect(ids({ exit: 'vendor' })).toEqual([1, 2, 4, 6])
    expect(ids({ exit: 'vendor', minProfitGold: 1 })).toEqual([1, 6])
    expect(ids({ exit: 'vendor', minProfitGold: 5 })).toEqual([])
    expect(ids({ exit: 'vendor', hideUnpriced: true })).toEqual([1, 2, 6])
  })

  it('disenchant: only disenchantable products, judged on DE profit', () => {
    expect(ids({ exit: 'de' })).toEqual([3, 5, 6])
    expect(ids({ exit: 'de', minProfitGold: 1 })).toEqual([3, 6])
    expect(ids({ exit: 'de', hideUnpriced: true })).toEqual([3, 6])
  })

  it('AH: every recipe except BoP products, judged on AH profit', () => {
    expect(ids({ exit: 'ah' })).toEqual([1, 2, 3, 4, 5])
    expect(ids({ exit: 'ah', minProfitGold: 5 })).toEqual([1, 2, 3])
    expect(ids({ exit: 'ah', hideUnpriced: true })).toEqual([1, 2, 3, 5])
  })

  it('hide BoP hides bind-on-pickup products in every view', () => {
    expect(ids({ hideBop: true })).toEqual([1, 2, 3, 4, 5])
    expect(ids({ exit: 'vendor', hideBop: true })).toEqual([1, 2, 4])
    expect(ids({ exit: 'de', hideBop: true })).toEqual([3, 5])
  })
})
