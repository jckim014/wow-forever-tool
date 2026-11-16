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
  })
  it('rejects other files', () => {
    expect(() => salesFromText('{"format":"forever-auction-summary","version":1}')).toThrow(/sales\.json/)
  })
})
