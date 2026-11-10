import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { bavvbScanBytes, isBavvbScan, readBavvbScan } from './bavvbscan'
import { isAuctioneerScan } from './auctioneer'

const LINEN = 2589, SILK = 4306, AXE = 15268

/** BavvbScan.lua as WoW writes SavedVariables (keys sorted, one per line). */
const file = `
BavvbScanDB = {
["lastRequest"] = 1794000000,
["scan"] = {
["auctions"] = 8,
["bidOnly"] = 1,
["faction"] = "Alliance",
["format"] = "bavvbscan",
["items"] = {
[${LINEN}] = "64:1664,20:600,16:800",
[${SILK}] = "3:1000,1:200",
[${AXE}] = "1:9000",
},
["listings"] = 6,
["realm"] = "Normal",
["skipped"] = 1,
["time"] = 1794000045,
["version"] = 1,
},
}
`
const bytes = new TextEncoder().encode(file)

describe('BavvbScan reader', () => {
  it('recognises the file', () => {
    expect(isBavvbScan(bytes)).toBe(true)
    expect(isAuctioneerScan(bytes)).toBe(false)
    expect(isBavvbScan(new TextEncoder().encode('AucScanData = {'))).toBe(false)
  })

  it('prices exactly as the Auctioneer reader: lowest, unit-weighted median, cheapest 15% of units', () => {
    const s = readBavvbScan(bytes)
    expect(s.server).toBe('Normal_Alliance')
    expect(s.scanTime).toBe(1794000045)
    expect(s.skipped).toBe(1)
    expect(s.result.listings).toBe(8)
    expect(s.result.noBuyout).toBe(1)
    const by = new Map(s.result.rows.map((x) => [x.item, x]))
    // The same listings as the Auctioneer test fixture, so the same figures.
    expect(by.get(LINEN)).toEqual({ item: LINEN, name: null, p1: 26, p2: 26, p3: 26 })
    expect(by.get(SILK)).toEqual({ item: SILK, name: null, p1: 200, p2: 333, p3: 200 })
    expect(by.get(AXE)).toEqual({ item: AXE, name: null, p1: 9000, p2: 9000, p3: 9000 })
    expect(s.result.items.find((x) => x.item === LINEN)).toMatchObject({ units: 100, listings: 3 })
  })

  it('takes the file out of a zip', () => {
    const z = zipSync({ 'SavedVariables/BavvbScan.lua': bytes, 'Auctionator.lua': new Uint8Array(1) })
    expect(readBavvbScan(bavvbScanBytes('scan.zip', z)).server).toBe('Normal_Alliance')
    expect(() => bavvbScanBytes('x.zip', zipSync({ 'a.txt': Uint8Array.of(1) }))).toThrow('No BavvbScan.lua')
  })

  it('explains a file with no scan yet', () => {
    const empty = new TextEncoder().encode('\nBavvbScanDB = {\n["lastRequest"] = 1794000000,\n}\n')
    expect(() => readBavvbScan(empty)).toThrow('no scan yet')
    const other = new TextEncoder().encode('\nBavvbScanDB = {\n["scan"] = {\n["format"] = "bavvbscan",\n["version"] = 2,\n},\n}\n')
    expect(() => readBavvbScan(other)).toThrow('version 2')
  })
})
