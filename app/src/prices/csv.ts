// Pasted or CSV prices with the Imports-tab columns: item ID, name (optional), price 1, price 2, price 3 (copper).
// Tab-separated (a paste from a spreadsheet) or comma-separated; a header row and blank lines are skipped.
import type { ImportRow } from '../model'

function splitLine(line: string, sep: string): string[] {
  if (sep === '\t') return line.split('\t')
  const out: string[] = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out
}

export interface CsvResult {
  rows: ImportRow[]
  warnings: string[]
}

export function parsePriceTable(text: string): CsvResult {
  const rows: ImportRow[] = []
  const warnings: string[] = []
  const seen = new Set<number>()
  const lines = text.split(/\r?\n/)
  lines.forEach((line, n) => {
    if (!line.trim()) return
    const cells = splitLine(line, line.includes('\t') ? '\t' : ',').map((c) => c.trim())
    const id = cells[0]
    if (!/^\d+$/.test(id)) {
      if (rows.length) warnings.push(`Line ${n + 1}: no item ID in the first column; skipped`)
      return // before any data row: a header
    }
    const price = (k: number): number | null => {
      const v = (cells[k] ?? '').replace(/[\s,]/g, '')
      if (v === '') return null
      const x = Number(v)
      if (!Number.isFinite(x) || x < 0) {
        warnings.push(`Line ${n + 1}: price ${k - 1} "${cells[k]}" is not a copper amount; left blank`)
        return null
      }
      return x
    }
    const item = Number(id)
    if (seen.has(item)) warnings.push(`Line ${n + 1}: item ${item} appears again; the first row is used`)
    seen.add(item)
    rows.push({ item, name: cells[1] || null, p1: price(2), p2: price(3), p3: price(4) })
  })
  return { rows, warnings }
}
