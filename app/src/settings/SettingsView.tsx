import type { ReactNode } from 'react'
import type { Edits, Settings } from '../model'
import { deMultiplier } from '../model/recipes'
import { NumberField } from '../NumberField'
import { resetAllSettings, setChains, setSetting, toPercent, type ScalarKey } from './settingsEdits'

/** What the three imported columns mean, by the addon the current prices came from (importsInfo.source). */
/** The WoW Forever US auction houses in the API (2026-11-12). Only 111 is confirmed; the others are guesses from the ID pattern. */
const API_HOUSES: [number, string][] = [
  [111, 'Alliance, your realm (CAMWOW US1 Realm 3 PvE)'], [114, 'Horde, your realm (probably)'], [117, 'Blackwater, your realm (probably)'],
  [110, 'Alliance, other big realm (PvP?)'], [113, 'Horde, other big realm'], [116, 'Blackwater, other big realm'],
  [119, 'Alliance, smaller realm'], [120, 'Horde, smaller realm'], [121, 'Blackwater, smaller realm'],
  [123, 'Alliance, smaller realm 2'], [124, 'Horde, smaller realm 2'], [125, 'Blackwater, smaller realm 2'],
  [112, 'empty'], [115, 'empty'], [118, 'empty'],
]

const COLUMN_LABELS: { prefix: string; labels: [string, string, string] }[] = [
  { prefix: 'BavvbScan', labels: ['Lowest buyout per unit', 'Median per unit (by units listed)', 'Average of the cheapest 15% of units'] },
  { prefix: 'Auctioneer', labels: ['Lowest buyout per unit', 'Median per unit (by units listed)', 'Average of the cheapest 15% of units'] },
  { prefix: 'Auctionator', labels: ['Latest lowest buyout', 'Median of the last 7 daily lows', 'Lowest of the last 7 daily lows'] },
]
function importColumnLabels(source: string | null | undefined): [string, string, string] {
  return COLUMN_LABELS.find((c) => source?.startsWith(c.prefix))?.labels ?? ['Price 1 of your import', 'Price 2 of your import', 'Price 3 of your import']
}

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
        <div className={settings.useImports || settings.useApiPrices ? 'ssub' : 'ssub off'}>
          <div className="lbl">Imported price column (imports and API data)</div>
          {importColumnLabels(edits.importsInfo?.source).map((label, k) => {
            const col = (k + 1) as 1 | 2 | 3
            return (
              <label key={col} className="radio">
                <input type="radio" name="importColumn" checked={settings.importColumn === col} disabled={!settings.useImports && !settings.useApiPrices}
                  onChange={() => set('importColumn', col)} />
                {col} · {label}
              </label>
            )
          })}
          {dflt('importColumn', `column ${defaults.importColumn}`)}
        </div>
        <Row>
          <label><input type="checkbox" checked={settings.useApiPrices} onChange={(e) => set('useApiPrices', e.target.checked)} />
            Use API prices (hourly auction data from the collector)</label>
          {dflt('useApiPrices', defaults.useApiPrices ? 'on' : 'off')}
        </Row>
        <div className={settings.useApiPrices ? 'ssub' : 'ssub off'}>
          <Row>
            <span className="lbl">Auction house</span>
            <select value={settings.apiHouse} disabled={!settings.useApiPrices} onChange={(e) => set('apiHouse', Number(e.target.value))}>
              {API_HOUSES.map(([id, label]) => <option key={id} value={id}>{id} · {label}</option>)}
            </select>
            {dflt('apiHouse', String(defaults.apiHouse))}
          </Row>
          <p className="hint">Read from the auction data folder (File menu). Uses the same column as imports.</p>
        </div>
        <p className="hint">Reagent cost uses a custom price first, then the vendor buy price (if on), then the imported price (if on).
          Selling prices use a custom price, then the imported price; never a vendor price. The imported price is from your
          price import or the API data, whichever is newer for that item (the other fills items it lacks).</p>
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
