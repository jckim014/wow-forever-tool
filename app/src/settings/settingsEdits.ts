// Pure helpers for the Settings view: edits.settings holds only what differs from the defaults, so setting a value
// back to its default (or resetting it) removes the key instead of storing a copy of the default.
import type { Edits, Settings } from '../model'

export type ScalarKey = Exclude<keyof Settings, 'chainsByProfession'>

export function setSetting<K extends ScalarKey>(edits: Edits, defaults: Settings, key: K, value: Settings[K]): Edits {
  const settings = { ...edits.settings }
  if (value === defaults[key]) delete settings[key]
  else settings[key] = value
  return { ...edits, settings }
}

export function setChains(edits: Edits, defaults: Settings, profession: string, on: boolean): Edits {
  const chains = { ...edits.settings.chainsByProfession }
  if (on === (defaults.chainsByProfession[profession] ?? true)) delete chains[profession]
  else chains[profession] = on
  const settings = { ...edits.settings }
  if (Object.keys(chains).length) settings.chainsByProfession = chains
  else delete settings.chainsByProfession
  return { ...edits, settings }
}

export function resetAllSettings(edits: Edits): Edits {
  return { ...edits, settings: {} }
}

/** Fraction -> percent for display, without float noise (0.07 -> 7, not 7.000000000000001). */
export const toPercent = (f: number) => Math.round(f * 1e8) / 1e6
