// BavvbScan (Josh's own addon, addon/BavvbScan in this repo) -> imported prices.
//
// The addon saves the latest complete full scan: every listing with a buyout, per item ID as a string
// "count:stackBuyout,count:stackBuyout,...". The prices are worked out exactly as for Auctioneer (pricesFromUnits):
// p1 lowest buyout per unit, p2 unit-weighted median, p3 average of the cheapest 15% of units.
//
// File (SavedVariables\BavvbScan.lua): BavvbScanDB = { lastRequest = <unix>, scan = { format = "bavvbscan",
// version = 1, realm, faction, time = <unix>, auctions, listings, bidOnly, skipped, items = { [id] = "c:b,..." } } }
import { unzipSync } from 'fflate'
import { addListing, field, indexOf, pricesFromUnits, Reader, type AuctioneerResult, type UnitsByItem } from './auctioneer'

export const isBavvbScan = (raw: Uint8Array) => indexOf(raw.subarray(0, 4096), 'BavvbScanDB') >= 0

/** Finds BavvbScan.lua in a .zip (or takes a bare .lua). Throws if a zip has none. */
export function bavvbScanBytes(fileName: string, data: Uint8Array): Uint8Array {
  if (data[0] !== 0x50 || data[1] !== 0x4b) return data
  const files = unzipSync(data, { filter: (f) => f.name.toLowerCase().endsWith('bavvbscan.lua') })
  const name = Object.keys(files)[0]
  if (!name) throw new Error(`No BavvbScan.lua inside ${fileName}.`)
  return files[name]
}

export interface BavvbScan {
  /** "Realm_Faction", like an Auctioneer server key. */
  server: string
  /** When the scan was saved (Unix seconds). */
  scanTime: number
  /** Listings the addon could not read (data never loaded), not in the prices. */
  skipped: number
  result: AuctioneerResult
}

export function readBavvbScan(raw: Uint8Array): BavvbScan {
  const start = indexOf(raw, 'BavvbScanDB')
  if (start < 0) throw new Error('No BavvbScanDB in this file. Is it BavvbScan.lua from SavedVariables?')
  const r = new Reader(raw, true)
  r.i = raw.indexOf(123, start)
  if (r.i < 0) throw new Error('BavvbScan.lua has no saved data yet: run /bscan at the auction house, then /reload.')
  const scan = field(r.table(), 'scan')
  if (!scan || typeof scan !== 'object') throw new Error('BavvbScan.lua has no scan yet: run /bscan at the auction house, wait for "Scan saved", then /reload.')
  const fmt = field(scan, 'format'), version = field(scan, 'version')
  if (fmt !== 'bavvbscan' || version !== 1) throw new Error(`BavvbScan.lua holds format ${String(fmt)} version ${String(version)}; this app reads version 1.`)
  const num = (k: string) => {
    const v = field(scan, k)
    return typeof v === 'number' ? v : 0
  }
  const items = field(scan, 'items')
  const byItem: UnitsByItem = new Map()
  if (items && typeof items === 'object') {
    for (const [id, v] of items.map) {
      if (typeof id !== 'number' || typeof v !== 'string') continue
      for (const pair of v.split(',')) {
        const [count, buyout] = pair.split(':').map(Number)
        if (count > 0 && buyout > 0) addListing(byItem, id, count, buyout)
      }
    }
  }
  if (!byItem.size) throw new Error('The saved scan has no listings.')
  const realm = field(scan, 'realm'), faction = field(scan, 'faction')
  return {
    server: `${typeof realm === 'string' ? realm : 'Realm'}_${typeof faction === 'string' ? faction : 'Faction'}`,
    scanTime: num('time'),
    skipped: num('skipped'),
    result: pricesFromUnits(byItem, num('auctions'), num('bidOnly')),
  }
}
