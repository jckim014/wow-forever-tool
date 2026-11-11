import { describe, expect, it } from 'vitest'
import { config } from '../data'
import { compute, emptyEdits, type Edits, type GameData } from '../model'
import { parseDoc, docText } from '../storage/doc'
import { addRecipe, auctionatorImport, defaultListName, removeRecipe, setCount, setTick, shopLines } from './list'

// Runecloth Bag as in game-data.json, plus a recipe that makes 2 to check rounding up.
const game: GameData = {
  professions: ['Tailoring', 'Alchemy'],
  items: {
    '14047': { id: 14047, name: 'Runecloth', sell: 400 },
    '14048': { id: 14048, name: 'Bolt of Runecloth', sell: 2000 },
    '8170': { id: 8170, name: 'Rugged Leather', sell: 500, buy: 2000 },
    '14341': { id: 14341, name: 'Rune Thread', sell: 1250, buy: 5000 },
    '249430': { id: 249430, name: 'Magenta Dye', sell: 250 },
    '249409': { id: 249409, name: 'Cerulean Dye', sell: 75 },
    '14046': { id: 14046, name: 'Runecloth Bag', sell: 5000, quality: 1, class: 1, ilvl: 55 },
    '900': { id: 900, name: 'Herb', sell: 10 },
    '901': { id: 901, name: 'Paste', sell: 10 },
    '902': { id: 902, name: 'Thing', sell: 100 },
  },
  recipes: [
    { id: 18401, name: 'Bolt of Runecloth', profession: 'Tailoring', skill: 210, product: 14048, qtyMin: 1, qtyMax: 1, reagents: [{ item: 14047, qty: 5 }] },
    { id: 18405, name: 'Runecloth Bag', profession: 'Tailoring', skill: 215, product: 14046, qtyMin: 1, qtyMax: 1, reagents: [
      { item: 14048, qty: 5 }, { item: 8170, qty: 2 }, { item: 14341, qty: 1 }, { item: 249430, qty: 4 }, { item: 249409, qty: 2 }] },
    { id: 1, name: 'Paste', profession: 'Alchemy', skill: 1, product: 901, qtyMin: 2, qtyMax: 2, reagents: [{ item: 900, qty: 3 }] },
    { id: 2, name: 'Thing', profession: 'Alchemy', skill: 1, product: 902, qtyMin: 1, qtyMax: 1, reagents: [{ item: 901, qty: 3 }, { item: 14047, qty: 1 }] },
  ],
}
// Josh's curation: nobody sells Rugged Leather.
const base: Edits = { ...emptyEdits(), vendorBuyOverrides: { '8170': null } }
const lines = (e: Edits) => shopLines(game, compute(game, config, e), e.shopping)
// Crafting bolts is cheaper: 5 x 1s cloth vs 10s a bolt.
const cheapCloth: Edits = { ...base, typedPrices: { '14047': 100, '14048': 1000 } }

describe('Shopping list', () => {
  it('Runecloth Bag x20, bolts bought: cloth shown but unticked, Rune Thread left out', () => {
    const e = setCount(addRecipe(base, 18405), 18405, 20)
    const ls = lines(e)
    expect(ls.map((l) => [l.name, l.qty, l.parent, l.ticked])).toEqual([
      ['Bolt of Runecloth', 100, null, true],
      ['Runecloth', 500, 14048, false],
      ['Rugged Leather', 40, null, true],
      ['Rune Thread', 20, null, false],
      ['Magenta Dye', 80, null, true],
      ['Cerulean Dye', 40, null, true],
    ])
    expect(defaultListName(game, e.shopping)).toBe('Runecloth Bag x20')
    expect(auctionatorImport('Runecloth Bag x20', ls)).toBe(
      'Runecloth Bag x20^"Bolt of Runecloth";;;;;;;;;;;#;;100^"Rugged Leather";;;;;;;;;;;#;;40'
      + '^"Magenta Dye";;;;;;;;;;;#;;80^"Cerulean Dye";;;;;;;;;;;#;;40')
  })

  it('merges recipes, rounds crafts up, and sums an item on several ticked lines', () => {
    let e = setCount(addRecipe(cheapCloth, 18405), 18405, 1)
    e = setCount(addRecipe(e, 2), 2, 3)
    const ls = lines(e)
    // Thing x3 needs 9 Paste; Paste makes 2, so 5 crafts = 15 Herb
    expect(ls.find((l) => l.key === '901>900')?.qty).toBe(15)
    // Runecloth: 1 x 3 direct for Thing, 25 via bolts for the bag
    expect(ls.filter((l) => l.item === 14047).map((l) => l.qty)).toEqual([25, 3])
    expect(auctionatorImport('x', ls)).toContain('"Runecloth";;;;;;;;;;;#;;28')
    expect(defaultListName(game, e.shopping)).toBe('Shuffle shopping')
  })

  it('ticks: changing a default is kept, changing it back removes the edit', () => {
    let e = setCount(addRecipe(base, 18405), 18405, 2)
    const thread = () => lines(e).find((l) => l.item === 14341)!
    e = setTick(e, thread(), true)
    expect(e.shopping.ticks).toEqual({ '14341': true })
    expect(thread()).toMatchObject({ ticked: true, edited: true })
    e = setTick(e, thread(), false)
    expect(e.shopping.ticks).toEqual({})
    expect(auctionatorImport('x', lines(e))).not.toContain('Rune Thread')
  })

  it('defaults follow the cheapest path: craft when the model crafts, else buy', () => {
    const bolt = (e: Edits) => {
      const ls = lines(setCount(addRecipe(e, 18405), 18405, 1))
      return [ls.find((l) => l.key === '14048')!.ticked, ls.find((l) => l.key === '14048>14047')!.ticked]
    }
    expect(bolt(cheapCloth)).toEqual([false, true])
    expect(bolt({ ...cheapCloth, allowCrafting: { '14048': false } })).toEqual([true, false]) // crafting off for the item
    expect(bolt({ ...cheapCloth, useChainsNo: [18405] })).toEqual([true, false]) // the recipe buys its reagents
    expect(bolt({ ...cheapCloth, settings: { chainsByProfession: { Tailoring: false } } })).toEqual([true, false]) // profession off
  })

  it('round-trips through the saved file; removing the last recipe clears the list', () => {
    let e = setCount(addRecipe(base, 18405), 18405, 4)
    e = setTick(e, lines(e).find((l) => l.item === 8170)!, false)
    expect(parseDoc(docText(e)).edits.shopping).toEqual(e.shopping)
    expect(removeRecipe(e, 18405).shopping).toEqual(emptyEdits().shopping)
    expect(addRecipe(e, 18405)).toBe(e)
  })
})
