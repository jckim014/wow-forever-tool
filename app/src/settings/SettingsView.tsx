import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Edits, Settings } from '../model'
import { deMultiplier } from '../model/recipes'
import { resetAllSettings, setChains, setSetting, toPercent, type ScalarKey } from './settingsEdits'

const IMPORT_COLUMNS: { col: 1 | 2 | 3; label: string }[] = [
  { col: 1, label: 'Latest lowest buyout' },
  { col: 2, label: 'Median of the last 7 daily lows' },
  { col: 3, label: 'Lowest of the last 7 daily lows' },
]

interface Props {
  defaults: Settings
  /** Defaults plus the user's edits (what the model uses). */
  settings: Settings
  edits: Edits
  update: (fn: (cur: Edits) => Edits) => void
}

export function SettingsView({ defaults, settings, edits, update }: Props) {
  const set = <K extends ScalarKey>(key: K, value: Settings[K]) => update((cur) => setSetting(cur, defaults, key, value))
  const reset = (key: ScalarKey) => set(key, defaults[key])
  const changed = (key: ScalarKey) => settings[key] !== defaults[key]
  const anyChanged = Object.keys(edits.settings).length > 0

  /** "default: 5%" with a reset link, shown only when the value differs from the default. */
  const dflt = (key: ScalarKey, text: string) =>
    changed(key) && (
      <span className="dflt">
        default: {text} · <button className="link" onClick={() => reset(key)}>reset</button>
      </span>
    )
  const pct = (key: 'ahCut' | 'salvagerProcChance' | 'salvagerFlatBonus', max?: number) => (
    <>
      <span className="unit"><NumberField value={toPercent(settings[key])} min={0} max={max} onCommit={(n) => set(key, n / 100)} /> %</span>
      {dflt(key, `${toPercent(defaults[key])}%`)}
    </>
  )
  const salv = settings.salvagerOn ? '' : ' off'
  const chainsChanged = Object.keys(defaults.chainsByProfession).filter((p) => settings.chainsByProfession[p] !== defaults.chainsByProfession[p])
  const resetChains = () => update((cur) => chainsChanged.reduce((e, p) => setChains(e, defaults, p, defaults.chainsByProfession[p]), cur))

  return (
    <div className="settings">
      <Group title="Prices">
        <Row>
          <label><input type="checkbox" checked={settings.useVendorBuy} onChange={(e) => set('useVendorBuy', e.target.checked)} />
            Use vendor buy price for reagents with no custom price</label>
          {dflt('useVendorBuy', defaults.useVendorBuy ? 'on' : 'off')}
        </Row>
        <Row>
          <label><input type="checkbox" checked={settings.useImports} onChange={(e) => set('useImports', e.target.checked)} />
            Use imported prices</label>
          {dflt('useImports', defaults.useImports ? 'on' : 'off')}
        </Row>
        <div className={settings.useImports ? 'ssub' : 'ssub off'}>
          <div className="lbl">Imported price column</div>
          {IMPORT_COLUMNS.map(({ col, label }) => (
            <label key={col} className="radio">
              <input type="radio" name="importColumn" checked={settings.importColumn === col} disabled={!settings.useImports}
                onChange={() => set('importColumn', col)} />
              {col} · {label}
            </label>
          ))}
          {dflt('importColumn', `column ${defaults.importColumn}`)}
        </div>
        <p className="hint">Reagent cost uses a custom price first, then the vendor buy price (if on), then the imported price (if on).
          Selling prices use a custom price, then the imported price; never a vendor price.</p>
      </Group>

      <Group title="Selling">
        <Row><span className="lbl">AH cut on sales</span>{pct('ahCut', 100)}</Row>
        <p className="hint">Taken off disenchant materials and crafted items sold on the auction house. Deposits are not modeled.</p>
      </Group>

      <Group title="Arcane Salvager">
        <Row>
          <label><input type="checkbox" checked={settings.salvagerOn} onChange={(e) => set('salvagerOn', e.target.checked)} />
            Salvager in use</label>
          {dflt('salvagerOn', defaults.salvagerOn ? 'on' : 'off')}
        </Row>
        <div className={`ssub${salv}`}>
          <Row><span className="lbl">Proc chance per disenchant</span>{pct('salvagerProcChance', 100)}</Row>
          <Row>
            <span className="lbl">Extra full disenchants per proc</span>
            <NumberField value={settings.salvagerExtraPerProc} min={0} onCommit={(n) => set('salvagerExtraPerProc', n)} />
            {dflt('salvagerExtraPerProc', String(defaults.salvagerExtraPerProc))}
          </Row>
          <Row><span className="lbl">Flat yield bonus</span>{pct('salvagerFlatBonus')}</Row>
        </div>
        <p className="hint">
          Disenchant value multiplier now: <b>{deMultiplier(settings).toFixed(3).replace(/\.?0+$/, '')}×</b>
          {settings.salvagerOn ? ' = (1 + flat bonus) × (1 + proc chance × extra per proc)' : ' (Salvager off)'}
        </p>
      </Group>

      <Group title="Crafting chains">
        <p className="hint">Craft intermediates with these professions. Off means a reagent made by that profession is always bought.
          {chainsChanged.length > 0 && (
            <span className="dflt">default: all on · <button className="link" onClick={resetChains}>reset</button></span>
          )}</p>
        <div className="checks">
          {Object.keys(defaults.chainsByProfession).map((p) => (
            <label key={p}>
              <input type="checkbox" checked={settings.chainsByProfession[p] ?? true}
                onChange={(e) => update((cur) => setChains(cur, defaults, p, e.target.checked))} />
              {p}
            </label>
          ))}
        </div>
      </Group>

      <div className="settings-foot">
        <button className="button" disabled={!anyChanged}
          onClick={() => window.confirm('Reset every setting to its default? Prices and other edits are kept.') && update(resetAllSettings)}>
          Reset all settings
        </button>
        {!anyChanged && <span className="muted">All settings are at their defaults.</span>}
      </div>
    </div>
  )
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="sgroup"><h2>{title}</h2>{children}</section>
)
const Row = ({ children }: { children: ReactNode }) => <div className="srow">{children}</div>

/** A number box that commits each valid value as it is typed and tidies itself up on blur. */
function NumberField({ value, min, max, onCommit }: { value: number; min?: number; max?: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])
  const valid = (n: number) => Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)
  const bad = draft.trim() === '' || !valid(Number(draft))
  return (
    <input
      type="number" step="any" min={min} max={max} className={bad ? 'snum bad' : 'snum'} value={draft}
      title={bad ? `Enter a number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}` : undefined}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; setDraft(String(value)) }}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = Number(e.target.value)
        if (e.target.value.trim() !== '' && valid(n)) onCommit(n)
      }}
    />
  )
}
