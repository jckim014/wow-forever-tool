import { describe, expect, it } from 'vitest'
import { ageText, datedFolders, pricesFromSummary, snapshotFiles, snapshotIso } from './read'

const summary = (houses: object) => JSON.stringify({
  format: 'forever-auction-summary', version: 1, snapshot: '20261113T012242Z', collectedAt: 'x',
  columns: ['lowest', 'median', 'cheapest15', 'units', 'listings'], houses,
})

describe('API price files', () => {
  it('snapshot ids and folder order', () => {
    expect(snapshotIso('20261113T012242Z')).toBe('2026-11-13T01:22:42.000Z')
    expect(snapshotIso('nope')).toBeNull()
    expect(snapshotFiles(['20261113T002240Z.json.gz', 'x.tmp', '20261113T012242Z.json.gz', '20261113T012242Z.json.gz.tmp']))
      .toEqual(['20261113T012242Z.json.gz', '20261113T002240Z.json.gz'])
    expect(datedFolders(['2026', '2027', 'raw', '11x'], 4)).toEqual(['2027', '2026'])
    expect(datedFolders(['09', '11', '10'], 2)).toEqual(['11', '10', '09'])
  })

  it('reads one house as p1/p2/p3 = lowest / median / cheapest 15%', () => {
    const text = summary({ 111: { lastModified: {}, listings: 3, bidOnly: 0, items: { 2589: [28, 30, 29, 13483, 384], 4306: [200, 222, 201, 3354, 143] } } })
    expect(pricesFromSummary(text, 111)).toEqual({
      house: 111, snapshot: '20261113T012242Z', at: '2026-11-13T01:22:42.000Z',
      rows: [{ item: 2589, name: null, p1: 28, p2: 30, p3: 29 }, { item: 4306, name: null, p1: 200, p2: 222, p3: 201 }],
    })
    expect(pricesFromSummary(text, 114)).toBeNull()
  })

  it('rejects other files', () => {
    expect(() => pricesFromSummary('{"format":"auctioneer-scan-summary","version":1}', 111)).toThrow(/not an auction collector summary/)
  })

  it('age text', () => {
    const now = Date.parse('2026-11-13T02:10:00Z')
    expect(ageText('2026-11-13T01:22:42Z', now)).toBe('47 min ago')
    expect(ageText('2026-11-12T23:40:00Z', now)).toBe('2.5 h ago')
    expect(ageText('2026-11-10T02:10:00Z', now)).toBe('3 days ago')
  })
})
