// Auctionator SavedVariables -> imported prices. Port of tools/auctionator_to_imports.py (the reference).
//
//   p1 = latest lowest buyout Auctionator saw (its current "min" price)
//   p2 = median of the daily lowest buyouts over the last 7 scan days
//   p3 = lowest daily lowest buyout over the same days
//
// Auctionator price database v8: per realm, a CBOR-encoded map of item key -> {m: current min, h: {day: price},
// l: {day: price}, a: {day: quantity}}. For each day, h is the highest and l the lowest of that day's minimum-buyout
// readings (l only when it differs from h). Keys that are not plain item IDs (gear variants, pets) are skipped.
import { unzipSync } from 'fflate'
import type { ImportRow } from '../model'
import { roundHalfEven } from '../model/recipes'

export const HISTORY_DAYS = 7

const enc = new TextEncoder()
const utf8 = new TextDecoder('utf-8')

function indexOf(b: Uint8Array, pat: string | number[], from = 0): number {
  const p = typeof pat === 'string' ? enc.encode(pat) : pat
  outer: for (let i = from; i <= b.length - p.length; i++) {
    for (let j = 0; j < p.length; j++) if (b[i + j] !== p[j]) continue outer
    return i
  }
  return -1
}

/** Finds Auctionator.lua in a .zip (or takes a bare .lua) and returns its bytes. */
export function auctionatorBytes(fileName: string, data: Uint8Array): Uint8Array {
  if (data[0] === 0x50 && data[1] === 0x4b) { // "PK": a zip
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(data, { filter: (f) => f.name.toLowerCase().endsWith('auctionator.lua') })
    } catch (e) {
      throw new Error(`${fileName} could not be unzipped (${(e as Error).message}).`)
    }
    const name = Object.keys(files)[0]
    if (!name) throw new Error(`No Auctionator.lua inside ${fileName}.`)
    return files[name]
  }
  return data
}

// ---------- realm strings in AUCTIONATOR_PRICE_DATABASE ----------
const ESC: Record<number, number> = {
  0x61: 7, 0x62: 8, 0x66: 12, 0x6e: 10, 0x72: 13, 0x74: 9, 0x76: 11, 0x5c: 92, 0x22: 34, 0x27: 39, 10: 10, 13: 10,
}
const isDigit = (c: number) => c >= 48 && c <= 57
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12

/** b[i] is the opening quote. Returns the unescaped bytes and the index after the closing quote. */
export function luaString(b: Uint8Array, i: number): [Uint8Array, number] {
  const q = b[i++]
  const out: number[] = []
  for (;;) {
    if (i >= b.length) throw new Error('Unterminated string in the price database.')
    const c = b[i]
    if (c === q) return [Uint8Array.from(out), i + 1]
    if (c !== 92) {
      out.push(c)
      i++
      continue
    }
    const n = b[i + 1]
    if (isDigit(n)) {
      let j = i + 1, v = 0
      while (j < i + 4 && isDigit(b[j])) v = v * 10 + b[j++] - 48
      out.push(v)
      i = j
    } else if (n in ESC) {
      out.push(ESC[n])
      i += 2
      if (n === 13 && b[i] === 10) i++
    } else {
      throw new Error(`Unknown escape \\${String.fromCharCode(n)} at byte ${i}.`)
    }
  }
}

/** The realm/faction strings of AUCTIONATOR_PRICE_DATABASE (other entries such as the version number are skipped). */
export function priceDatabaseRealms(raw: Uint8Array): Map<string, Uint8Array> {
  const start = indexOf(raw, 'AUCTIONATOR_PRICE_DATABASE = {')
  if (start < 0) {
    if (indexOf(raw, 'AUCTIONATOR_CHARACTER_CONFIG') >= 0) {
      throw new Error(String.raw`This is a per-character Auctionator.lua (only that character's settings, no prices). Use the account-wide one: WTF\Account\<ACCOUNT NAME>\SavedVariables\Auctionator.lua.`)
    }
    throw new Error('No AUCTIONATOR_PRICE_DATABASE in this file. Is it Auctionator.lua from SavedVariables?')
  }
  if (indexOf(raw, [0xef, 0xbf, 0xbd], start) >= 0) {
    throw new Error('The price database contains replacement characters, so the file was converted as text somewhere. Zip the original Auctionator.lua and use the .zip.')
  }
  const realms = new Map<string, Uint8Array>()
  let i = indexOf(raw, '\n', start)
  const skipSpace = () => { while (i < raw.length && isSpace(raw[i])) i++ }
  while (i >= 0 && i < raw.length) {
    skipSpace()
    if (raw[i] !== 0x5b || raw[i + 1] !== 0x22) break // ["
    let j = i + 2
    while (j < raw.length && raw[j] !== 0x22) j += raw[j] === 92 ? 2 : 1
    const key = utf8.decode(raw.subarray(i + 2, j))
    if (raw[j + 1] !== 0x5d) break // ]
    i = j + 2
    skipSpace()
    if (raw[i] !== 0x3d) break // =
    i++
    skipSpace()
    if (raw[i] === 0x22) {
      const [val, k] = luaString(raw, i)
      realms.set(key, val)
      i = k
    } else {
      while (i < raw.length && raw[i] !== 0x2c && raw[i] !== 10 && raw[i] !== 13) i++
    }
    skipSpace()
    if (raw[i] !== 0x2c) break // ,
    i++
  }
  if (!realms.size) throw new Error('The price database is empty: run a full scan, then /reload before copying the file.')
  return realms
}

// ---------- minimal CBOR decoder ----------
type Cbor = number | string | boolean | null | Cbor[] | { [k: string]: Cbor }

export function decodeCbor(b: Uint8Array): { value: Cbor; end: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const read = (i: number): [Cbor, number] => {
    if (i >= b.length) throw new Error('Price data ends early (truncated CBOR).')
    const ib = b[i++], mt = ib >> 5, ai = ib & 31
    let n: number
    if (ai < 24) n = ai
    else if (ai === 24) n = b[i++]
    else if (ai === 25) { n = dv.getUint16(i); i += 2 }
    else if (ai === 26) { n = dv.getUint32(i); i += 4 }
    else if (ai === 27) { n = Number(dv.getBigUint64(i)); i += 8 }
    else throw new Error(`Unsupported CBOR length at byte ${i}.`)
    switch (mt) {
      case 0: return [n, i]
      case 1: return [-1 - n, i]
      case 2:
      case 3: return [utf8.decode(b.subarray(i, i + n)), i + n]
      case 4: {
        const out: Cbor[] = []
        for (let k = 0; k < n; k++) { const [v, j] = read(i); out.push(v); i = j }
        return [out, i]
      }
      case 5: {
        const out: { [k: string]: Cbor } = {}
        for (let k = 0; k < n; k++) {
          const [key, j] = read(i)
          const [v, j2] = read(j)
          out[String(key)] = v
          i = j2
        }
        return [out, i]
      }
      case 7:
        if (ai === 20) return [false, i]
        if (ai === 21) return [true, i]
        if (ai === 22 || ai === 23) return [null, i]
        if (ai === 25) throw new Error('Half-precision floats are not supported.')
        if (ai === 26) return [dv.getFloat32(i - 4), i]
        if (ai === 27) return [dv.getFloat64(i - 8), i]
    }
    throw new Error(`Unsupported CBOR type ${mt} at byte ${i}.`)
  }
  const [value, end] = read(0)
  return { value, end }
}

// ---------- prices ----------
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface AuctionatorResult {
  rows: ImportRow[]
  skipped: number
  scanDays: number
  trailingBytes: number
}

export function pricesFromRealm(realmData: Uint8Array, days = HISTORY_DAYS): AuctionatorResult {
  const { value: db, end } = decodeCbor(realmData)
  if (!db || typeof db !== 'object' || Array.isArray(db)) throw new Error('The price database is not a map of items.')
  const rows: ImportRow[] = []
  const daysSeen = new Set<number>()
  let skipped = 0
  for (const [key, rec] of Object.entries(db)) {
    if (!/^\d+$/.test(key) || !rec || typeof rec !== 'object' || Array.isArray(rec)) {
      skipped++
      continue
    }
    const r = rec as { [k: string]: Cbor }
    const asDays = (o: Cbor | undefined) =>
      new Map(Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).map(([d, p]) => [Number(d), p as number]))
    const h = asDays(r.h), l = asDays(r.l)
    const daily = new Map([...h].map(([d, p]) => [d, Math.min(p, l.get(d) ?? p)]))
    for (const d of daily.keys()) daysSeen.add(d)
    const recent = [...daily.keys()].sort((a, b) => a - b).slice(-days).map((d) => daily.get(d)!)
    const m = typeof r.m === 'number' ? r.m : null
    if (m === null && !recent.length) continue
    rows.push({
      item: Number(key),
      name: null,
      p1: m ?? recent[recent.length - 1],
      p2: recent.length ? roundHalfEven(median(recent)) : m,
      p3: recent.length ? Math.min(...recent) : m,
    })
  }
  rows.sort((a, b) => a.item - b.item)
  return { rows, skipped, scanDays: daysSeen.size, trailingBytes: realmData.length - end }
}
