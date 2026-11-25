// Favorites.lua for BavvbScan's in-game favorites panel: everything the addon needs to work out each favorite's cost
// and exits from live prices (the character's own /bscan, else the hourly API prices in ApiPrices.lua). Prices are
// NOT in this file; settings and edits are applied here so the addon only does the price-dependent math:
// - favorite groups and recipes, plus the maker recipe of every craftable reagent they reach (any depth)
// - per intermediate: Allow crafting x the profession's chain toggle, and the loop breaks the app found
// - per item: name, vendor sell price, vendor buy price (priced only if Use vendor buy price is on: settings.useVendorBuy;
//   the shopping list leaves vendor-sold items off either way, as the app's Shopping view), custom price
// - per product: bind type and its disenchant band (by index), so the addon needs no item levels
// Pure; written by useGameExport.
import { deBandFor, deMultiplier } from '../model/recipes'
import type { DeBand, Edits, GameData, ModelResult, Recipe } from '../model'
import { vendorBuyPrice } from '../model/prices'

export interface ExportItem {
  name: string
  sell?: number
  vendor?: number
  typed?: number
  bind?: string
  de?: number
}

export interface GameExport {
  format: 'bavvbfav'
  version: 1
  settings: { ahCut: number; deMult: number; useImports: boolean; useApi: boolean; column: number; useVendorBuy: boolean }
  groups: { name: string; recipes: number[] }[]
  recipes: Record<number, { name: string; profession: string; product: number; made: number; chains: boolean; reagents: [number, number][] }>
  inter: Record<number, { recipe: number; craft: boolean; breaks: number[] }>
  items: Record<number, ExportItem>
  bands: { band: string; results: [number, number, number][] }[]
}

export function buildExport(game: GameData, result: ModelResult, edits: Edits, deTable: DeBand[]): GameExport {
  const s = result.settings
  const byId = new Map(game.recipes.map((r) => [r.id, r]))
  const noChains = new Set(edits.useChainsNo)
  const recipes: GameExport['recipes'] = {}
  const inter: GameExport['inter'] = {}
  const itemIds = new Set<number>()
  const products = new Set<number>()
  const bands: GameExport['bands'] = []
  const bandIndex = new Map<DeBand, number>()

  const addRecipe = (r: Recipe, chains: boolean) => {
    if (recipes[r.id]) return
    recipes[r.id] = { name: r.name, profession: r.profession, product: r.product, made: (r.qtyMin + r.qtyMax) / 2, chains, reagents: r.reagents.map((g) => [g.item, g.qty]) }
    itemIds.add(r.product)
    for (const g of r.reagents) addItem(g.item)
  }
  const addItem = (id: number) => {
    itemIds.add(id)
    const row = result.intermediates.get(id)
    if (!row || inter[id]) return
    inter[id] = { recipe: row.recipe.id, craft: row.allowCrafting && row.professionOn, breaks: row.loopBreaks.map((j) => j + 1) }
    addRecipe(row.recipe, true)
  }

  const groups: GameExport['groups'] = []
  for (const g of edits.favorites.groups) {
    const ids = g.recipes.filter((id) => byId.has(id))
    for (const id of ids) {
      const r = byId.get(id)!
      if (recipes[id]) recipes[id].chains = !noChains.has(id) // a favorite that is also some reagent's maker
      else addRecipe(r, !noChains.has(id))
      products.add(r.product)
    }
    groups.push({ name: g.name, recipes: ids })
  }

  const items: GameExport['items'] = {}
  const deItems = new Set<number>()
  for (const p of products) {
    const band = deBandFor(game.items[String(p)], deTable)
    if (!band) continue
    if (!bandIndex.has(band)) {
      bandIndex.set(band, bands.length + 1) // Lua is 1-based
      bands.push({ band: band.band, results: band.results.map((r) => [r.item ?? 0, r.chance || 0, ((r.min ?? 0) + (r.max ?? 0)) / 2]) }) // item 0 = none: unpriced, as in the app
      for (const r of band.results) if (r.item != null) deItems.add(r.item)
    }
  }
  for (const id of deItems) itemIds.add(id)

  for (const id of [...itemIds].sort((a, b) => a - b)) {
    const it = game.items[String(id)]
    const e: ExportItem = { name: it?.name ?? `Item ${id}` }
    if (it?.sell != null) e.sell = it.sell
    const vb = vendorBuyPrice(game, edits, id)
    if (vb != null) e.vendor = vb
    const typed = edits.typedPrices[String(id)]
    if (typed != null) e.typed = typed
    if (products.has(id)) {
      if (it?.bind) e.bind = it.bind
      const band = deBandFor(it, deTable)
      if (band) e.de = bandIndex.get(band)
    }
    items[id] = e
  }

  return {
    format: 'bavvbfav', version: 1,
    settings: { ahCut: s.ahCut, deMult: deMultiplier(s), useImports: s.useImports, useApi: s.useApiPrices, column: s.importColumn, useVendorBuy: s.useVendorBuy },
    groups, recipes, inter, items, bands,
  }
}

const luaString = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A JSON-like value as a Lua expression. Objects with numeric keys become [n] = ...; arrays become sequences. */
export function toLua(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return 'nil'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`Not a finite number: ${v}`)
    return String(v)
  }
  if (typeof v === 'string') return luaString(v)
  const inner = indent + '  '
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== 'object' || x === null)) return '{' + v.map((x) => toLua(x)).join(', ') + '}'
    return '{\n' + v.map((x) => inner + toLua(x, inner) + ',\n').join('') + indent + '}'
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  if (!entries.length) return '{}'
  const key = (k: string) => (/^-?\d+$/.test(k) ? `[${k}]` : IDENT.test(k) ? k : `[${luaString(k)}]`)
  const flat = entries.every(([, x]) => typeof x !== 'object' || x === null)
  if (flat) return '{ ' + entries.map(([k, x]) => `${key(k)} = ${toLua(x)}`).join(', ') + ' }'
  return '{\n' + entries.map(([k, x]) => `${inner}${key(k)} = ${toLua(x, inner)},\n`).join('') + indent + '}'
}

/** The whole file. `at` (Unix seconds) is the send time, shown in game. */
export function exportLua(exp: GameExport, at: number): string {
  return '-- Written by the Forever shuffle app (File > Link game addon folder). Do not edit: it is replaced when your\n' +
    '-- favorites or settings change. /reload in game to load a new copy.\n' +
    'BavvbScanFavorites = ' + toLua({ ...exp, at }) + '\n'
}
