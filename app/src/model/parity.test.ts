// Parity with the v2.5 workbook: compares the model against data/private/parity-v2.5.json, computed with the
// edits in data/private/edits-v2.5.json. Writes every difference to data/private/parity-report.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import defaults from '../../../data/config/defaults.json'
import deTable from '../../../data/config/de-table.json'
import { compute, makeConfig, normalizeEdits, type GameData, type Settings, type DeBand } from './index'

const ROOT = resolve(__dirname, '../../..')
const PRIV = resolve(ROOT, 'data/private')
const files = { edits: resolve(PRIV, 'edits-v2.5.json'), parity: resolve(PRIV, 'parity-v2.5.json') }
const missing = Object.values(files).filter((f) => !existsSync(f))
const TOL = 0.5
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

type Diff = { kind: 'recipe' | 'intermediate'; id: string; name: string; field: string; workbook: unknown; app: unknown }

// Differences Josh has reviewed and accepted (2026-10-22). Each recipe's product shares its name with another item;
// the workbook keyed prices by name, so the product's one price row used the other item's ID for imports. The app
// prices the product by its own ID.
const AH_FIELDS = ['ahPrice', 'ahValue', 'profitAH', 'profitBest', 'bestExit']
const KNOWN: Record<string, { fields: string[]; reason: string }> = {
  '1250791': { fields: AH_FIELDS, reason: 'Lesser Arcane Elixir: product 250342 is imported; workbook used 217398 (no import)' },
  '1255145': { fields: AH_FIELDS, reason: 'Dark Leather Boots: product 252425 has no import; workbook used 2315 (Uncommon boots, 500c)' },
  '1263425': { fields: AH_FIELDS, reason: 'Faction Banner: product 279973 is imported; workbook used 279972 (no import)' },
}
const isKnown = (d: Diff) => d.kind === 'recipe' && (KNOWN[d.id]?.fields.includes(d.field) ?? false)

describe.skipIf(missing.length > 0)('parity with workbook v2.5', () => {
  if (missing.length) return
  const game: GameData = read(resolve(ROOT, 'app/public/game-data.json'))
  const config = makeConfig(defaults as { settings: Settings; cooldownCrafts: { namePrefixes: string[]; names: string[] } }, deTable as { bands: DeBand[] })
  const { edits, warnings } = normalizeEdits(read(files.edits))
  const ref = read(files.parity)

  const t0 = performance.now()
  const result = compute(game, config, edits)
  const ms = performance.now() - t0

  const diffs: Diff[] = []
  const same = (a: unknown, b: unknown) =>
    typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= TOL : a === b
  const check = (kind: Diff['kind'], id: string, name: string, field: string, workbook: unknown, app: unknown) => {
    if (!same(workbook ?? null, app ?? null)) diffs.push({ kind, id, name, field, workbook: workbook ?? null, app: app ?? null })
  }

  const byId = new Map(result.recipes.map((r) => [String(r.recipe.id), r]))
  for (const [id, w] of Object.entries<Record<string, unknown>>(ref.recipes)) {
    const a = byId.get(id)
    if (!a) {
      diffs.push({ kind: 'recipe', id, name: String(w.name), field: '(missing in app)', workbook: null, app: null })
      continue
    }
    const appVals: Record<string, unknown> = {
      buyAll: a.buyAll, cheapest: a.cheapest, vendorValue: a.vendorValue, deValue: a.deValue, ahPrice: a.ahPrice,
      ahValue: a.ahValue, profitVendor: a.profitVendor, profitDE: a.profitDE, profitAH: a.profitAH,
      profitBest: a.profitBest, bestExit: a.bestExit, craftedInputs: a.craftedInputs,
      deBand: a.deBand?.band ?? 'Not disenchantable',
    }
    for (const [f, v] of Object.entries(appVals)) check('recipe', id, String(w.name), f, w[f], v)
  }
  for (const id of byId.keys()) if (!(id in ref.recipes)) diffs.push({ kind: 'recipe', id, name: byId.get(id)!.recipe.name, field: '(missing in workbook)', workbook: null, app: null })

  for (const [id, w] of Object.entries<Record<string, unknown>>(ref.intermediates)) {
    const a = result.intermediates.get(Number(id))
    if (!a) {
      diffs.push({ kind: 'intermediate', id, name: String(w.name), field: '(missing in app)', workbook: null, app: null })
      continue
    }
    for (const f of ['buy', 'craft', 'best', 'source'] as const) check('intermediate', id, String(w.name), f, w[f], a[f])
  }
  for (const [id, a] of result.intermediates) if (!(String(id) in ref.intermediates)) diffs.push({ kind: 'intermediate', id: String(id), name: a.name, field: '(missing in workbook)', workbook: null, app: null })

  const known = diffs.filter(isKnown)
  const unexplained = diffs.filter((d) => !isKnown(d))
  const byField: Record<string, number> = {}
  for (const d of unexplained) byField[`${d.kind}.${d.field}`] = (byField[`${d.kind}.${d.field}`] ?? 0) + 1
  writeFileSync(resolve(PRIV, 'parity-report.json'), JSON.stringify({ ms, warnings, byField, loops: result.loops, unexplained, known }, null, 1))
  console.log(`compute: ${ms.toFixed(0)} ms; ${unexplained.length} unexplained, ${known.length} known differences`, byField)

  it('reads the edits file without warnings', () => expect(warnings).toEqual([]))
  it('recalculates in well under a second', () => expect(ms).toBeLessThan(500))
  it('matches every recipe and intermediate within 0.5 copper', () =>
    expect(unexplained.length, 'see data/private/parity-report.json').toBe(0))
  it('still shows every known difference (remove an entry once it no longer differs)', () =>
    expect(new Set(known.map((d) => d.id))).toEqual(new Set(Object.keys(KNOWN))))
})

if (missing.length) {
  describe('parity with workbook v2.5', () => {
    it.skip(`skipped: private files missing (${missing.map((f) => f.replace(ROOT, '.')).join(', ')})`, () => {})
  })
}
