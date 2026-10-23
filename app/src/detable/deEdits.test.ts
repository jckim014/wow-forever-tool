import { describe, expect, it } from 'vitest'
import { config } from '../data'
import { emptyEdits } from '../model'
import { bandChanged, chanceSum, resetBand, resetTable, setBand } from './deEdits'

const d = config.deTable

describe('DE table edits', () => {
  it('stores the table only while it differs from the default', () => {
    const results = d[0].results.map((r, i) => (i === 0 ? { ...r, chance: 0.75 } : r))
    let e = setBand(emptyEdits(), d, 0, { results })
    expect(e.deTable).toHaveLength(d.length)
    expect(e.deTable![0].results[0].chance).toBe(0.75)
    expect(bandChanged(e.deTable![0], d[0])).toBe(true)
    expect(bandChanged(e.deTable![1], d[1])).toBe(false)
    e = resetBand(e, d, 0)
    expect(e.deTable).toBeNull()
  })

  it('a copy equal to the default counts as no edit', () => {
    // the workbook export carries a full copy of the default table
    const copy = { ...emptyEdits(), deTable: JSON.parse(JSON.stringify(d)) }
    expect(copy.deTable.some((b: typeof d[0], i: number) => bandChanged(b, d[i]))).toBe(false)
    expect(setBand(copy, d, 2, { note: d[2].note }).deTable).toBeNull()
    const changed = setBand(emptyEdits(), d, 3, { note: 'checked in game' })
    expect(changed.deTable).not.toBeNull()
    expect(resetTable(changed).deTable).toBeNull()
  })

  it('sums chances', () => {
    expect(chanceSum(d[0])).toBeCloseTo(1)
  })
})
