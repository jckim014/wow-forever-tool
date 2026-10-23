import { describe, expect, it } from 'vitest'
import { config } from '../data'
import { effectiveSettings, emptyEdits } from '../model'
import { resetAllSettings, setChains, setSetting, toPercent } from './settingsEdits'

const d = config.settings

describe('settings edits', () => {
  it('stores only values that differ from the defaults', () => {
    let e = setSetting(emptyEdits(), d, 'ahCut', 0.1)
    expect(e.settings).toEqual({ ahCut: 0.1 })
    expect(effectiveSettings(config, e).ahCut).toBe(0.1)
    e = setSetting(e, d, 'ahCut', d.ahCut)
    expect(e.settings).toEqual({})
  })

  it('keeps per-profession chain toggles sparse', () => {
    let e = setChains(emptyEdits(), d, 'Alchemy', false)
    expect(e.settings).toEqual({ chainsByProfession: { Alchemy: false } })
    expect(effectiveSettings(config, e).chainsByProfession.Tailoring).toBe(true)
    expect(effectiveSettings(config, e).chainsByProfession.Alchemy).toBe(false)
    e = setChains(e, d, 'Alchemy', true)
    expect(e.settings).toEqual({})
  })

  it('reset all leaves the other edits alone', () => {
    const e = { ...setSetting(emptyEdits(), d, 'salvagerOn', true), typedPrices: { '2589': 100 } }
    expect(resetAllSettings(e)).toEqual({ ...emptyEdits(), typedPrices: { '2589': 100 } })
  })

  it('shows percents without float noise', () => {
    expect(toPercent(0.07)).toBe(7)
    expect(toPercent(0.125)).toBe(12.5)
  })
})
