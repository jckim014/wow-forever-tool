import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { config, loadGameData } from './data'
import { DataMenu, importEditsFile } from './DataMenu'
import { compute, type GameData } from './model'
import { plural, usePageDrop, usePriceImport } from './PriceImport'
import { isEmptyEdits } from './storage/doc'
import { useEditsStore } from './storage/useEditsStore'
import { filterRecipes, searchText, type RecipeFilters } from './recipes/filter'
import { RecipeList } from './recipes/RecipeList'
import { SettingsView } from './settings/SettingsView'
import { PricesView } from './itemprices/PricesView'
import { IntermediatesView } from './intermediates/IntermediatesView'
import { DeTableView } from './detable/DeTableView'
import { setUseChains } from './intermediates/inter'

// The full-column table loads AG Grid (~1.4 MB), so it is fetched only when that view is opened.
const RecipesGrid = lazy(() => import('./grid/RecipesGrid'))

type View = 'list' | 'table' | 'prices' | 'intermediates' | 'detable' | 'settings'
const VIEW_KEY = 'wow-forever-shuffle:view'
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'table' || v === 'prices' || v === 'intermediates' || v === 'detable' || v === 'settings' ? v : 'list'
  } catch {
    return 'list'
  }
}
import './App.css'

export function App() {
  const [game, setGame] = useState<GameData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const store = useEditsStore()
  const edits = store.edits
  const [message, setMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState<RecipeFilters>({ search: '', professions: new Set(), minProfitGold: null, hideUnpriced: false })
  const [view, setView] = useState<View>(savedView)
  const [tableCount, setTableCount] = useState<number | null>(null)
  const prices = usePriceImport(store, setMessage)
  const dragging = usePageDrop((f) => (/\.json$/i.test(f.name) ? importEditsFile(store, f, setMessage) : prices.importFile(f)))

  useEffect(() => {
    loadGameData().then(setGame, (e: Error) => setError(e.message))
  }, [])

  const result = useMemo(() => (game ? compute(game, config, edits) : null), [game, edits])
  const text = useMemo(() => new Map((result?.recipes ?? []).map((r) => [r, searchText(r)])), [result])
  const rows = useMemo(() => (result ? filterRecipes(result.recipes, filters, text) : []), [result, filters, text])

  if (error) return <div className="message error">{error}</div>
  if (!game || !result) return <div className="message">Loading game data…</div>

  const chooseView = (v: View) => {
    setView(v)
    setTableCount(null)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // a per-browser convenience only
    }
  }
  const count = view === 'table' && tableCount !== null ? tableCount : rows.length

  const toggleProfession = (p: string) => {
    const next = new Set(filters.professions)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setFilters({ ...filters, professions: next })
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Forever shuffle</h1>
        {(view === 'list' || view === 'table') && (<>
        <input
          className="search" type="search" placeholder="Search recipes, items, reagents…"
          value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
        <label className="field">
          Min profit at best exit
          <input
            type="number" step="any" placeholder="gold" className="gold"
            value={filters.minProfitGold ?? ''}
            onChange={(e) => setFilters({ ...filters, minProfitGold: e.target.value === '' ? null : Number(e.target.value) })}
          />
          g
        </label>
        <label className="field">
          <input type="checkbox" checked={filters.hideUnpriced} onChange={(e) => setFilters({ ...filters, hideUnpriced: e.target.checked })} />
          Hide unpriced
        </label>
        <span className="count">{count.toLocaleString()} of {result.recipes.length.toLocaleString()} recipes</span>
        </>)}
        <div className="seg" role="group" aria-label="View">
          <button className={view === 'list' ? 'on' : ''} onClick={() => chooseView('list')} title="Compact list; click a recipe for the full breakdown">List</button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => chooseView('table')} title="Every column, spreadsheet style">Table</button>
          <button className={view === 'prices' ? 'on' : ''} onClick={() => chooseView('prices')} title="Custom prices, vendor buy prices, and the price each item ends up using">Prices</button>
          <button className={view === 'intermediates' ? 'on' : ''} onClick={() => chooseView('intermediates')} title="Reagents that can be crafted: buy or craft, and Allow crafting">Intermediates</button>
          <button className={view === 'detable' ? 'on' : ''} onClick={() => chooseView('detable')} title="What each disenchant yields, by item level and quality">DE table</button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => chooseView('settings')} title="Price sources, AH cut, Arcane Salvager, crafting chains">Settings</button>
        </div>
        <DataMenu store={store} onMessage={setMessage} onImportPrices={prices.importFile} onPastePrices={prices.openPaste} />
      </header>
      <nav className="chips">
        {(view === 'list' || view === 'table') && (<>
        <button className={filters.professions.size === 0 ? 'chip on' : 'chip'} onClick={() => setFilters({ ...filters, professions: new Set() })}>
          All professions
        </button>
        {game.professions.map((p) => (
          <button key={p} className={filters.professions.has(p) ? 'chip on' : 'chip'} onClick={() => toggleProfession(p)}>{p}</button>
        ))}
        </>)}
        {message && <span className="note">{message} <button className="link" onClick={() => setMessage(null)}>dismiss</button></span>}
        {!message && store.status.kind !== 'loading' && isEmptyEdits(edits) && (
          <span className="note">No prices yet: drop Auctionator.zip on the page, or use the File menu.</span>
        )}
        {edits.importsInfo && (
          <span className="note prices-info" title="Drop a new Auctionator.zip on the page to refresh">
            Prices: {edits.importsInfo.source}, {new Date(edits.importsInfo.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })},{' '}
            {plural(edits.importsInfo.count, 'item')}
          </span>
        )}
      </nav>
      {view === 'detable' ? (
        <DeTableView defaults={config.deTable} edits={edits} result={result} update={store.update} />
      ) : view === 'intermediates' ? (
        <IntermediatesView game={game} result={result} update={store.update} />
      ) : view === 'prices' ? (
        <PricesView game={game} deTable={edits.deTable ?? config.deTable} edits={edits} result={result} update={store.update} />
      ) : view === 'settings' ? (
        <SettingsView defaults={config.settings} settings={result.settings} edits={edits} update={store.update} />
      ) : view === 'list' ? (
        <RecipeList rows={rows} result={result} game={game} onUseChains={(id, on) => store.update((cur) => setUseChains(cur, id, on))} />
      ) : (
        <Suspense fallback={<div className="message">Loading the table…</div>}>
          <RecipesGrid rows={rows} onCount={setTableCount} />
        </Suspense>
      )}
      {prices.dialogs}
      {dragging && <div className="drop-overlay">Drop Auctionator.zip (or a price .csv, or an edits .json) to import</div>}
    </div>
  )
}
