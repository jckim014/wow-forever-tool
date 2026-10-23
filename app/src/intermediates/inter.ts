// Pure helpers for the Intermediates view and the per-recipe Use chains switch. No UI code here.
import { potentialCraft, type Edits, type GameData, type IntermediateRow, type Money, type ModelResult } from '../model'

export interface Ingredient {
  item: number
  name: string
  qty: number
  /** Price per unit as the craft cost uses it: a sub-intermediate's best cost, else the reagent price */
  unit: Money
  /** 'craft' when the sub-reagent is itself crafted; otherwise the reagent price source */
  source: string | null
  /** Priced at its buy price to break a crafting loop */
  loopBreak: boolean
}

export interface InterViewRow {
  row: IntermediateRow
  /** Recipes that use the item as a reagent */
  usedIn: number
  /** Crafting is set differently from its default (an edit that changes something) */
  edited: boolean
  ingredients: Ingredient[]
  /** Craft cost per unit even when crafting is switched off (display only); null if an ingredient is unpriced */
  potential: Money
}

export function interViewRows(game: GameData, result: ModelResult): InterViewRow[] {
  const used = new Map<number, number>()
  for (const r of game.recipes) for (const id of new Set(r.reagents.map((g) => g.item))) used.set(id, (used.get(id) ?? 0) + 1)
  const name = (id: number) => game.items[String(id)]?.name ?? `Item ${id}`
  return [...result.intermediates.values()].map((row) => ({
    row,
    usedIn: used.get(row.item) ?? 0,
    edited: row.allowCrafting !== row.allowDefault,
    potential: potentialCraft(row, result.intermediates, result.prices),
    ingredients: row.recipe.reagents.map((g, j) => {
      const sub = result.intermediates.get(g.item)
      const loopBreak = row.loopBreaks.includes(j)
      const p = result.prices(g.item)
      if (sub && !loopBreak) {
        return { item: g.item, name: name(g.item), qty: g.qty, unit: sub.best, source: sub.source === 'Craft' ? 'craft' : sub.best === null ? null : p.reagentSource, loopBreak }
      }
      return { item: g.item, name: name(g.item), qty: g.qty, unit: p.reagent, source: p.reagentSource, loopBreak }
    }),
  })).sort((a, b) => a.row.name.localeCompare(b.row.name))
}

/** Allow crafting for an intermediate; setting it back to its default removes the edit. */
export function setAllowCrafting(edits: Edits, row: IntermediateRow, on: boolean): Edits {
  const allowCrafting = { ...edits.allowCrafting }
  if (on === row.allowDefault) delete allowCrafting[String(row.item)]
  else allowCrafting[String(row.item)] = on
  return { ...edits, allowCrafting }
}

/** Per-recipe Use chains: off = this recipe buys every reagent instead of crafting it. */
export function setUseChains(edits: Edits, recipeId: number, on: boolean): Edits {
  const rest = edits.useChainsNo.filter((id) => id !== recipeId)
  return { ...edits, useChainsNo: on ? rest : [...rest, recipeId] }
}
