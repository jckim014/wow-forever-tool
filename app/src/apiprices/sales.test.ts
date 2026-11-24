import { describe, expect, it } from 'vitest'
import { salesFromText } from './read'

describe('salesFromText', () => {
  it("reads the collector's sales.json", () => {
    const s = salesFromText(JSON.stringify({ format: 'forever-sales', version: 1, at: '2026-11-15T23:00:00.000Z', days: 7,
      houses: { 111: { hours: 150, items: { 14048: 21.5, 2589: 900 } }, 114: { hours: 0, items: {} } } }))
    expect(s.at).toBe('2026-11-15T23:00:00.000Z')
    expect(s.houses[111].hours).toBe(150)
    expect(s.houses[111].items.get(14048)).toBe(21.5)
    expect(s.houses[114].items.size).toBe(0)
    expect(s.tsm).toBeNull() // written before the TSM part existed, or without the TSM file
  })
  it("reads TSM's region sold/day when the sync added it", () => {
    const s = salesFromText(JSON.stringify({ format: 'forever-sales', version: 1, at: '2026-11-15T23:00:00.000Z', days: 7, houses: {},
      tsm: { region: 'Forever-US', downloadTime: 1795467555, items: { 252483: 0.408, 2589: 15802.273 } } }))
    expect(s.tsm?.downloadTime).toBe(1795467555)
    expect(s.tsm?.items.get(252483)).toBe(0.408)
  })
  it('rejects other files', () => {
    expect(() => salesFromText('{"format":"forever-auction-summary","version":1}')).toThrow(/sales\.json/)
  })
})
