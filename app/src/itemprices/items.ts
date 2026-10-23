// Pure helpers for the Prices view: one row per item the app prices, and the edits it makes (custom prices and
// vendor-buy curation). No UI code here.
import type { DeBand, Edits, GameData, Money, PriceInfo } from '../model'

export interface ItemUsage {
  /** Number of recipes that use the item as a reagent */
  reagentIn: number
  product: boolean
  deMaterial: boolean
  /** A reagent that some recipe makes */
  craftable: boolean
}

export interface ItemPriceRow {
  id: number
  name: string
  quality: number | null
  usage: ItemUsage
  /** Wowhead's vendor buy price, before the user's curation */
  wowheadBuy: Money
  /** undefined = not curated; null = no vendor sells it; number = the user's price */
  override: Money | undefined
  price: PriceInfo
  /** Bought as a reagent and also sold, and the two prices differ (only when the reagent price is a vendor price) */
  differs: boolean
  /** The price this item needs for what it is used for is missing (cost for a reagent, selling for a product or DE material) */
  unpriced: boolean
}

export type UsageKey = 'reagent' | 'deMaterial' | 'product' | 'craftable'

export const hasUsage = (u: ItemUsage, k: UsageKey) =>
  k === 'reagent' ? u.reagentIn > 0 : k === 'deMaterial' ? u.deMaterial : k === 'product' ? u.product : u.craftable

export function itemPriceRows(game: GameData, deTable: DeBand[], edits: Edits, price: (id: number) => PriceInfo): ItemPriceRow[] {
  const usage = new Map<number, ItemUsage>()
  const names = new Map<number, string>()
  const use = (id: number) => {
    let u = usage.get(id)
    if (!u) usage.set(id, (u = { reagentIn: 0, product: false, deMaterial: false, craftable: false }))
    return u
  }
  for (const r of game.recipes) {
    use(r.product).product = true
    for (const id of new Set(r.reagents.map((x) => x.item))) use(id).reagentIn++
  }
  for (const b of deTable) {
    for (const res of b.results) {
      if (res.item === null) continue
      use(res.item).deMaterial = true
      names.set(res.item, res.name)
    }
  }
  const rows: ItemPriceRow[] = []
  for (const [id, u] of usage) {
    u.craftable = u.reagentIn > 0 && u.product
    const item = game.items[String(id)]
    const k = String(id)
    const p = price(id)
    rows.push({
      id,
      name: item?.name ?? names.get(id) ?? `Item ${id}`,
      quality: item?.quality ?? null,
      usage: u,
      wowheadBuy: item?.buy ?? null,
      override: k in edits.vendorBuyOverrides ? edits.vendorBuyOverrides[k] : undefined,
      price: p,
      differs: u.reagentIn > 0 && (u.product || u.deMaterial) && p.reagent !== p.selling,
      unpriced: (u.reagentIn > 0 && p.reagent === null) || ((u.product || u.deMaterial) && p.selling === null),
    })
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Sets (or with null, clears) the custom price of an item. */
export function setCustomPrice(edits: Edits, id: number, v: Money): Edits {
  const typedPrices = { ...edits.typedPrices }
  if (v === null) delete typedPrices[String(id)]
  else typedPrices[String(id)] = v
  return { ...edits, typedPrices }
}

/** Vendor-buy curation: 'wowhead' removes the override; null = no vendor sells it; a number = the user's price. */
export function setVendorBuy(edits: Edits, id: number, v: 'wowhead' | Money): Edits {
  const vendorBuyOverrides = { ...edits.vendorBuyOverrides }
  if (v === 'wowhead') delete vendorBuyOverrides[String(id)]
  else vendorBuyOverrides[String(id)] = v
  return { ...edits, vendorBuyOverrides }
}

/** Copper <-> gold / silver / copper boxes. */
export const splitMoney = (v: number) => {
  const c = Math.round(v)
  return { g: Math.floor(c / 10000), s: Math.floor((c % 10000) / 100), c: c % 100 }
}
export const joinMoney = (g: number, s: number, c: number) => g * 10000 + s * 100 + c
