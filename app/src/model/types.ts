// Money is in copper throughout. `null` means blank (unknown/unpriced), never zero.
export type Money = number | null

// ---------- game data (app/public/game-data.json) ----------
export interface Item {
  id: number
  name: string
  sell?: number
  buy?: number
  quality?: number // crafted items only: 2 Uncommon, 3 Rare, 4 Epic
  class?: number // 2 Weapon, 4 Armor
  ilvl?: number
}

export interface Reagent {
  item: number
  qty: number
}

export interface Recipe {
  id: number
  name: string
  profession: string
  skill: number | null
  product: number
  qtyMin: number
  qtyMax: number
  reagents: Reagent[]
}

export interface GameData {
  professions: string[]
  recipes: Recipe[]
  items: Record<string, Item>
}

// ---------- config (data/config) and edits ----------
export interface DeResult {
  item: number | null
  name: string
  chance: number
  min: number | null
  max: number | null
}

export interface DeBand {
  band: string
  quality: string // Uncommon | Rare | Epic
  type: string // Weapon | Armor | Any
  ilvlMin: number
  ilvlMax: number
  results: DeResult[]
  note: string
}

export interface Settings {
  useVendorBuy: boolean
  useImports: boolean
  importColumn: 1 | 2 | 3
  salvagerOn: boolean
  salvagerProcChance: number
  salvagerExtraPerProc: number
  salvagerFlatBonus: number
  ahCut: number
  chainsByProfession: Record<string, boolean>
}

export interface CooldownRule {
  namePrefixes: string[]
  names: string[]
}

export interface Config {
  settings: Settings
  cooldownCrafts: CooldownRule
  deTable: DeBand[]
}

export interface ImportRow {
  item: number
  name?: string | null
  p1: number | null
  p2: number | null
  p3: number | null
}

/** The user's edits, normalised. Every field is optional on top of the config defaults. */
export interface Edits {
  typedPrices: Record<string, number>
  /** Replaces Wowhead's vendor buy price; null = no vendor sells it. */
  vendorBuyOverrides: Record<string, number | null>
  settings: Partial<Settings>
  allowCrafting: Record<string, boolean>
  useChainsNo: number[]
  deTable: DeBand[] | null
  imports: ImportRow[]
}

// ---------- model output ----------
export type PriceSource = 'Typed' | 'Vendor buy' | 'Imported'

export interface PriceInfo {
  typed: Money
  vendorBuy: Money
  imported: Money
  /** typed, else vendor buy (if enabled), else imported */
  reagent: Money
  reagentSource: PriceSource | null
  /** typed, else imported; never a vendor price */
  selling: Money
}

export interface IntermediateRow {
  item: number
  name: string
  profession: string
  recipe: Recipe
  qtyMade: number
  depth: number
  allowCrafting: boolean
  allowDefault: boolean
  professionOn: boolean
  buy: Money
  craft: Money
  best: Money
  source: 'Buy' | 'Craft' | null
  /** reagent indexes priced at buy price to break a loop */
  loopBreaks: number[]
  alsoMadeBy: Recipe[]
}

export type ExitName = 'Vendor' | 'Disenchant' | 'AH'

export interface RecipeRow {
  recipe: Recipe
  productName: string
  /** "2x Linen Cloth, 1x Coarse Thread" */
  reagentsText: string
  qtyMade: number
  // vendor
  unitSell: Money
  vendorValue: Money
  reagentsVendorValue: number
  reagentsWithoutSell: number
  vendorBeats: 'Yes' | 'No' | 'No sell price'
  // costs
  buyAll: Money
  reagentsPriced: number
  useChains: boolean
  cheapest: Money
  craftedInputs: string | null
  // disenchant
  quality: number | null
  ilvl: number | null
  deBand: DeBand | null
  deValue: Money
  deMaterialsWithChance: number
  deMaterialsPriced: number
  deBeats: 'Yes' | 'No' | null
  // auction house
  ahPrice: Money
  ahSource: 'Typed' | 'Imported' | null
  ahValue: Money
  ahBeats: 'Yes' | 'No' | null
  // profits
  profitVendor: Money
  profitDE: Money
  profitAH: Money
  bestExit: string
  profitBest: Money
  beatsAny: string
}

export interface ModelResult {
  settings: Settings
  prices: (id: number) => PriceInfo
  intermediates: Map<number, IntermediateRow>
  recipes: RecipeRow[]
  loops: { item: number; reagent: number }[]
}
