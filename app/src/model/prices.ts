import type { ApiPrices, Edits, GameData, ImportRow, Money, PriceInfo, Settings } from './types'

/** Price per item ID for the chosen column; 0 or blank counts as no price. First row for an ID wins. */
function columnPrices(rows: ImportRow[], settings: Settings): Map<number, number> {
  const col = (`p${settings.importColumn}`) as 'p1' | 'p2' | 'p3'
  const out = new Map<number, number>()
  const seen = new Set<number>()
  for (const row of rows) {
    if (seen.has(row.item)) continue
    seen.add(row.item)
    const v = row[col]
    if (typeof v === 'number' && v !== 0) out.set(row.item, v)
  }
  return out
}

export interface ImportedPrice {
  value: number
  source: 'Imported' | 'API'
}

/**
 * The imported price per item: from the price import (if Use imported prices is on) and the API auction data (if
 * Use API prices is on and data was found). Where both have the item, the newer one wins: the import's scan time
 * (or import time, when the file doesn't say) against the API snapshot's time; a tie goes to the import.
 * Where only one has it, that one is used.
 */
export function importedPrices(edits: Edits, settings: Settings, api: ApiPrices | null = null): Map<number, ImportedPrice> {
  const scan = settings.useImports ? columnPrices(edits.imports, settings) : new Map<number, number>()
  const fromApi = settings.useApiPrices && api ? columnPrices(api.rows, settings) : new Map<number, number>()
  const scanTime = edits.importsInfo ? Date.parse(edits.importsInfo.dataAt ?? edits.importsInfo.at) : -Infinity
  const apiNewer = api !== null && Date.parse(api.at) > scanTime
  const out = new Map<number, ImportedPrice>()
  for (const [item, value] of scan) out.set(item, { value, source: 'Imported' })
  for (const [item, value] of fromApi) {
    if (apiNewer || !out.has(item)) out.set(item, { value, source: 'API' })
  }
  return out
}

export function vendorBuyPrice(game: GameData, edits: Edits, id: number): Money {
  const k = String(id)
  if (k in edits.vendorBuyOverrides) return edits.vendorBuyOverrides[k]
  return game.items[k]?.buy ?? null
}

/** Returns a memoised lookup of each item's prices. */
export function makePriceLookup(game: GameData, edits: Edits, settings: Settings, api: ApiPrices | null = null): (id: number) => PriceInfo {
  const imported = importedPrices(edits, settings, api)
  const cache = new Map<number, PriceInfo>()
  return (id: number) => {
    let p = cache.get(id)
    if (p) return p
    const typed = edits.typedPrices[String(id)] ?? null
    const vendorBuy = vendorBuyPrice(game, edits, id)
    const ip = imported.get(id) ?? null
    const imp = ip?.value ?? null
    let reagent: Money = null
    let reagentSource: PriceInfo['reagentSource'] = null
    if (typed !== null) [reagent, reagentSource] = [typed, 'Typed']
    else if (settings.useVendorBuy && vendorBuy !== null) [reagent, reagentSource] = [vendorBuy, 'Vendor buy']
    else if (ip !== null) [reagent, reagentSource] = [ip.value, ip.source]
    p = { typed, vendorBuy, imported: imp, importedSource: ip?.source ?? null, reagent, reagentSource, selling: typed ?? imp }
    cache.set(id, p)
    return p
  }
}
