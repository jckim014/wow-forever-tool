import { describe, expect, it } from 'vitest'
import defaults from '../../../data/config/defaults.json'
import { compute, emptyEdits, makeConfig, type DeBand, type Edits, type GameData, type Settings } from '../model'
import { buildExport, exportLua, toLua } from './export'

const band: DeBand = { band: 'Uncommon 21-25', quality: 'Uncommon', type: 'Any', ilvlMin: 21, ilvlMax: 25, note: '', results: [
  { item: 900, name: 'Dust', chance: 0.75, min: 2, max: 3 },
  { item: null, name: '', chance: 0, min: null, max: null },
] }
const config = makeConfig(defaults as { settings: Settings; cooldownCrafts: { namePrefixes: string[]; names: string[] } }, { bands: [band] })

// Bag <- 2 Bolt + 1 Thread (vendor); Bolt <- 3 Cloth; Unrelated recipe stays out.
const game: GameData = {
  professions: ['Tailoring'],
  items: {
    1: { id: 1, name: 'Bag "Big"', sell: 500, quality: 2, class: 4, ilvl: 22, bind: 'equip' },
    2: { id: 2, name: 'Bolt', sell: 40 },
    3: { id: 3, name: 'Cloth', sell: 10 },
    4: { id: 4, name: 'Thread', sell: 25, buy: 100 },
    5: { id: 5, name: 'Unrelated', sell: 1 },
    900: { id: 900, name: 'Dust' },
  },
  recipes: [
    { id: 10, name: 'Bag', profession: 'Tailoring', skill: 100, product: 1, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2, qty: 2 }, { item: 4, qty: 1 }] },
    { id: 11, name: 'Bolt', profession: 'Tailoring', skill: 50, product: 2, qtyMin: 1, qtyMax: 1, reagents: [{ item: 3, qty: 3 }] },
    { id: 12, name: 'Unrelated', profession: 'Tailoring', skill: 1, product: 5, qtyMin: 1, qtyMax: 1, reagents: [{ item: 3, qty: 1 }] },
  ],
}

const run = (e: Partial<Edits>) => {
  const edits = { ...emptyEdits(), favorites: { groups: [{ id: 'g1', name: 'Bags', recipes: [10, 999] }] }, ...e }
  return buildExport(game, compute(game, config, edits), edits, [band])
}

describe('buildExport', () => {
  it('takes the favorites and every reagent chain they reach, nothing else', () => {
    const x = run({})
    expect(x.groups).toEqual([{ name: 'Bags', recipes: [10] }]) // 999 no longer exists
    expect(Object.keys(x.recipes).sort()).toEqual(['10', '11'])
    expect(x.recipes[10]).toEqual({ name: 'Bag', profession: 'Tailoring', product: 1, made: 1, chains: true, reagents: [[2, 2], [4, 1]] })
    expect(x.inter).toEqual({ 2: { recipe: 11, craft: true, breaks: [] } })
    expect(Object.keys(x.items).map(Number)).toEqual([1, 2, 3, 4, 900])
    expect(x.items[1]).toEqual({ name: 'Bag "Big"', sell: 500, bind: 'equip', de: 1 })
    expect(x.bands).toEqual([{ band: 'Uncommon 21-25', results: [[900, 0.75, 2.5], [0, 0, 0]] }])
  })

  it('applies the edits: custom price, vendor buy, Allow crafting, Use chains, settings', () => {
    const x = run({ typedPrices: { 3: 7 }, allowCrafting: { 2: false }, useChainsNo: [10], settings: { ahCut: 0.1 } })
    expect(x.items[3].typed).toBe(7)
    expect(x.items[4].vendor).toBe(100)
    expect(x.inter[2].craft).toBe(false)
    expect(x.recipes[10].chains).toBe(false)
    expect(x.settings).toMatchObject({ ahCut: 0.1, deMult: 1, column: 3 })
    const off = run({ settings: { useVendorBuy: false } })
    expect(off.items[4].vendor).toBeUndefined()
  })
})

describe('toLua', () => {
  it('writes Lua tables with numeric keys, escaped strings and sequences', () => {
    expect(toLua({ 12: { name: 'a"b\\c', ok: true }, list: [[1, 2], [3, 4]], e: {} }))
      .toBe('{\n  [12] = { name = "a\\"b\\\\c", ok = true },\n  list = {\n    {1, 2},\n    {3, 4},\n  },\n  e = {},\n}')
  })
  it('the whole file assigns one global', () => {
    expect(exportLua(run({}), 1795480000)).toMatch(/\nBavvbScanFavorites = \{\n[\s\S]*  at = 1795480000,\n\}\n$/)
  })
})
