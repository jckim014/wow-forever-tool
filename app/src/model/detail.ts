// What a recipe's detail card shows: each reagent with the price the cheapest path uses and where it came from,
// crafted reagents broken down one level, and each exit with the inputs behind its value. Derived from the
// compute() result only; nothing here changes a number.
import { deMultiplier, deValuePerDisenchant } from './recipes'
import type { ExitName, GameData, Money, ModelResult, PriceSource, RecipeRow } from './types'

export type LineSource = PriceSource | 'Craft' | null

export interface SubLine {
  item: number
  name: string
  /** scaled to the quantity this recipe needs */
  qty: number
  unit: Money
  source: LineSource
  total: Money
}

export interface CostLine {
  item: number
  name: string
  qty: number
  /** unit price the cheapest path uses */
  unit: Money
  source: LineSource
  total: Money
  /** the reagent's own (bought) price, to compare with crafting */
  buyUnit: Money
  /** set when the cheapest path crafts this reagent */
  craft: { profession: string; recipe: string; qtyMade: number; lines: SubLine[] } | null
}

export interface DeMaterial {
  name: string
  chance: number
  avgQty: number
  price: Money
}

export interface ExitDetail {
  name: ExitName
  value: Money
  profit: Money
  isBest: boolean
  qtyMade: number
  vendor?: { unitSell: number }
  disenchant?: { band: string; materials: DeMaterial[]; priced: number; withChance: number; multiplier: number }
  ah?: { unit: Money; source: 'Typed' | 'Imported' | null }
}

export interface RecipeDetail {
  lines: CostLine[]
  /** applicable exits, in tie-break order (Vendor, Disenchant, AH) */
  exits: ExitDetail[]
  unpricedReagents: string[]
  ahCut: number
}

export function recipeDetail(result: ModelResult, row: RecipeRow, game: GameData): RecipeDetail {
  const name = (id: number) => game.items[String(id)]?.name ?? `Item ${id}`
  const { prices, intermediates } = result
  const mul = (q: number, u: Money): Money => (u === null ? null : q * u)

  const lines: CostLine[] = row.recipe.reagents.map((g) => {
    const own = prices(g.item)
    const inter = row.useChains ? intermediates.get(g.item) : undefined
    const crafted = inter?.source === 'Craft'
    const unit = inter ? inter.best : own.reagent
    let craft: CostLine['craft'] = null
    if (inter && crafted) {
      craft = {
        profession: inter.profession, recipe: inter.recipe.name, qtyMade: inter.qtyMade,
        lines: inter.recipe.reagents.map((s, j) => {
          const sub = inter.loopBreaks.includes(j) ? undefined : intermediates.get(s.item)
          const subUnit = sub ? sub.best : prices(s.item).reagent
          const qty = (g.qty * s.qty) / inter.qtyMade
          return {
            item: s.item, name: name(s.item), qty, unit: subUnit,
            source: sub?.source === 'Craft' ? 'Craft' : prices(s.item).reagentSource,
            total: mul(qty, subUnit),
          }
        }),
      }
    }
    return {
      item: g.item, name: name(g.item), qty: g.qty, unit, source: crafted ? 'Craft' : own.reagentSource,
      total: mul(g.qty, unit), buyUnit: own.reagent, craft,
    }
  })

  const exits: ExitDetail[] = []
  const best = (n: ExitName) => row.bestExitName === n
  if (row.vendorValue !== null && row.unitSell !== null) {
    exits.push({ name: 'Vendor', value: row.vendorValue, profit: row.profitVendor, isBest: best('Vendor'), qtyMade: row.qtyMade, vendor: { unitSell: row.unitSell } })
  }
  if (row.deBand) {
    const v = deValuePerDisenchant(row.deBand, prices)
    exits.push({
      name: 'Disenchant', value: row.deValue, profit: row.profitDE, isBest: best('Disenchant'), qtyMade: row.qtyMade,
      disenchant: {
        band: row.deBand.band, priced: v.priced, withChance: v.withChance, multiplier: deMultiplier(result.settings),
        materials: row.deBand.results.map((m) => ({
          name: m.name, chance: m.chance, avgQty: ((m.min ?? 0) + (m.max ?? 0)) / 2, price: m.item == null ? null : prices(m.item).selling,
        })),
      },
    })
  }
  exits.push({ name: 'AH', value: row.ahValue, profit: row.profitAH, isBest: best('AH'), qtyMade: row.qtyMade, ah: { unit: row.ahPrice, source: row.ahSource } })

  return { lines, exits, unpricedReagents: lines.filter((l) => l.unit === null).map((l) => l.name), ahCut: result.settings.ahCut }
}
