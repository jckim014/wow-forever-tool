import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { auctionatorBytes, decodeCbor, luaString, priceDatabaseRealms, pricesFromRealm } from './auctionator'
import { parsePriceTable } from './csv'

// ---------- fixture: a synthetic Auctionator.lua ----------
type V = number | string | boolean | null | V[] | Map<number | string, V>

function encodeCbor(v: V): number[] {
  const head = (mt: number, n: number): number[] => {
    if (n < 24) return [(mt << 5) | n]
    if (n < 0x100) return [(mt << 5) | 24, n]
    if (n < 0x10000) return [(mt << 5) | 25, n >> 8, n & 255]
    if (n < 0x100000000) return [(mt << 5) | 26, ...[24, 16, 8, 0].map((s) => (n >>> s) & 255)]
    const b = new DataView(new ArrayBuffer(8))
    b.setBigUint64(0, BigInt(n))
    return [(mt << 5) | 27, ...new Uint8Array(b.buffer)]
  }
  if (v === null) return [0xf6]
  if (typeof v === 'boolean') return [v ? 0xf5 : 0xf4]
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v)
    const b = new DataView(new ArrayBuffer(8))
    b.setFloat64(0, v)
    return [0xfb, ...new Uint8Array(b.buffer)]
  }
  if (typeof v === 'string') {
    const s = new TextEncoder().encode(v)
    return [...head(3, s.length), ...s]
  }
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(encodeCbor)]
  return [...head(5, v.size), ...[...v].flatMap(([k, x]) => [...encodeCbor(k), ...encodeCbor(x)])]
}

/** Lua string escaping as SavedVariables writes it, plus some optional escapes to exercise the reader. */
function luaQuote(bytes: number[]): number[] {
  const out: number[] = [34]
  const esc = (s: string) => out.push(...new TextEncoder().encode(s))
  bytes.forEach((c, i) => {
    const nextIsDigit = bytes[i + 1] >= 48 && bytes[i + 1] <= 57
    if (c === 34) esc('\\"')
    else if (c === 92) esc('\\\\')
    else if (c === 10) esc('\\n')
    else if (c === 13) esc('\\r')
    else if (c < 32 || c === 127) esc(nextIsDigit ? `\\${String(c).padStart(3, '0')}` : `\\${c}`)
    else if (c >= 200 && i % 2) esc(`\\${c}`) // some high bytes escaped, the rest raw
    else out.push(c)
  })
  out.push(34)
  return out
}

const days = (o: Record<number, number>) => new Map(Object.entries(o).map(([d, p]) => [Number(d), p] as [number, V]))
const rec = (o: { m?: number; h?: Record<number, number>; l?: Record<number, number> }) =>
  new Map<string, V>([...(o.m !== undefined ? [['m', o.m] as [string, V]] : []), ...(o.h ? [['h', days(o.h)] as [string, V]] : []), ...(o.l ? [['l', days(o.l)] as [string, V]] : [])])

const realmDb = new Map<string, V>([
  // 9 days of history: only the last 7 count; l lowers some days
  ['2589', rec({ m: 120, h: { 1: 900, 2: 800, 3: 100, 4: 110, 5: 140, 6: 130, 7: 150, 8: 160, 9: 125 }, l: { 4: 90, 8: 155 } })],
  // even number of days: median 11.5 -> 12 and 12.5 -> 12 (half to even)
  ['4306', rec({ m: 11, h: { 100: 10, 101: 13 } })],
  ['4338', rec({ m: 10, h: { 100: 10, 101: 15 } })],
  ['2996', rec({ h: { 50: 70, 51: 65 } })], // no current min: p1 = latest daily low
  ['14047', rec({ m: 300 })], // no history
  ['7078', rec({})], // nothing: dropped
  ['g:12345:1:2', rec({ m: 5 })], // gear variant: skipped
  ['p:39:25:3', rec({ m: 5 })], // pet: skipped
  ['20725', rec({ m: 5_000_000_000, h: { 9: 70_000, 10: 4_294_967_296 } })], // 64-bit and 32-bit sized prices
  ['10', rec({ m: 7, h: { 1: 7 } })],
  ['11', rec({ m: 7, h: { 1: 7 } })],
])
const realm2 = new Map<string, V>([['2589', rec({ m: 1 })]])

function makeLua(dbs: [string, Map<string, V>][]): Uint8Array {
  const parts: number[] = []
  const add = (s: string) => parts.push(...new TextEncoder().encode(s))
  add('\nAUCTIONATOR_CONFIG = {\n["x"] = 1,\n}\nAUCTIONATOR_PRICE_DATABASE = {\n["__dbversion"] = 8,\n')
  for (const [name, db] of dbs) {
    add(`["${name}"] = `)
    parts.push(...luaQuote(encodeCbor(db)))
    add(',\n')
  }
  add('}\n')
  return Uint8Array.from(parts)
}

const lua = makeLua([['Forever – Alliance', realmDb]])
const zip = zipSync({ 'SavedVariables/Auctionator.lua': lua, 'readme.txt': new TextEncoder().encode('x') })

describe('Auctionator reader', () => {
  it('unescapes Lua strings, including \\ddd next to digits', () => {
    const b = new TextEncoder().encode('"a\\0011\\1x\\\\\\"\\n\\\n"')
    const [s, end] = luaString(b, 0)
    expect([...s]).toEqual([97, 1, 49, 1, 120, 92, 34, 10, 10])
    expect(end).toBe(b.length)
  })

  it('decodes CBOR', () => {
    const v = new Map<string | number, V>([['a', [1, -2, 300, 70000, 5_000_000_000, 1.5, 'é', true, null]], [7, 'x']])
    expect(decodeCbor(Uint8Array.from(encodeCbor(v))).value).toEqual({ a: [1, -2, 300, 70000, 5_000_000_000, 1.5, 'é', true, null], 7: 'x' })
  })

  it('reads a zip and computes p1/p2/p3 per item ID', () => {
    const realms = priceDatabaseRealms(auctionatorBytes('Auctionator.zip', zip))
    expect([...realms.keys()]).toEqual(['Forever – Alliance'])
    const r = pricesFromRealm(realms.get('Forever – Alliance')!)
    expect(r.skipped).toBe(2)
    expect(r.trailingBytes).toBe(0)
    const by = Object.fromEntries(r.rows.map((x) => [x.item, [x.p1, x.p2, x.p3]]))
    // 2589: last 7 days 3..9 -> lows 100, 90, 140, 130, 150, 155, 125 -> median 130, min 90
    expect(by[2589]).toEqual([120, 130, 90])
    expect(by[4306]).toEqual([11, 12, 10])
    expect(by[4338]).toEqual([10, 12, 10])
    expect(by[2996]).toEqual([65, 68, 65]) // median 67.5 -> 68
    expect(by[14047]).toEqual([300, 300, 300])
    expect(by[7078]).toBeUndefined()
    expect(by[20725]).toEqual([5_000_000_000, 2_147_518_648, 70_000])
    expect(r.rows.map((x) => x.item)).toEqual([10, 11, 2589, 2996, 4306, 4338, 14047, 20725])
  })

  it('also takes a bare Auctionator.lua and lists several realms', () => {
    const realms = priceDatabaseRealms(auctionatorBytes('Auctionator.lua', makeLua([['A', realmDb], ['B', realm2]])))
    expect([...realms.keys()]).toEqual(['A', 'B'])
    expect(pricesFromRealm(realms.get('B')!).rows).toEqual([{ item: 2589, name: null, p1: 1, p2: 1, p3: 1 }])
  })

  it('rejects files converted as text, and files without a price database', () => {
    const mangled = Uint8Array.from([...makeLua([['A', realm2]]).slice(0, -4), 0xef, 0xbf, 0xbd, ...new TextEncoder().encode('"\n}')])
    expect(() => priceDatabaseRealms(mangled)).toThrow('replacement characters')
    expect(() => priceDatabaseRealms(new TextEncoder().encode('FOO = {}'))).toThrow('No AUCTIONATOR_PRICE_DATABASE')
    expect(() => priceDatabaseRealms(new TextEncoder().encode('\nAUCTIONATOR_CHARACTER_CONFIG = nil\n'))).toThrow('per-character')
    expect(() => auctionatorBytes('x.zip', zipSync({ 'a.txt': Uint8Array.of(1) }))).toThrow('No Auctionator.lua')
  })

  // Same zip through the Python reference: identical rows.
  const ref = resolve(__dirname, '../../../tools/auctionator_to_imports.py')
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0)']).status === 0)
  it.runIf(py)('matches tools/auctionator_to_imports.py', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auctionator-'))
    writeFileSync(join(dir, 'Auctionator.zip'), zip)
    const run = spawnSync(py!, ['-I', ref, join(dir, 'Auctionator.zip'), '--out', join(dir, 'out.csv')], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const expected = parsePriceTable(readFileSync(join(dir, 'out.csv'), 'utf8')).rows
    const realms = priceDatabaseRealms(auctionatorBytes('Auctionator.zip', zip))
    expect(pricesFromRealm([...realms.values()][0]).rows).toEqual(expected)
  })
})

describe('pasted / CSV prices', () => {
  it('reads a spreadsheet paste (tabs) with a header and blanks', () => {
    const r = parsePriceTable('Item ID\tItem name\tPrice 1\tPrice 2\tPrice 3\n2589\tLinen Cloth\t120\t\t90\n\n4306\t\t1,500\t1400\t1300\n')
    expect(r.rows).toEqual([
      { item: 2589, name: 'Linen Cloth', p1: 120, p2: null, p3: 90 },
      { item: 4306, name: null, p1: 1500, p2: 1400, p3: 1300 },
    ])
    expect(r.warnings).toEqual([])
  })
  it('reads CSV with quotes and warns about bad lines', () => {
    const r = parsePriceTable('2589,"Linen, Cloth",120,110,100\nabc,x,1\n2589,,5\n14047,,lots')
    expect(r.rows.map((x) => [x.item, x.name, x.p1])).toEqual([[2589, 'Linen, Cloth', 120], [2589, null, 5], [14047, null, null]])
    expect(r.warnings).toHaveLength(3)
  })
})
