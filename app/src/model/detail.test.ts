// The detail card must reconcile to the model: line totals sum to the cheapest path, crafted reagents' sub-lines sum
// to qty x craft cost, and bought prices sum to buy-all. Runs on the real data (skips without the private edits).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import defaults from '../../../data/config/defaults.json'
import deTable from '../../../data/config/de-table.json'
import { compute, makeConfig, normalizeEdits, recipeDetail, type DeBand, type GameData, type Settings } from './index'

const ROOT = resolve(__dirname, '../../..')
const editsFile = resolve(ROOT, 'data/private/edits-v2.5.json')
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))

describe.skipIf(!existsSync(editsFile))('recipe detail reconciles to the model', () => {
  if (!existsSync(editsFile)) return
  const game: GameData = JSON.parse(readFileSync(resolve(ROOT, 'app/public/game-data.json'), 'utf8'))
  const config = makeConfig(defaults as { settings: Settings; cooldownCrafts: { namePrefixes: string[]; names: string[] } }, deTable as { bands: DeBand[] })
  const result = compute(game, config, normalizeEdits(JSON.parse(readFileSync(editsFile, 'utf8'))).edits)
  const details = result.recipes.map((r) => ({ r, d: recipeDetail(result, r, game) }))

  it('line totals sum to the cheapest path', () => {
    let checked = 0
    for (const { r, d } of details) {
      if (r.cheapest === null) {
        expect(d.unpricedReagents.length, r.recipe.name).toBeGreaterThan(0)
        continue
      }
      expect(close(d.lines.reduce((s, l) => s + l.total!, 0), r.cheapest), r.recipe.name).toBe(true)
      checked++
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('crafted reagents break down to their craft cost', () => {
    let checked = 0
    for (const { d } of details) {
      for (const l of d.lines) {
        if (!l.craft) continue
        const inter = result.intermediates.get(l.item)!
        expect(close(l.craft.lines.reduce((s, x) => s + x.total!, 0), l.qty * inter.craft!), l.name).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(50)
  })

  it('bought prices sum to buy-all', () => {
    for (const { r, d } of details) {
      if (r.buyAll === null) continue
      expect(close(d.lines.reduce((s, l) => s + l.qty * l.buyUnit!, 0), r.buyAll), r.recipe.name).toBe(true)
    }
  })

  it('marks exactly the best exit', () => {
    for (const { r, d } of details) {
      const best = d.exits.filter((e) => e.isBest)
      expect(best.map((e) => e.name), r.recipe.name).toEqual(r.bestExitName ? [r.bestExitName] : [])
      if (best[0]) expect(best[0].value).toBe(r.bestValue)
    }
  })
})
