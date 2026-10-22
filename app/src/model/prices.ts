import type { Edits, GameData, Money, PriceInfo, Settings } from './types'

/** Imported price per item ID for the chosen column; 0 or blank counts as no price. First row for an ID wins. */
export function importedPrices(edits: Edits, settings: Settings): Map<number, number> {
  const col = (`p${settings.importColumn}`) as 'p1' | 'p2' | 'p3'
  const out = new Map<number, number>()
  const seen = new Set<number>()
  for (const row of edits.imports) {
    if (seen.has(row.item)) continue
    seen.add(row.item)
    const v = row[col]
    if (typeof v === 'number' && v !== 0) out.set(row.item, v)
  }
  return out
}

export function vendorBuyPrice(game: GameData, edits: Edits, id: number): Money {
  const k = String(id)
  if (k in edits.vendorBuyOverrides) return edits.vendorBuyOverrides[k]
  return game.items[k]?.buy ?? null
}

/** Returns a memoised lookup of each item's prices. */
export function makePriceLookup(game: GameData, edits: Edits, settings: Settings): (id: number) => PriceInfo {
  const imported = settings.useImports ? importedPrices(edits, settings) : new Map<number, number>()
  const cache = new Map<number, PriceInfo>()
  return (id: number) => {
    let p = cache.get(id)
    if (p) return p
    const typed = edits.typedPrices[String(id)] ?? null
    const vendorBuy = vendorBuyPrice(game, edits, id)
    const imp = imported.get(id) ?? null
    let reagent: Money = null
    let reagentSource: PriceInfo['reagentSource'] = null
    if (typed !== null) [reagent, reagentSource] = [typed, 'Typed']
    else if (settings.useVendorBuy && vendorBuy !== null) [reagent, reagentSource] = [vendorBuy, 'Vendor buy']
    else if (imp !== null) [reagent, reagentSource] = [imp, 'Imported']
    p = { typed, vendorBuy, imported: imp, reagent, reagentSource, selling: typed ?? imp }
    cache.set(id, p)
    return p
  }
}
