import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { AuctioneerResult } from '../prices/auctioneer'
import { scanBaseName, scanSummary, summaryText } from './archive'
import { storedScans, writeScans, type DirHandle } from './folder'

const result: AuctioneerResult = {
  rows: [],
  items: [
    { item: 2589, p1: 26, p2: 29, p3: 26, units: 17489, listings: 620 },
    { item: 4306, p1: 486, p2: 487, p3: 486, units: 476, listings: 73 },
  ],
  listings: 700,
  noBuyout: 7,
}
const T = Math.floor(new Date(2026, 10, 6, 0, 25, 29).getTime() / 1000) // local time
const now = new Date(2026, 10, 6, 0, 40)

/** An in-memory folder with the parts of the File System Access API that folder.ts uses. */
function memoryFolder(perm: PermissionState = 'granted') {
  const files = new Map<string, Uint8Array | string>()
  const h: DirHandle = {
    name: 'price-history',
    async getFileHandle(name) {
      return {
        async createWritable() {
          let data: Uint8Array | string = ''
          return { async write(d) { data = d }, async close() { files.set(name, data) } }
        },
      }
    },
    async *keys() { yield* files.keys() },
    async queryPermission() { return perm },
    async requestPermission() { return perm },
  }
  return { h, files }
}

describe('price history archive', () => {
  it('names a scan by its local scan time and server key', () => {
    expect(scanBaseName('CAMWOWUS1Realm3PvE_Alliance', T)).toBe('2026-11-06_0025_CAMWOWUS1Realm3PvE_Alliance')
    expect(scanBaseName('My Realm: "X"/Horde', T)).toBe('2026-11-06_0025_My_Realm_X_Horde')
  })

  it('summarises a scan per item, readable JSON with one item per line', () => {
    const { base, summary } = scanSummary('R_Alliance', T, result, now, 'Auctioneer')
    expect(base).toBe('2026-11-06_0025_R_Alliance')
    expect(summary).toMatchObject({
      server: 'R_Alliance', scanTimeUnix: T, scanTimeFromFile: true, rawFile: `${base}.zip`, listings: 700, bidOnly: 7,
      items: { 2589: [26, 29, 26, 17489, 620], 4306: [486, 487, 486, 476, 73] },
    })
    const text = summaryText(summary)
    expect(JSON.parse(text)).toEqual(summary)
    expect(text).toContain('\n  "2589": [26,29,26,17489,620],\n')
  })

  it('uses the import time when the file has no scan time', () => {
    const { summary } = scanSummary('R', null, result, now, 'Auctioneer')
    expect(summary.scanTimeFromFile).toBe(false)
    expect(summary.scanTimeUnix).toBe(Math.floor(now.getTime() / 1000))
  })

  it('writes the zipped scan and the summary once, and skips a scan already stored', async () => {
    const { h, files } = memoryFolder()
    const raw = new TextEncoder().encode('AucScanData = {}')
    const scan = { ...scanSummary('R_Alliance', T, result, now, 'Auctioneer'), raw, rawName: 'Auc-ScanData.lua' }
    expect(await writeScans(h, [scan])).toEqual(['2026-11-06_0025_R_Alliance'])
    expect([...files.keys()]).toEqual(['2026-11-06_0025_R_Alliance.zip', '2026-11-06_0025_R_Alliance.json'])
    const unzipped = unzipSync(files.get('2026-11-06_0025_R_Alliance.zip') as Uint8Array)
    expect(new TextDecoder().decode(unzipped['Auc-ScanData.lua'])).toBe('AucScanData = {}')
    expect(await storedScans(h)).toEqual(new Set(['2026-11-06_0025_R_Alliance']))
    expect(await writeScans(h, [scan])).toEqual([])
  })
})
