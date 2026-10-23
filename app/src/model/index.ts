import { computeIntermediates } from './intermediates'
import { makePriceLookup } from './prices'
import { computeRecipe } from './recipes'
import type { Config, DeBand, Edits, GameData, ModelResult, Settings } from './types'

export * from './types'
export { emptyEdits, normalizeEdits } from './edits'
export { potentialCraft, recipeDetail, type CostLine, type ExitDetail, type RecipeDetail, type SubLine } from './detail'

/** Builds the config from data/config/defaults.json and data/config/de-table.json. */
export function makeConfig(defaults: { settings: Settings; cooldownCrafts: Config['cooldownCrafts'] }, deTable: { bands: DeBand[] }): Config {
  return { settings: defaults.settings, cooldownCrafts: defaults.cooldownCrafts, deTable: deTable.bands }
}

export function effectiveSettings(config: Config, edits: Edits): Settings {
  return {
    ...config.settings,
    ...edits.settings,
    chainsByProfession: { ...config.settings.chainsByProfession, ...edits.settings.chainsByProfession },
  }
}

/** Pure: game data + config + edits -> one row per recipe, plus the intermediates. */
export function compute(game: GameData, config: Config, edits: Edits): ModelResult {
  const settings = effectiveSettings(config, edits)
  const price = makePriceLookup(game, edits, settings)
  const { rows, loops } = computeIntermediates(game, config, edits, settings, price)
  const deTable = edits.deTable ?? config.deTable
  const noChains = new Set(edits.useChainsNo)
  const recipes = game.recipes.map((r) => computeRecipe(r, game, settings, deTable, noChains, price, rows))
  return { settings, prices: price, intermediates: rows, recipes, loops }
}
