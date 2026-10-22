import type { Config, Edits, GameData, IntermediateRow, Money, PriceInfo, Recipe, Settings } from './types'

export function isCooldownCraft(r: Recipe, rule: Config['cooldownCrafts']): boolean {
  return rule.namePrefixes.some((p) => r.name.startsWith(p)) || rule.names.includes(r.name)
}

export const qtyMade = (r: Recipe) => (r.qtyMin + r.qtyMax) / 2

/** Recipes creating each item, in profession order (game.professions), then data order. */
export function makersByProduct(game: GameData): Map<number, Recipe[]> {
  const rank = new Map(game.professions.map((p, i) => [p, i]))
  const sorted = game.recipes
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (rank.get(a.r.profession) ?? 99) - (rank.get(b.r.profession) ?? 99) || a.i - b.i)
  const out = new Map<number, Recipe[]>()
  for (const { r } of sorted) {
    const list = out.get(r.product)
    if (list) list.push(r)
    else out.set(r.product, [r])
  }
  return out
}

export interface IntermediatesResult {
  rows: Map<number, IntermediateRow>
  loops: { item: number; reagent: number }[]
}

/**
 * Every reagent that some recipe creates. Craft cost prices each sub-reagent at its own best cost, so chains of
 * any depth resolve; a loop is broken depth-first (intermediates in case-insensitive name order) by pricing the
 * back-edge sub-reagent at its buy price.
 */
export function computeIntermediates(
  game: GameData,
  config: Config,
  edits: Edits,
  settings: Settings,
  price: (id: number) => PriceInfo,
): IntermediatesResult {
  const makers = makersByProduct(game)
  const name = (id: number) => game.items[String(id)]?.name ?? `Item ${id}`
  const rows = new Map<number, IntermediateRow>()

  const reagentIds = new Set<number>()
  for (const r of game.recipes) for (const g of r.reagents) reagentIds.add(g.item)
  for (const id of reagentIds) {
    const cands = makers.get(id)
    if (!cands) continue
    const ok = cands.filter((r) => !isCooldownCraft(r, config.cooldownCrafts))
    const recipe = (ok.length ? ok : cands)[0]
    const allowDefault = ok.length > 0
    const edited = edits.allowCrafting[String(id)]
    rows.set(id, {
      item: id, name: name(id), profession: recipe.profession, recipe, qtyMade: qtyMade(recipe), depth: 0,
      allowCrafting: edited ?? allowDefault, allowDefault,
      professionOn: settings.chainsByProfession[recipe.profession] ?? true, // a missing toggle counts as Yes
      buy: null, craft: null, best: null, source: null, loopBreaks: [], alsoMadeBy: cands.filter((r) => r !== recipe),
    })
  }

  // Depth-first in name order; back edges become loop breaks.
  const order = [...rows.values()].sort((a, b) => {
    const x = a.name.toLowerCase(), y = b.name.toLowerCase()
    return x < y ? -1 : x > y ? 1 : a.item - b.item
  })
  const state = new Map<number, 'active' | 'done'>()
  const loops: IntermediatesResult['loops'] = []
  const visit = (row: IntermediateRow): number => {
    if (state.get(row.item) === 'done') return row.depth
    state.set(row.item, 'active')
    let d = 0
    row.recipe.reagents.forEach((g, j) => {
      const sub = rows.get(g.item)
      if (!sub) return
      if (state.get(g.item) === 'active') {
        row.loopBreaks.push(j)
        loops.push({ item: row.item, reagent: g.item })
        return
      }
      d = Math.max(d, visit(sub))
    })
    state.set(row.item, 'done')
    row.depth = d + 1
    return row.depth
  }
  for (const row of order) visit(row)

  // Costs. Without loop-break edges the graph is acyclic, so plain memoised recursion terminates.
  const done = new Set<number>()
  const resolve = (row: IntermediateRow): Money => {
    if (done.has(row.item)) return row.best
    const buy = price(row.item).reagent
    let craft: Money = null
    if (row.allowCrafting && row.professionOn) {
      let sum = 0
      let priced = true
      row.recipe.reagents.forEach((g, j) => {
        const sub = rows.get(g.item)
        const unit = sub && !row.loopBreaks.includes(j) ? resolve(sub) : price(g.item).reagent
        if (unit === null) priced = false
        else sum += g.qty * unit
      })
      craft = priced ? sum / row.qtyMade : null
    }
    row.buy = buy
    row.craft = craft
    row.best = craft === null ? buy : buy === null ? craft : Math.min(buy, craft)
    row.source = row.best === null ? null : craft !== null && (buy === null || craft < buy) ? 'Craft' : 'Buy'
    done.add(row.item)
    return row.best
  }
  for (const row of order) resolve(row)

  return { rows, loops }
}
