// The API auction data as a baseline price source: per item, the newer of the price import and the API data wins.
import { describe, expect, it } from 'vitest'
import { emptyEdits } from './edits'
import { importedPrices, makePriceLookup } from './prices'
import type { ApiPrices, Edits, GameData, ImportRow, Settings } from './types'

const settings: Settings = {
  useVendorBuy: true, useImports: true, importColumn: 3, useApiPrices: true, apiHouse: 111,
  salvagerOn: false, salvagerProcChance: 0, salvagerExtraPerProc: 0, salvagerFlatBonus: 0, ahCut: 0.05, chainsByProfession: {},
}
const row = (item: number, p3: number | null): ImportRow => ({ item, name: null, p1: 1, p2: 2, p3 })
const edits = (rows: ImportRow[], at: string, dataAt?: string): Edits => ({
  ...emptyEdits(), imports: rows, importsInfo: { source: 'BavvbScan (x)', at, count: rows.length, ...(dataAt ? { dataAt } : {}) },
})
const api = (rows: ImportRow[], at: string): ApiPrices => ({ house: 111, snapshot: 'x', at, rows })

describe('imported price: import vs API data', () => {
  const scan = [row(1, 100), row(2, 200)]
  const apiRows = [row(1, 150), row(3, 300), row(4, 0)]

  it('API newer: API wins where it has the item; the import fills the rest', () => {
    const m = importedPrices(edits(scan, '2026-11-13T01:00:00Z'), settings, api(apiRows, '2026-11-13T02:22:00Z'))
    expect(Object.fromEntries(m)).toEqual({
      1: { value: 150, source: 'API' }, 2: { value: 200, source: 'Imported' }, 3: { value: 300, source: 'API' },
    })
  })

  it('import newer: the import wins where it has the item; API fills the rest (0 = no price)', () => {
    const m = importedPrices(edits(scan, '2026-11-13T03:00:00Z'), settings, api(apiRows, '2026-11-13T02:22:00Z'))
    expect(Object.fromEntries(m)).toEqual({
      1: { value: 100, source: 'Imported' }, 2: { value: 200, source: 'Imported' }, 3: { value: 300, source: 'API' },
    })
  })

  it("uses the scan's own time when known, not the import time", () => {
    // imported at 03:00, but the scan itself was made at 02:00, before the API data
    const m = importedPrices(edits(scan, '2026-11-13T03:00:00Z', '2026-11-13T02:00:00Z'), settings, api(apiRows, '2026-11-13T02:22:00Z'))
    expect(m.get(1)).toEqual({ value: 150, source: 'API' })
  })

  it('a tie goes to the import; no import at all means API', () => {
    expect(importedPrices(edits(scan, '2026-11-13T02:22:00Z'), settings, api(apiRows, '2026-11-13T02:22:00Z')).get(1)?.source).toBe('Imported')
    expect(importedPrices(emptyEdits(), settings, api(apiRows, '2026-11-13T02:22:00Z')).get(1)).toEqual({ value: 150, source: 'API' })
  })

  it('each source can be switched off; no API data = the import alone (as before)', () => {
    const e = edits(scan, '2026-11-13T01:00:00Z')
    const a = api(apiRows, '2026-11-13T02:22:00Z')
    expect([...importedPrices(e, { ...settings, useApiPrices: false }, a).values()].every((p) => p.source === 'Imported')).toBe(true)
    expect([...importedPrices(e, { ...settings, useImports: false }, a).keys()]).toEqual([1, 3])
    expect(Object.fromEntries(importedPrices(e, settings, null))).toEqual({ 1: { value: 100, source: 'Imported' }, 2: { value: 200, source: 'Imported' } })
  })

  it('the price lookup labels API prices as their own source', () => {
    const game = { items: { 3: { id: 3, name: 'x', sell: null, buy: null } }, recipes: [], professions: [] } as unknown as GameData
    const p = makePriceLookup(game, edits(scan, '2026-11-13T01:00:00Z'), settings, api(apiRows, '2026-11-13T02:22:00Z'))(3)
    expect(p).toMatchObject({ imported: 300, importedSource: 'API', reagent: 300, reagentSource: 'API', selling: 300 })
  })
})
