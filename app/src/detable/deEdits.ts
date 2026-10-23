// Pure helpers for the DE table editor. edits.deTable holds the whole table when it differs from the default, and
// null otherwise, so a table edited back to the default (or imported unchanged) counts as no edit.
import type { DeBand, DeResult, Edits } from '../model'

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const norm = (r: DeResult): DeResult => ({ item: r.item, name: r.name, chance: r.chance, min: r.min, max: r.max })

export const bandChanged = (band: DeBand, dflt: DeBand | undefined) => !dflt || !same(band.results.map(norm), dflt.results.map(norm)) || band.note !== dflt.note

/** Replaces one band's results (and note); bands are matched by position, the structure never changes. */
export function setBand(edits: Edits, defaults: DeBand[], index: number, change: Partial<Pick<DeBand, 'results' | 'note'>>): Edits {
  const table = (edits.deTable ?? defaults).map((b, i) => (i === index ? { ...b, ...change } : b))
  const changed = table.some((b, i) => bandChanged(b, defaults[i]))
  return { ...edits, deTable: changed ? table : null }
}

export const resetBand = (edits: Edits, defaults: DeBand[], index: number) =>
  setBand(edits, defaults, index, { results: defaults[index].results, note: defaults[index].note })

export const resetTable = (edits: Edits): Edits => ({ ...edits, deTable: null })

export const chanceSum = (band: DeBand) => band.results.reduce((s, r) => s + (r.chance || 0), 0)
