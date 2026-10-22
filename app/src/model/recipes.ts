import { qtyMade } from './intermediates'
import type { DeBand, ExitName, GameData, IntermediateRow, Item, Money, PriceInfo, Recipe, RecipeRow, Settings } from './types'

const QUALITY: Record<number, string> = { 2: 'Uncommon', 3: 'Rare', 4: 'Epic' }

/** Python's round(): half to even (the workbook's vendor value is computed at build time with it). */
export function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export function deBandFor(item: Item | undefined, table: DeBand[]): DeBand | null {
  if (!item || (item.class !== 2 && item.class !== 4) || !item.quality || !(item.quality in QUALITY) || item.ilvl == null) return null
  const q = QUALITY[item.quality]
  const t = item.class === 2 ? 'Weapon' : 'Armor'
  return table.find((b) => b.quality === q && (b.type === 'Any' || b.type === t) && b.ilvlMin <= item.ilvl! && item.ilvl! <= b.ilvlMax) ?? null
}

export function deMultiplier(s: Settings): number {
  return s.salvagerOn ? (1 + s.salvagerFlatBonus) * (1 + s.salvagerProcChance * s.salvagerExtraPerProc) : 1
}

/** Expected value of one disenchant in a band, before the multiplier and the AH cut. */
export function deValuePerDisenchant(band: DeBand, price: (id: number) => PriceInfo) {
  let withChance = 0, priced = 0, value = 0
  for (const r of band.results) {
    const w = (r.chance || 0) * (((r.min ?? 0) + (r.max ?? 0)) / 2)
    const p = r.item == null ? null : price(r.item).selling
    if (w > 0) {
      withChance++
      if (p !== null) priced++
    }
    value += w * (p ?? 0)
  }
  return { withChance, priced, value: priced < withChance ? null : value }
}

const sub = (a: Money, b: Money): Money => (a === null || b === null ? null : a - b)
const beats = (v: Money, rv: number): 'Yes' | 'No' | null => (v === null ? null : v > rv ? 'Yes' : 'No')

export function computeRecipe(
  r: Recipe,
  game: GameData,
  settings: Settings,
  deTable: DeBand[],
  useChainsNo: Set<number>,
  price: (id: number) => PriceInfo,
  inter: Map<number, IntermediateRow>,
): RecipeRow {
  const item = game.items[String(r.product)]
  const name = (id: number) => game.items[String(id)]?.name ?? `Item ${id}`
  const q = qtyMade(r)
  const cut = 1 - settings.ahCut

  // vendor
  const unitSell = item?.sell ?? null
  const vendorValue = unitSell === null ? null : roundHalfEven(unitSell * q)
  let reagentsVendorValue = 0, reagentsWithoutSell = 0
  for (const g of r.reagents) {
    const s = game.items[String(g.item)]?.sell
    if (s == null) reagentsWithoutSell++
    else reagentsVendorValue += s * g.qty
  }

  // reagent costs
  const useChains = !useChainsNo.has(r.id)
  let buyAll: Money = 0, cheapest: Money = 0, reagentsPriced = 0
  const crafted: string[] = []
  for (const g of r.reagents) {
    const p = price(g.item).reagent
    const row = inter.get(g.item)
    const best = useChains && row ? row.best : p
    if (p !== null) reagentsPriced++
    buyAll = p === null || buyAll === null ? null : buyAll + g.qty * p
    cheapest = best === null || cheapest === null ? null : cheapest + g.qty * best
    if (useChains && row?.source === 'Craft') crafted.push(`${g.qty}x ${name(g.item)}`)
  }

  // disenchant
  const band = deBandFor(item, deTable)
  let deValue: Money = null, deWith = 0, dePriced = 0
  if (band) {
    const v = deValuePerDisenchant(band, price)
    deWith = v.withChance
    dePriced = v.priced
    deValue = v.value === null ? null : v.value * q * deMultiplier(settings) * cut
  }

  // auction house (a price of 0 counts as unpriced)
  const pp = price(r.product)
  const ahPrice = pp.selling || null
  const ahSource = ahPrice === null ? null : pp.typed !== null ? 'Typed' : 'Imported'
  const ahValue = ahPrice === null ? null : ahPrice * q * cut

  // best exit: highest priced value; ties go to the earlier exit (Vendor, Disenchant, AH)
  const exits: [ExitName, Money][] = []
  if (vendorValue !== null) exits.push(['Vendor', vendorValue])
  if (band) exits.push(['Disenchant', deValue])
  exits.push(['AH', ahValue])
  const priced = exits.filter((e): e is [ExitName, number] => e[1] !== null)
  const max = priced.length ? Math.max(...priced.map((e) => e[1])) : null
  const unpriced = exits.filter((e) => e[0] !== 'Vendor' && e[1] === null).map((e) => (e[0] === 'Disenchant' ? 'DE' : e[0]))
  const suffix = unpriced.length ? ` (${unpriced.join(', ')} unpriced)` : ''
  const bestExit = (max === null ? 'No priced exit' : priced.find((e) => e[1] === max)![0]) + suffix

  const vendorBeats = vendorValue === null ? 'No sell price' : vendorValue > reagentsVendorValue ? 'Yes' : 'No'
  const deBeats = band ? beats(deValue, reagentsVendorValue) : null
  const ahBeats = beats(ahValue, reagentsVendorValue)
  const anyYes = vendorBeats === 'Yes' || deBeats === 'Yes' || ahBeats === 'Yes'

  return {
    recipe: r, productName: name(r.product), qtyMade: q,
    unitSell, vendorValue, reagentsVendorValue, reagentsWithoutSell, vendorBeats,
    buyAll, reagentsPriced, useChains, cheapest, craftedInputs: crafted.length ? crafted.join(', ') : null,
    quality: item?.quality ?? null, ilvl: item?.ilvl ?? null, deBand: band, deValue,
    deMaterialsWithChance: deWith, deMaterialsPriced: dePriced, deBeats,
    ahPrice, ahSource, ahValue, ahBeats,
    profitVendor: sub(vendorValue, cheapest), profitDE: sub(deValue, cheapest), profitAH: sub(ahValue, cheapest),
    bestExit, profitBest: sub(max, cheapest),
    beatsAny: anyYes ? 'Yes' : 'No' + suffix,
  }
}
