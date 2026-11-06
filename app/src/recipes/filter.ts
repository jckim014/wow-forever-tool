import type { Money, RecipeRow } from '../model'

/** Which exit the list judges recipes on: the best priced one, or a single exit. */
export type ExitView = 'all' | 'vendor' | 'de' | 'ah'

export interface RecipeFilters {
  search: string
  professions: Set<string>
  minProfitGold: number | null
  hideUnpriced: boolean
  /** Hide recipes whose product binds when picked up. */
  hideBop: boolean
  /** 'all' = best exit; otherwise only recipes where that exit applies, judged on it alone. */
  exit: ExitView
}

/** The profit and return the list shows for a recipe under the chosen exit (display only, no new calculation). */
export function exitFigures(r: RecipeRow, exit: ExitView): { applies: boolean; profit: Money; value: Money } {
  switch (exit) {
    case 'vendor': return { applies: r.vendorValue !== null, profit: r.profitVendor, value: r.vendorValue }
    case 'de': return { applies: r.deBand !== null, profit: r.profitDE, value: r.deValue }
    // A product that binds when picked up can't be listed on the auction house.
    case 'ah': return { applies: r.bind !== 'pickup', profit: r.profitAH, value: r.ahValue }
    default: return { applies: true, profit: r.profitBest, value: r.bestValue }
  }
}

/** Lower-cased text the search box matches: recipe, product and reagent names. */
export const searchText = (r: RecipeRow) => `${r.recipe.name} ${r.productName} ${r.reagentsText}`.toLowerCase()

export function filterRecipes(rows: RecipeRow[], f: RecipeFilters, text: Map<RecipeRow, string>): RecipeRow[] {
  const q = f.search.trim().toLowerCase()
  const min = f.minProfitGold === null ? null : f.minProfitGold * 10000
  return rows.filter((r) => {
    const { applies, profit } = exitFigures(r, f.exit)
    return applies && !(f.hideBop && r.bind === 'pickup') &&
      (!f.professions.size || f.professions.has(r.recipe.profession)) &&
      (!f.hideUnpriced || profit !== null) &&
      (min === null || (profit !== null && profit >= min)) &&
      (!q || (text.get(r) ?? searchText(r)).includes(q))
  })
}
