import { useMemo, useState } from 'react'
import { deMaterials } from '../data'
import { formatMoney } from '../format'
import type { DeBand, DeResult, Edits, ModelResult } from '../model'
import { deValuePerDisenchant } from '../model/recipes'
import { NumberField } from '../NumberField'
import { toPercent } from '../settings/settingsEdits'
import { bandChanged, chanceSum, resetBand, resetTable, setBand } from './deEdits'

const MAX_RESULTS = 3
const BAND_LABEL = (b: DeBand) => (b.type === 'Any' ? b.quality : `${b.quality} ${b.type}`)
const rangeLabel = (b: DeBand) => (b.ilvlMax >= 999 || String(b.band).endsWith('+') ? `${b.ilvlMin}+` : `${b.ilvlMin}–${b.ilvlMax}`)

interface Props {
  defaults: DeBand[]
  edits: Edits
  result: ModelResult
  update: (fn: (cur: Edits) => Edits) => void
}

export function DeTableView({ defaults, edits, result, update }: Props) {
  const table = edits.deTable ?? defaults
  const [usedOnly, setUsedOnly] = useState(false)
  const [changedOnly, setChangedOnly] = useState(false)

  const uses = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of result.recipes) if (r.deBand) m.set(r.deBand.band, (m.get(r.deBand.band) ?? 0) + 1)
    return m
  }, [result])

  const changed = table.map((b, i) => bandChanged(b, defaults[i]))
  const anyChanged = changed.some(Boolean)
  const groups = useMemo(() => {
    const out: { range: string; bands: { band: DeBand; index: number }[] }[] = []
    table.forEach((band, index) => {
      const range = rangeLabel(band)
      let g = out.find((x) => x.range === range)
      if (!g) out.push((g = { range, bands: [] }))
      g.bands.push({ band, index })
    })
    return out
  }, [table])

  const setResults = (index: number, results: DeResult[]) => update((cur) => setBand(cur, defaults, index, { results }))
  const setResult = (index: number, j: number, change: Partial<DeResult>) =>
    setResults(index, table[index].results.map((r, k) => (k === j ? { ...r, ...change } : r)))

  return (
    <div className="pview">
      <div className="pfilters">
        <label className="field"><input type="checkbox" checked={usedOnly} onChange={(e) => setUsedOnly(e.target.checked)} /> Only bands with recipes</label>
        <label className="field"><input type="checkbox" checked={changedOnly} onChange={(e) => setChangedOnly(e.target.checked)} /> Changed only</label>
        <span className="muted">Value per disenchant uses current sale prices, before the Salvager and the AH cut.</span>
        <button className="button" style={{ marginLeft: 'auto' }} disabled={!anyChanged}
          onClick={() => window.confirm('Reset every band to the default table?') && update(resetTable)}>
          Reset table
        </button>
      </div>
      <div className="plist dlist">
        <div className="dhead">
          <div>Band</div><div>Results: material · chance · quantity</div>
          <div className="num" title="Expected value of one disenchant at current sale prices, before the Salvager and the AH cut">Value per DE</div>
          <div className="num" title="Recipes whose product falls in this band">Recipes</div>
        </div>
        {groups.map((g) => {
          const shown = g.bands.filter(({ band, index }) => (!usedOnly || uses.has(band.band)) && (!changedOnly || changed[index]))
          if (!shown.length) return null
          return (
            <section key={g.range} className="dgroup">
              <h3>Item level {g.range}</h3>
              {shown.map(({ band, index }) => {
                const v = deValuePerDisenchant(band, result.prices)
                const sum = chanceSum(band)
                const off = Math.abs(sum - 1) > 1e-9
                return (
                  <div key={band.band} className={`dband${changed[index] ? ' changed' : ''}`}>
                    <div className="dlabel">
                      <b className={`qual-${band.quality === 'Uncommon' ? 2 : band.quality === 'Rare' ? 3 : 4}`}>{BAND_LABEL(band)}</b>
                      {changed[index] && (
                        <span className="dflt">changed · <button className="link" onClick={() => update((cur) => resetBand(cur, defaults, index))}>reset</button></span>
                      )}
                    </div>
                    <div className="dresults">
                      {band.results.map((r, j) => (
                        <div key={j} className="dres">
                          <select value={r.item ?? ''} aria-label="Material"
                            onChange={(e) => {
                              const m = deMaterials.find((x) => x.item === Number(e.target.value))
                              if (m) setResult(index, j, { item: m.item, name: m.name })
                            }}>
                            {r.item === null && <option value="">{r.name || '(none)'}</option>}
                            {deMaterials.map((m) => <option key={m.item} value={m.item}>{m.name}</option>)}
                          </select>
                          <span className="num">
                            <NumberField className="dnum" value={toPercent(r.chance)} min={0} max={100} onCommit={(n) => setResult(index, j, { chance: n / 100 })} /> %
                          </span>
                          <span className="num">
                            <NumberField className="dnum" integer value={r.min ?? 0} min={0} onCommit={(n) => setResult(index, j, { min: n })} />
                            {' – '}
                            <NumberField className="dnum" integer value={r.max ?? 0} min={0} onCommit={(n) => setResult(index, j, { max: n })} />
                          </span>
                          <button className="clear" title="Remove this result" disabled={band.results.length === 1}
                            onClick={() => setResults(index, band.results.filter((_, k) => k !== j))}>✕</button>
                        </div>
                      ))}
                      <div className="dfoot">
                        {band.results.length < MAX_RESULTS && (
                          <button className="link" onClick={() => {
                            const m = deMaterials.find((x) => !band.results.some((r) => r.item === x.item)) ?? deMaterials[0]
                            setResults(index, [...band.results, { item: m.item, name: m.name, chance: 0, min: 1, max: 1 }])
                          }}>+ add result</button>
                        )}
                        {off && <span className="dwarn">⚠ chances add to {toPercent(sum)}%</span>}
                        {(band.results.some((r) => (r.min ?? 0) > (r.max ?? 0))) && <span className="dwarn">⚠ a minimum is above its maximum</span>}
                      </div>
                      <input className="dnote" placeholder="Note" value={band.note}
                        onChange={(e) => update((cur) => setBand(cur, defaults, index, { note: e.target.value }))} />
                    </div>
                    <div className="num dval">{v.value === null ? <span className="miss">unpriced</span> : formatMoney(v.value, true)}</div>
                    <div className="num dval">{uses.get(band.band) ?? <span className="blank">0</span>}</div>
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
