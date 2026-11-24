// Pure: reading the auction collector's per-snapshot summaries (F:\ForeverAuctionData\summary\YYYY\MM\DD\<id>.json.gz,
// written by collector/sync.mjs; format "forever-auction-summary" v1) into API prices for one house.
import type { ApiPrices, ImportRow } from '../model'

/** "20261113T012242Z" -> "2026-11-13T01:22:42.000Z", or null if it isn't a snapshot id. */
export function snapshotIso(id: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id)
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null
}

/** Snapshot file names in a day folder, newest first (ids sort by time). */
export const snapshotFiles = (names: string[]) =>
  names.filter((n) => n.endsWith('.json.gz') && snapshotIso(n.slice(0, -8)) !== null).sort().reverse()

/** Year / month / day folder names, newest first. */
export const datedFolders = (names: string[], digits: number) =>
  names.filter((n) => n.length === digits && /^\d+$/.test(n)).sort().reverse()

/**
 * One summary's prices for `house`: per item [lowest, median, cheapest15, units, listings] -> p1, p2, p3 (the same
 * columns as a BavvbScan import). Returns null if the house isn't in this summary (it didn't change in that snapshot).
 * Throws on a file that isn't a collector summary.
 */
export function pricesFromSummary(text: string, house: number): ApiPrices | null {
  const s = JSON.parse(text) as {
    format?: string; version?: number; snapshot?: string
    houses?: Record<string, { items?: Record<string, number[]> }>
  }
  if (s.format !== 'forever-auction-summary' || s.version !== 1) throw new Error('not an auction collector summary (format forever-auction-summary v1)')
  const at = snapshotIso(s.snapshot ?? '')
  if (!at) throw new Error(`bad snapshot id ${JSON.stringify(s.snapshot)}`)
  const h = s.houses?.[String(house)]
  if (!h?.items) return null
  const rows: ImportRow[] = []
  for (const [id, v] of Object.entries(h.items)) {
    const item = Number(id)
    if (!Number.isInteger(item) || !Array.isArray(v)) continue
    rows.push({ item, name: null, p1: v[0] ?? null, p2: v[1] ?? null, p3: v[2] ?? null })
  }
  return { house, snapshot: s.snapshot!, at, rows }
}

/** Our sale-rate estimate (sales.json in the auction data folder, collector/salesFile.mjs): units sold per day. */
export interface SalesData {
  at: string
  days: number
  /** house -> hours of hourly snapshot pairs behind it, and item -> units per day */
  houses: Record<number, { hours: number; items: Map<number, number> }>
  /** TSM's region sold/day (pooled TSM users across Forever-US, from the TSM app's AppData.lua), when the sync could read it */
  tsm: { downloadTime: number | null; items: Map<number, number> } | null
}

/** Throws on a file that isn't the collector's sales.json. */
export function salesFromText(text: string): SalesData {
  const s = JSON.parse(text) as { format?: string; version?: number; at?: string; days?: number; houses?: Record<string, { hours?: number; items?: Record<string, number> }>; tsm?: { downloadTime?: number; items?: Record<string, number> } }
  if (s.format !== 'forever-sales' || s.version !== 1 || typeof s.at !== 'string') throw new Error('not the collector\'s sales.json (format forever-sales v1)')
  const houses: SalesData['houses'] = {}
  for (const [h, v] of Object.entries(s.houses ?? {})) {
    const items = new Map<number, number>()
    for (const [id, n] of Object.entries(v.items ?? {})) if (typeof n === 'number') items.set(Number(id), n)
    houses[Number(h)] = { hours: v.hours ?? 0, items }
  }
  let tsm: SalesData['tsm'] = null
  if (s.tsm && typeof s.tsm === 'object') {
    const items = new Map<number, number>()
    for (const [id, n] of Object.entries(s.tsm.items ?? {})) if (typeof n === 'number') items.set(Number(id), n)
    tsm = { downloadTime: s.tsm.downloadTime ?? null, items }
  }
  return { at: s.at, days: s.days ?? 7, houses, tsm }
}

/** "47 min ago", "2.5 h ago", "3 days ago". */
export function ageText(iso: string, now: number): string {
  const min = Math.max(0, (now - Date.parse(iso)) / 60000)
  if (min < 90) return `${Math.round(min)} min ago`
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h ago`
  return `${Math.round(min / 1440)} days ago`
}

/** API data older than this is shown as old in the toolbar (the collector refreshes hourly). */
export const API_OLD_MS = 3 * 60 * 60 * 1000
