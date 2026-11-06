// Auctioneer scan (Auc-ScanData.lua) -> imported prices.
//
// Auctioneer keeps every listing of the last scan per realm/faction ("server key"). Per item ID, using the listings
// with a buyout, and the price per unit (stack buyout / stack size):
//   p1 = lowest buyout per unit
//   p2 = median per unit, weighted by units (the price at which half of all listed units are as cheap or cheaper)
//   p3 = average price of the cheapest 15% of listed units (at least one unit)
//
// File layout (Auc-ScanData, image "rope"): AucScanData = { Version, scans = { [serverKey] = { scanstats, image =
// "rope", ropes = { "return {{...},{...},...}", ... } } } }. Each rope is Lua source for a list of listings; the
// listing fields are in Auc-Advanced/CoreConst.lua (1-based): COUNT = 11, BUYOUT = 17 (whole stack), ITEMID = 23.
import { unzipSync } from 'fflate'
import type { ImportRow } from '../model'
import { roundHalfEven } from '../model/recipes'
import { luaString } from './auctionator'

/** Share of listed units averaged for p3. */
export const CHEAPEST_SHARE = 0.15

const COUNT = 10, BUYOUT = 16, ITEMID = 22 // 0-based

const utf8 = new TextDecoder('utf-8')
const enc = new TextEncoder()

function indexOf(b: Uint8Array, pat: string, from = 0): number {
  const p = enc.encode(pat)
  outer: for (let i = from; i <= b.length - p.length; i++) {
    for (let j = 0; j < p.length; j++) if (b[i + j] !== p[j]) continue outer
    return i
  }
  return -1
}

export const isAuctioneerScan = (raw: Uint8Array) => indexOf(raw.subarray(0, 4096), 'AucScanData') >= 0

/** Finds Auc-ScanData.lua in a .zip (or takes a bare .lua). */
export function auctioneerBytes(fileName: string, data: Uint8Array): Uint8Array {
  if (data[0] !== 0x50 || data[1] !== 0x4b) return data
  const files = unzipSync(data, { filter: (f) => f.name.toLowerCase().endsWith('auc-scandata.lua') })
  const name = Object.keys(files)[0]
  if (!name) throw new Error(`No Auc-ScanData.lua inside ${fileName}.`)
  return files[name]
}

// ---------- a small reader for Lua table literals (as WoW writes SavedVariables) ----------
type Lua = string | number | boolean | null | LuaTable
interface LuaTable { list: Lua[]; map: Map<string | number, Lua> }

class Reader {
  i = 0
  constructor(readonly b: Uint8Array, readonly asText: boolean) {}

  private skip() {
    const b = this.b
    for (;;) {
      const c = b[this.i]
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 59) { this.i++; continue } // space , ;
      if (c === 45 && b[this.i + 1] === 45) { // -- comment
        if (b[this.i + 2] === 91 && b[this.i + 3] === 91) {
          let j = this.i + 4
          while (j < b.length && !(b[j] === 93 && b[j + 1] === 93)) j++
          this.i = j + 2
        } else {
          while (this.i < b.length && b[this.i] !== 10) this.i++
        }
        continue
      }
      return
    }
  }

  private word(): string {
    const b = this.b
    const s = this.i
    while (this.i < b.length) {
      const c = b[this.i]
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 59 || c === 125 || c === 93 || c === 61) break
      this.i++
    }
    return String.fromCharCode(...b.subarray(s, this.i))
  }

  value(): Lua {
    this.skip()
    const c = this.b[this.i]
    if (c === 123) return this.table()
    if (c === 34 || c === 39) {
      const [s, j] = luaString(this.b, this.i)
      this.i = j
      return this.asText ? utf8.decode(s) : (s as unknown as string) // raw bytes for the ropes (decoded by the caller)
    }
    const w = this.word()
    if (w === 'nil') return null
    if (w === 'true') return true
    if (w === 'false') return false
    const n = Number(w)
    if (w === '' || Number.isNaN(n)) throw new Error(`Unexpected "${w || String.fromCharCode(c)}" at byte ${this.i}.`)
    return n
  }

  table(): LuaTable {
    const b = this.b
    this.i++ // {
    const t: LuaTable = { list: [], map: new Map() }
    for (;;) {
      this.skip()
      if (this.i >= b.length) throw new Error('The file ends inside a table (truncated?).')
      const c = b[this.i]
      if (c === 125) { this.i++; return t } // }
      if (c === 91 && b[this.i + 1] !== 91) { // [key] =
        this.i++
        const k = this.value()
        this.skip()
        if (b[this.i] !== 93) throw new Error(`Expected ] at byte ${this.i}.`)
        this.i++
        this.skip()
        if (b[this.i] !== 61) throw new Error(`Expected = at byte ${this.i}.`)
        this.i++
        const key = typeof k === 'number' ? k : this.asText ? (k as string) : utf8.decode(k as unknown as Uint8Array)
        t.map.set(key, this.value())
        continue
      }
      // name = value, or a positional value
      const save = this.i
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
        const w = this.word()
        this.skip()
        if (b[this.i] === 61 && b[this.i + 1] !== 61) {
          this.i++
          t.map.set(w, this.value())
          continue
        }
        this.i = save
      }
      t.list.push(this.value())
    }
  }
}

const field = (t: Lua | undefined, key: string | number): Lua | undefined =>
  t && typeof t === 'object' ? t.map.get(key) : undefined

/** Server keys (realm_faction) in the scan file, each with its ropes (still Lua source, as bytes). */
export function scanServers(raw: Uint8Array): Map<string, Uint8Array[]> {
  const start = indexOf(raw, 'AucScanData')
  if (start < 0) throw new Error('No AucScanData in this file. Is it Auc-ScanData.lua from SavedVariables?')
  const eq = raw.indexOf(123, start) // {
  const r = new Reader(raw, false)
  r.i = eq
  const top = r.table()
  const scans = field(top, 'scans')
  if (!scans || typeof scans !== 'object') throw new Error('The scan file has no scans: run a full scan, then /reload.')
  const out = new Map<string, Uint8Array[]>()
  for (const [key, scan] of scans.map) {
    const image = field(scan, 'image')
    const ropes = field(scan, 'ropes')
    if (!ropes || typeof ropes !== 'object' || !ropes.list.length) continue
    const kind = image instanceof Uint8Array ? utf8.decode(image) : image
    if (kind !== 'rope') throw new Error(`Scan ${key} is stored as "${kind}", which this reader does not handle (expected "rope").`)
    out.set(String(key), ropes.list as unknown as Uint8Array[])
  }
  if (!out.size) throw new Error('The scan file has no listings: run a full scan, wait until it has finished processing, then /reload.')
  return out
}

export interface AuctioneerResult {
  rows: ImportRow[]
  listings: number
  /** Listings with no buyout (bid only), not used. */
  noBuyout: number
}

/** Per-unit prices of one server key's listings. */
export function pricesFromScan(ropes: Uint8Array[]): AuctioneerResult {
  const byItem = new Map<number, [number, number][]>() // [unit price, units]
  let listings = 0, noBuyout = 0
  for (const rope of ropes) {
    const r = new Reader(rope, false)
    const ret = indexOf(rope.subarray(0, 32), 'return')
    if (ret < 0) throw new Error('A scan block does not start with "return".')
    r.i = rope.indexOf(123, ret)
    for (const l of r.table().list) {
      if (!l || typeof l !== 'object') continue
      listings++
      const a = l.list
      const count = a[COUNT], buyout = a[BUYOUT], item = a[ITEMID]
      if (typeof item !== 'number' || typeof count !== 'number' || count <= 0) continue
      if (typeof buyout !== 'number' || buyout <= 0) { noBuyout++; continue }
      let xs = byItem.get(item)
      if (!xs) byItem.set(item, (xs = []))
      xs.push([buyout / count, count])
    }
  }
  const rows: ImportRow[] = []
  for (const [item, xs] of byItem) {
    xs.sort((p, q) => p[0] - q[0])
    const units = xs.reduce((s, x) => s + x[1], 0)
    let acc = 0, med = xs[xs.length - 1][0]
    for (const [p, n] of xs) {
      acc += n
      if (acc >= units / 2) { med = p; break }
    }
    const need = Math.max(1, CHEAPEST_SHARE * units)
    let took = 0, sum = 0
    for (const [p, n] of xs) {
      const take = Math.min(n, need - took)
      sum += p * take
      took += take
      if (took >= need) break
    }
    rows.push({ item, name: null, p1: roundHalfEven(xs[0][0]), p2: roundHalfEven(med), p3: roundHalfEven(sum / took) })
  }
  rows.sort((a, b) => a.item - b.item)
  return { rows, listings, noBuyout }
}
