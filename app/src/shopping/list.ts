// Pure helpers for the Shopping view: what to buy for the chosen recipes, and the Auctionator import string.
// No UI code here. Reads the model's results; calculates no prices.
import type { Edits, GameData, Money, ModelResult, PriceSource, ShoppingEdits } from '../model'

export interface ShopLine {
  /** `${item}` for a reagent, `${parent}>${item}` for an ingredient of a craftable reagent */
  key: string
  item: number
  name: string
  qty: number
  /** the craftable reagent this is an ingredient of (the "or" route), else null */
  parent: number | null
  /** for a craftable reagent: its maker, e.g. "Tailoring: Bolt of Runecloth" */
  maker: string | null
  unit: Money
  source: PriceSource | null
  /** a vendor sells it (curated vendor buy price) */
  vendor: boolean
  ticked: boolean
  /** ticked state differs from the default */
  edited: boolean
}

export function emptyShopping(): ShoppingEdits {
  return { recipes: [], ticks: {}, listName: null }
}

const itemName = (game: GameData, id: number) => game.items[String(id)]?.name ?? `Item ${id}`

/**
 * One line per reagent of the chosen recipes (merged by item), each followed by its ingredients when some recipe makes
 * it, scaled to make the whole amount. Default ticks follow the model's cheapest path: a reagent it crafts starts with
 * its ingredients ticked and itself unticked, otherwise the reagent is ticked and its ingredients not. A recipe with
 * Use chains off buys its reagents. Vendor-sold items always start unticked.
 */
export function shopLines(game: GameData, result: ModelResult, shopping: ShoppingEdits): ShopLine[] {
  const recipes = new Map(game.recipes.map((r) => [r.id, r]))
  const chains = new Map(result.recipes.map((r) => [r.recipe.id, r.useChains]))
  const need = new Map<number, number>()
  /** reagents that at least one chosen recipe would craft (its Use chains is on) */
  const chained = new Set<number>()
  for (const { id, count } of shopping.recipes) {
    const r = recipes.get(id)
    if (!r || !(count > 0)) continue
    for (const g of r.reagents) {
      need.set(g.item, (need.get(g.item) ?? 0) + g.qty * count)
      if (chains.get(id) !== false) chained.add(g.item)
    }
  }
  const line = (key: string, item: number, qty: number, parent: number | null, maker: string | null, dflt: boolean): ShopLine => {
    const p = result.prices(item)
    const vendor = p.vendorBuy !== null
    const def = dflt && !vendor
    const ticked = shopping.ticks[key] ?? def
    return { key, item, name: itemName(game, item), qty, parent, maker, unit: p.reagent, source: p.reagentSource, vendor, ticked, edited: ticked !== def }
  }
  const out: ShopLine[] = []
  for (const [item, qty] of need) {
    const inter = result.intermediates.get(item)
    const craft = !!inter && inter.source === 'Craft' && chained.has(item)
    out.push(line(String(item), item, qty, null, inter ? `${inter.profession}: ${inter.recipe.name}` : null, !craft))
    if (!inter) continue
    const crafts = Math.ceil(qty / inter.qtyMade)
    for (const g of inter.recipe.reagents) {
      out.push(line(`${item}>${g.item}`, g.item, crafts * g.qty, item, null, craft))
    }
  }
  return out
}

export function defaultListName(game: GameData, shopping: ShoppingEdits): string {
  const live = shopping.recipes.filter((r) => r.count > 0)
  if (live.length === 1) {
    const r = game.recipes.find((x) => x.id === live[0].id)
    if (r) return `${r.name} x${live[0].count}`
  }
  return 'Shuffle shopping'
}

// Auctionator's own separators; a name containing them would break the list.
const clean = (s: string) => s.replace(/[\^;"\r\n]/g, ' ').trim()

/**
 * Auctionator shopping-list import (Auctionator's Shopping > Import): `List^term^term`. A term is an advanced search:
 * 14 fields split by ";" (Source/Search/Advanced.lua): exact name in quotes, ..., tier "#" (none), expansion, quantity.
 * Ticked lines only; an item on several ticked lines gets their sum.
 */
export function auctionatorImport(listName: string, lines: ShopLine[]): string {
  const qty = new Map<number, { name: string; qty: number }>()
  for (const l of lines) {
    if (!l.ticked || l.qty <= 0) continue
    const cur = qty.get(l.item)
    if (cur) cur.qty += l.qty
    else qty.set(l.item, { name: l.name, qty: l.qty })
  }
  const terms = [...qty.values()].map((t) => [`"${clean(t.name)}"`, '', '', '', '', '', '', '', '', '', '', '#', '', String(t.qty)].join(';'))
  return [clean(listName) || 'Shuffle shopping', ...terms].join('^')
}

// ---------- edits ----------
const withShopping = (edits: Edits, shopping: ShoppingEdits): Edits => ({ ...edits, shopping })

export function addRecipe(edits: Edits, id: number): Edits {
  if (edits.shopping.recipes.some((r) => r.id === id)) return edits
  return withShopping(edits, { ...edits.shopping, recipes: [...edits.shopping.recipes, { id, count: 1 }] })
}

export function setCount(edits: Edits, id: number, count: number): Edits {
  return withShopping(edits, { ...edits.shopping, recipes: edits.shopping.recipes.map((r) => (r.id === id ? { id, count } : r)) })
}

/** Removing the last recipe also clears the ticks and list name. */
export function removeRecipe(edits: Edits, id: number): Edits {
  const recipes = edits.shopping.recipes.filter((r) => r.id !== id)
  return withShopping(edits, recipes.length ? { ...edits.shopping, recipes } : emptyShopping())
}

/** Ticking a line back to its default removes the edit. */
export function setTick(edits: Edits, line: ShopLine, on: boolean): Edits {
  const ticks = { ...edits.shopping.ticks }
  const dflt = line.edited ? !line.ticked : line.ticked
  if (on === dflt) delete ticks[line.key]
  else ticks[line.key] = on
  return withShopping(edits, { ...edits.shopping, ticks })
}

export function setListName(edits: Edits, name: string | null): Edits {
  return withShopping(edits, { ...edits.shopping, listName: name })
}
