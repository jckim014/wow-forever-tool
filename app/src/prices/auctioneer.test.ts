import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { auctioneerBytes, isAuctioneerScan, pricesFromScan, scanServers } from './auctioneer'

// ---------- fixture: a synthetic Auc-ScanData.lua, laid out as Auctioneer writes it ----------
/** One listing with the 27 fields of Auc-Advanced/CoreConst.lua; only stack size, buyout and item ID matter here. */
function listing(item: number, name: string, count: number, buyout: number): string {
  const link = `|cnIQ1:|Hitem:${item}::::::::1:1491:::::::::|h[${name}]|h|r`
  const f = [JSON.stringify(link), 15, 0, 8, 'nil', 1, 3, 1793953520, JSON.stringify(name), 'nil', count, 1, 'false', 5,
    0, 0, buyout, 0, 'false', '""', 0, '""', item, 0, 0, 0, 0]
  return `{${f.join(',')},}`
}
const luaQuote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
const rope = (ls: string[]) => luaQuote(`return {${ls.join('')}}`)

function scanFile(servers: [string, string[][]][]): string {
  const scans = servers.map(([key, ropes]) => `["${key}"] = {
["scanstats"] = {
["ImageUpdated"] = 1793953529,
[0] = {
["serverKey"] = "${key}",
["query"] = {
["qryinfo"] = {
["query"] = nil --[[ skipped recursive table ]],
["sig"] = "######",
["finished"] = true,
},
},
["scanStoreTime"] = 4.659999999996217,
},
["LastFullScan"] = 1793953529,
},
["image"] = "rope",
["ropes"] = {
${ropes.map(rope).join(', -- [n]\n')},
},
},`).join('\n')
  return `\nAucScanData = {\n["Version"] = 1.4,\n["scans"] = {\n${scans}\n},\n}\n`
}

const LINEN = 2589, SILK = 4306, AXE = 15268
const file = scanFile([
  ['Realm_Alliance', [
    [
      listing(LINEN, 'Linen Cloth', 64, 1664), // 26 each
      listing(LINEN, 'Linen Cloth', 20, 600), // 30 each
      listing(LINEN, 'Linen Cloth', 16, 800), // 50 each
      listing(SILK, 'Silk "Cloth"', 1, 0), // bid only: skipped
      listing(SILK, 'Silk "Cloth"', 3, 1000), // 333.33 each
    ],
    [
      listing(SILK, 'Silk "Cloth"', 1, 200),
      listing(AXE, 'Twin-bladed Axe of Intellect', 1, 9000),
    ],
  ]],
  ['Realm_Horde', [[listing(LINEN, 'Linen Cloth', 1, 99)]]],
])
const bytes = new TextEncoder().encode(file)

describe('Auctioneer scan reader', () => {
  it('recognises a scan file and lists its server keys', () => {
    expect(isAuctioneerScan(bytes)).toBe(true)
    expect(isAuctioneerScan(new TextEncoder().encode('AUCTIONATOR_PRICE_DATABASE = {'))).toBe(false)
    const servers = scanServers(bytes)
    expect([...servers.keys()]).toEqual(['Realm_Alliance', 'Realm_Horde'])
    expect(servers.get('Realm_Alliance')).toHaveLength(2)
  })

  it('prices per unit: lowest, unit-weighted median, average of the cheapest 15% of units', () => {
    const r = pricesFromScan(scanServers(bytes).get('Realm_Alliance')!)
    expect(r.listings).toBe(7)
    expect(r.noBuyout).toBe(1)
    const by = new Map(r.rows.map((x) => [x.item, x]))
    // Linen: 100 units; 64 at 26, 20 at 30, 16 at 50. Median unit is in the 26 stack; the cheapest 15 units are all 26.
    expect(by.get(LINEN)).toEqual({ item: LINEN, name: null, p1: 26, p2: 26, p3: 26 })
    // Silk: 4 units; 1 at 200, 3 at 333.33. Median: 2 of 4 units reached at 333.33. Cheapest 15% = 0.6 unit -> 1 unit.
    expect(by.get(SILK)).toEqual({ item: SILK, name: null, p1: 200, p2: 333, p3: 200 })
    expect(by.get(AXE)).toEqual({ item: AXE, name: null, p1: 9000, p2: 9000, p3: 9000 })
    expect(r.rows.map((x) => x.item)).toEqual([LINEN, SILK, AXE])
  })

  it('averages across stacks when the cheapest 15% spans several', () => {
    // 20 units: 2 at 10, 18 at 40. Cheapest 15% = 3 units: (2*10 + 1*40) / 3 = 20.
    const f = new TextEncoder().encode(scanFile([['R', [[listing(1, 'A', 2, 20), listing(1, 'A', 18, 720)]]]]))
    expect(pricesFromScan(scanServers(f).get('R')!).rows[0]).toEqual({ item: 1, name: null, p1: 10, p2: 40, p3: 20 })
  })

  it('takes the scan out of a zip', () => {
    const z = zipSync({ 'SavedVariables/Auc-ScanData.lua': bytes, 'Auctionator.lua': new Uint8Array(1) })
    expect(scanServers(auctioneerBytes('scan.zip', z)).size).toBe(2)
    expect(() => auctioneerBytes('x.zip', zipSync({ 'a.txt': Uint8Array.of(1) }))).toThrow('No Auc-ScanData.lua')
  })

  it('explains an empty or foreign file', () => {
    expect(() => scanServers(new TextEncoder().encode('AucScanData = {\n["Version"] = 1.4,\n["scans"] = {\n},\n}'))).toThrow('no listings')
    expect(() => scanServers(new TextEncoder().encode('Foo = {}'))).toThrow('No AucScanData')
  })
})

// ---------- Josh's first Forever scan (2026-11-06), when present ----------
const REAL = resolve(__dirname, '../../../data/private/auctioneer-2026-11-06/Auc-ScanData.lua')
describe.skipIf(!existsSync(REAL))('Auctioneer: the real scan of 2026-11-06 (data/private)', () => {
  it('matches the figures shown to Josh', () => {
    const servers = scanServers(new Uint8Array(readFileSync(REAL)))
    expect([...servers.keys()]).toEqual(['CAMWOWUS1Realm3PvE_Alliance'])
    const r = pricesFromScan(servers.get('CAMWOWUS1Realm3PvE_Alliance')!)
    expect(r.listings).toBe(123969)
    expect(r.noBuyout).toBe(12)
    expect(r.rows).toHaveLength(2000)
    const by = new Map(r.rows.map((x) => [x.item, [x.p1, x.p2, x.p3]]))
    expect(by.get(2589)).toEqual([26, 29, 26]) // Linen Cloth
    expect(by.get(2592)).toEqual([83, 100, 93]) // Wool Cloth
    expect(by.get(4306)).toEqual([486, 487, 486]) // Silk Cloth
    expect(by.get(2772)).toEqual([950, 1300, 950]) // Iron Ore
    expect(by.get(11083)).toEqual([1300, 1499, 1316]) // Soul Dust
    expect(by.get(4234)).toEqual([801, 950, 841]) // Heavy Leather
  })
})
