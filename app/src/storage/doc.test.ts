import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyEdits, normalizeEdits, type Edits } from '../model'
import { docText, isEmptyEdits, parseDoc } from './doc'

const sample: Edits = {
  ...emptyEdits(),
  typedPrices: { '2996': 60 },
  vendorBuyOverrides: { '4382': null, '8925': 500 },
  settings: { useImports: false, importColumn: 2, ahCut: 0.05, chainsByProfession: { Mining: false } },
  allowCrafting: { '12360': false, '4407': true },
  useChainsNo: [1250791],
  imports: [{ item: 36, name: null, p1: 100, p2: null, p3: null }],
  importsInfo: { source: 'Auctionator (Forever - Alliance)', at: '2026-10-22T12:00:00.000Z', count: 1 },
}

describe('edits document', () => {
  it('round-trips the app edits and keeps savedAt', () => {
    const doc = parseDoc(docText(sample, '2026-10-22T12:00:00.000Z'))
    expect(doc.edits).toEqual(sample)
    expect(doc.savedAt).toBe('2026-10-22T12:00:00.000Z')
    expect(doc.warnings).toEqual([])
  })
  it('rejects files that are not edits files', () => {
    expect(() => parseDoc('{oops')).toThrow('Not valid JSON')
    expect(() => parseDoc('{"format":"other"}')).toThrow('Not an edits file')
    expect(() => parseDoc('{"format":"shuffle-edits","version":2}')).toThrow('Unsupported edits version')
  })
  it('knows an empty document', () => {
    expect(isEmptyEdits(parseDoc(docText(emptyEdits())).edits)).toBe(true)
    expect(isEmptyEdits(sample)).toBe(false)
  })
  const wb = resolve(__dirname, '../../../data/private/edits-v2.5.json')
  it.runIf(existsSync(wb))('round-trips the workbook export unchanged (edits-v2.5.json)', () => {
    const { edits } = normalizeEdits(JSON.parse(readFileSync(wb, 'utf8')))
    expect(parseDoc(docText(edits)).edits).toEqual(edits)
  })
})
