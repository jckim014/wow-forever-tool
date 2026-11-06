// Price history: what is kept for each Auctioneer scan (pure; writing the files is in folder.ts).
//
// Per scan (one server key = realm_faction), two files in the history folder, named by when Auctioneer finished the
// scan (local time) and the server key:
//   2026-11-06_0025_CAMWOWUS1Realm3PvE_Alliance.zip   the whole Auc-ScanData.lua, zipped (every listing)
//   2026-11-06_0025_CAMWOWUS1Realm3PvE_Alliance.json  the per-item summary below
// The .json is written last, so its presence means the scan is fully stored; a scan already stored is skipped.
import type { AuctioneerResult } from '../prices/auctioneer'

export const SUMMARY_COLUMNS = ['lowest', 'median', 'cheapest15', 'units', 'listings'] as const

export interface ScanSummary {
  format: 'auctioneer-scan-summary'
  version: 1
  server: string
  /** When Auctioneer finished the scan (ISO, UTC), and the same as Unix seconds. */
  scanTime: string
  scanTimeUnix: number
  /** Whether scanTime came from the file (false: the file had no scan time, so the import time was used). */
  scanTimeFromFile: boolean
  importedAt: string
  /** The zip next to this file, holding the whole Auc-ScanData.lua. */
  rawFile: string
  listings: number
  bidOnly: number
  /** Per item ID, in copper per unit: lowest buyout, unit-weighted median, average of the cheapest 15% of units;
   *  then units listed with a buyout and the number of those listings. */
  columns: typeof SUMMARY_COLUMNS
  items: Record<string, [number, number, number, number, number]>
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-11-06_0025_CAMWOWUS1Realm3PvE_Alliance" (local time; characters Windows forbids in names become _). */
export function scanBaseName(server: string, scanTimeUnix: number): string {
  const d = new Date(scanTimeUnix * 1000)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${stamp}_${server.replace(/[<>:"/\\|?*\s]+/g, '_')}`
}

export function scanSummary(server: string, scanTimeUnix: number | null, r: AuctioneerResult, now: Date): { base: string; summary: ScanSummary } {
  const t = scanTimeUnix ?? Math.floor(now.getTime() / 1000)
  const base = scanBaseName(server, t)
  const items: ScanSummary['items'] = {}
  for (const x of r.items) items[String(x.item)] = [x.p1, x.p2, x.p3, x.units, x.listings]
  return {
    base,
    summary: {
      format: 'auctioneer-scan-summary', version: 1, server,
      scanTime: new Date(t * 1000).toISOString(), scanTimeUnix: t, scanTimeFromFile: scanTimeUnix !== null,
      importedAt: now.toISOString(), rawFile: `${base}.zip`,
      listings: r.listings, bidOnly: r.noBuyout, columns: SUMMARY_COLUMNS, items,
    },
  }
}

/** The summary as written: one item per line, so the file stays readable and diffs well. */
export function summaryText(s: ScanSummary): string {
  const { items, ...head } = s
  const lines = Object.entries(items).map(([id, v]) => `  ${JSON.stringify(id)}: ${JSON.stringify(v)}`)
  const top = JSON.stringify(head, null, 1).slice(0, -2) // without the closing "\n}"
  return `${top},\n "items": {\n${lines.join(',\n')}\n }\n}\n`
}
