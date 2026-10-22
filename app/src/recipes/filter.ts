import type { RecipeRow } from '../model'

export interface RecipeFilters {
  search: string
  professions: Set<string>
  minProfitGold: number | null
  hideUnpriced: boolean
}

/** Lower-cased text the search box matches: recipe, product and reagent names. */
export const searchText = (r: RecipeRow) => `${r.recipe.name} ${r.productName} ${r.reagentsText}`.toLowerCase()

export function filterRecipes(rows: RecipeRow[], f: RecipeFilters, text: Map<RecipeRow, string>): RecipeRow[] {
  const q = f.search.trim().toLowerCase()
  const min = f.minProfitGold === null ? null : f.minProfitGold * 10000
  return rows.filter((r) =>
    (!f.professions.size || f.professions.has(r.recipe.profession)) &&
    (!f.hideUnpriced || r.profitBest !== null) &&
    (min === null || (r.profitBest !== null && r.profitBest >= min)) &&
    (!q || (text.get(r) ?? searchText(r)).includes(q)))
}
