import type { DeBand, Edits, ImportRow, ImportsInfo, Settings } from './types'

export const EDITS_FORMAT = 'shuffle-edits'
export const EDITS_VERSION = 1

export function emptyEdits(): Edits {
  return { typedPrices: {}, vendorBuyOverrides: {}, settings: {}, allowCrafting: {}, useChainsNo: [], deTable: null, imports: [], importsInfo: null }
}

// Workbook setting names (Settings tab, column A) -> app settings keys
const SETTING_LABELS: Record<string, keyof Settings> = {
  'Use vendor buy price for reagents left blank': 'useVendorBuy',
  'Use imported prices (Imports tab)': 'useImports',
  'Imported price column to use': 'importColumn',
  'Arcane Salvager in use': 'salvagerOn',
  'Salvager: proc chance per disenchant': 'salvagerProcChance',
  'Salvager: extra full disenchants per proc': 'salvagerExtraPerProc',
  'Salvager: flat yield bonus': 'salvagerFlatBonus',
  'AH cut on sales': 'ahCut',
  'AH cut on DE materials sold': 'ahCut', // pre-v2.5 name
}
const CHAINS_PREFIX = 'Chains: craft with '
const BOOL_KEYS = new Set<keyof Settings>(['useVendorBuy', 'useImports', 'salvagerOn'])

const yesNo = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === 'Yes' ? true : v === 'No' ? false : undefined
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function normSettings(raw: Record<string, unknown>, warnings: string[]): Partial<Settings> {
  const out: Partial<Settings> = {}
  const chains: Record<string, boolean> = {}
  const set = (key: keyof Settings, v: unknown, label: string) => {
    if (BOOL_KEYS.has(key)) {
      const b = yesNo(v)
      if (b === undefined) warnings.push(`Setting "${label}": expected Yes/No, got ${JSON.stringify(v)}; ignored`)
      else (out as Record<string, unknown>)[key] = b
    } else if (key === 'importColumn') {
      if (v === 1 || v === 2 || v === 3) out.importColumn = v
      else warnings.push(`Setting "${label}": expected 1, 2 or 3, got ${JSON.stringify(v)}; ignored`)
    } else {
      const n = num(v)
      if (n === null) warnings.push(`Setting "${label}": expected a number, got ${JSON.stringify(v)}; ignored`)
      else (out as Record<string, unknown>)[key] = n
    }
  }
  for (const [label, v] of Object.entries(raw)) {
    if (label === 'chainsByProfession' && v && typeof v === 'object') {
      for (const [p, b] of Object.entries(v)) {
        const yb = yesNo(b)
        if (yb !== undefined) chains[p] = yb
      }
    } else if (label.startsWith(CHAINS_PREFIX)) {
      const b = yesNo(v)
      if (b === undefined) warnings.push(`Setting "${label}": expected Yes/No; ignored`)
      else chains[label.slice(CHAINS_PREFIX.length)] = b
    } else if (label in SETTING_LABELS) {
      set(SETTING_LABELS[label], v, label)
    } else if ((Object.values(SETTING_LABELS) as string[]).includes(label)) {
      set(label as keyof Settings, v, label)
    } else if (label === 'Effective DE multiplier') {
      // a workbook formula; the app computes it from the Salvager settings
    } else {
      warnings.push(`Unknown setting "${label}"; ignored`)
    }
  }
  if (Object.keys(chains).length) out.chainsByProfession = chains
  return out
}

/** Reads a shuffle-edits v1 file (as written by tools/export_workbook_edits.py or the app's Export). */
export function normalizeEdits(raw: unknown): { edits: Edits; warnings: string[] } {
  const warnings: string[] = []
  if (!raw || typeof raw !== 'object') throw new Error('Not an edits file (expected a JSON object).')
  const r = raw as Record<string, unknown>
  if (r.format !== EDITS_FORMAT) throw new Error(`Not an edits file (format is ${JSON.stringify(r.format)}, expected "${EDITS_FORMAT}").`)
  if (r.version !== EDITS_VERSION) throw new Error(`Unsupported edits version ${JSON.stringify(r.version)} (this app reads version ${EDITS_VERSION}).`)
  const e = emptyEdits()

  for (const [k, v] of Object.entries((r.typedPrices ?? {}) as Record<string, unknown>)) {
    const n = num(v)
    if (n === null) warnings.push(`Typed price for item ${k} is not a number; ignored`)
    else e.typedPrices[k] = n
  }
  for (const [k, v] of Object.entries((r.vendorBuyOverrides ?? {}) as Record<string, unknown>)) {
    if (v === null || num(v) !== null) e.vendorBuyOverrides[k] = v as number | null
    else warnings.push(`Vendor buy override for item ${k} is not a number or null; ignored`)
  }
  e.settings = normSettings((r.settings ?? {}) as Record<string, unknown>, warnings)
  for (const [k, v] of Object.entries((r.allowCrafting ?? {}) as Record<string, unknown>)) {
    const b = yesNo(v)
    if (b === undefined || !/^\d+$/.test(k)) warnings.push(`Allow crafting for "${k}" ignored (needs an item ID and Yes/No)`)
    else e.allowCrafting[k] = b
  }
  e.useChainsNo = ((r.useChainsNo ?? []) as unknown[]).filter((x): x is number => typeof x === 'number')
  if (Array.isArray(r.deTable) && r.deTable.length) e.deTable = r.deTable as DeBand[]
  for (const row of (r.imports ?? []) as Record<string, unknown>[]) {
    const item = typeof row.item === 'string' ? Number(row.item) : row.item
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      warnings.push(`Import row without an item ID ignored (${JSON.stringify(row.name ?? null)})`)
      continue
    }
    e.imports.push({ item, name: (row.name as string) ?? null, p1: num(row.p1), p2: num(row.p2), p3: num(row.p3) } as ImportRow)
  }
  const info = r.importsInfo as Partial<ImportsInfo> | null | undefined
  if (info && typeof info.source === 'string' && typeof info.at === 'string' && typeof info.count === 'number') {
    e.importsInfo = { source: info.source, at: info.at, count: info.count }
  }
  return { edits: e, warnings }
}
