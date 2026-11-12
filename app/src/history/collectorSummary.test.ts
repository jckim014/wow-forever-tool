// The auction collector (collector/syncLib.mjs, plain Node, no app imports) computes per-item summaries for the API
// snapshots on Josh's F: drive. They must equal the app's own figures (pricesFromUnits) so the app can use them as
// prices later. This checks both on random listings.
import { describe, expect, it } from 'vitest'
import { addListing, pricesFromUnits, type UnitsByItem } from '../prices/auctioneer'
import { summarizeUnits } from '../../../collector/syncLib.mjs'

function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
}

describe('collector summaries match the app', () => {
  it('on 2,000 random items', () => {
    const rnd = random(42)
    const app: UnitsByItem = new Map()
    const col = new Map<number, [number, number][]>()
    for (let item = 1; item <= 2000; item++) {
      const n = 1 + Math.floor(rnd() * 30)
      for (let i = 0; i < n; i++) {
        const count = 1 + Math.floor(rnd() * 20)
        const stack = count * (1 + Math.floor(rnd() * 100000))
        const odd = rnd() < 0.3 ? stack + Math.floor(rnd() * count) : stack // uneven per-unit prices too
        addListing(app, item, count, odd)
        const xs = col.get(item) ?? []
        xs.push([odd / count, count])
        col.set(item, xs)
      }
    }
    const fromApp = pricesFromUnits(app, 0, 0).items
    const fromCollector = summarizeUnits(col)
    expect(Object.keys(fromCollector).length).toBe(2000)
    for (const x of fromApp) {
      expect(fromCollector[String(x.item)]).toEqual([x.p1, x.p2, x.p3, x.units, x.listings])
    }
  })
})
