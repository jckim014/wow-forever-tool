import { describe, expect, it } from 'vitest'
import type { RecipeRow } from '../model'
import { filterRecipes, type RecipeFilters } from './filter'

const row = (id: number, vendorValue: number | null, profitVendor: number | null, profitBest: number | null) =>
  ({ recipe: { id, name: `R${id}`, profession: 'Tailoring' }, productName: '', reagentsText: '', vendorValue, profitVendor, profitBest }) as RecipeRow

const rows = [
  row(1, 50000, 20000, 90000), // vendor makes money, the AH makes more
  row(2, 50000, -10000, 90000), // the vendor loses money, the AH makes it look good
  row(3, null, null, 90000), // no vendor price
  row(4, 50000, null, null), // sells to a vendor, reagents unpriced
]
const base: RecipeFilters = { search: '', professions: new Set(), minProfitGold: null, hideUnpriced: false, vendorOnly: false }
const ids = (f: Partial<RecipeFilters>) => filterRecipes(rows, { ...base, ...f }, new Map()).map((r) => r.recipe.id)

describe('filterRecipes', () => {
  it('judges the best exit by default', () => {
    expect(ids({})).toEqual([1, 2, 3, 4])
    expect(ids({ minProfitGold: 5 })).toEqual([1, 2, 3])
    expect(ids({ hideUnpriced: true })).toEqual([1, 2, 3])
  })

  it('vendor only drops recipes with no vendor price', () => {
    expect(ids({ vendorOnly: true })).toEqual([1, 2, 4])
  })

  it('vendor only applies min profit and hide unpriced to the vendor profit', () => {
    expect(ids({ vendorOnly: true, minProfitGold: 1 })).toEqual([1])
    expect(ids({ vendorOnly: true, minProfitGold: 5 })).toEqual([])
    expect(ids({ vendorOnly: true, hideUnpriced: true })).toEqual([1, 2])
  })
})
