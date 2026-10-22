import { EDITS_FORMAT, EDITS_VERSION, normalizeEdits } from '../model/edits'
import type { Edits } from '../model'

/** The saved/exported document: shuffle-edits v1 with app setting keys, plus when it was saved. */
export function toDoc(edits: Edits, savedAt = new Date().toISOString()) {
  return {
    format: EDITS_FORMAT,
    version: EDITS_VERSION,
    savedAt,
    typedPrices: edits.typedPrices,
    vendorBuyOverrides: edits.vendorBuyOverrides,
    settings: edits.settings,
    allowCrafting: Object.fromEntries(Object.entries(edits.allowCrafting).map(([k, v]) => [k, v ? 'Yes' : 'No'])),
    useChainsNo: edits.useChainsNo,
    deTable: edits.deTable ?? [],
    imports: edits.imports,
  }
}

export const docText = (edits: Edits, savedAt?: string) => JSON.stringify(toDoc(edits, savedAt), null, 1)

export interface ParsedDoc {
  edits: Edits
  warnings: string[]
  /** null for files without one (e.g. edits-v2.5.json from the workbook export) */
  savedAt: string | null
}

/** Throws with a readable message if the text is not a shuffle-edits file. */
export function parseDoc(text: string): ParsedDoc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Not valid JSON.')
  }
  const { edits, warnings } = normalizeEdits(raw)
  const savedAt = typeof (raw as { savedAt?: unknown }).savedAt === 'string' ? (raw as { savedAt: string }).savedAt : null
  return { edits, warnings, savedAt }
}

export const isEmptyEdits = (e: Edits) =>
  !Object.keys(e.typedPrices).length && !Object.keys(e.vendorBuyOverrides).length && !Object.keys(e.settings).length &&
  !Object.keys(e.allowCrafting).length && !e.useChainsNo.length && !e.deTable && !e.imports.length
