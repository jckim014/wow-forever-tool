import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { config, loadGameData } from './data'
import { DataMenu, importEditsFile } from './DataMenu'
import { compute, effectiveSettings, type GameData } from './model'
import { useApiPrices } from './apiprices/useApiPrices'
import { ageText, API_OLD_MS } from './apiprices/read'
import { plural, usePageDrop, usePriceImport } from './PriceImport'
import { usePriceHistory } from './history/usePriceHistory'
import { isEmptyEdits } from './storage/doc'
import { useEditsStore } from './storage/useEditsStore'
import { filterRecipes, searchText, type ExitView, type RecipeFilters } from './recipes/filter'
import { RecipeList } from './recipes/RecipeList'
import { SettingsView } from './settings/SettingsView'
import { PricesView } from './itemprices/PricesView'
import { IntermediatesView } from './intermediates/IntermediatesView'
import { DeTableView } from './detable/DeTableView'
import { setUseChains } from './intermediates/inter'
import { ShoppingView } from './shopping/ShoppingView'
import { addRecipe } from './shopping/list'
import { FavoritesView } from './favorites/FavoritesView'
import { favoriteCount } from './favorites/fav'
import type { FavoritesEdits } from './model'

// The full-column table loads AG Grid (~1.4 MB), so it is fetched only when that view is opened.
const RecipesGrid = lazy(() => import('./grid/RecipesGrid'))

const EXIT_OPTIONS: { key: ExitView; label: string; title: string }[] = [
  { key: 'all', label: 'All', title: 'Every recipe, judged on its best priced exit' },
  { key: 'vendor', label: 'Vendor', title: 'Only recipes whose product sells to a vendor, with profit worked out on the vendor exit alone' },
  { key: 'de', label: 'Disenchant', title: 'Only recipes whose product can be disenchanted, with profit worked out on the disenchant exit alone' },
  { key: 'ah', label: 'AH', title: 'Every recipe, with profit worked out on selling the product on the auction house' },
]
const MIN_PROFIT_LABEL: Record<ExitView, string> = { all: 'Min profit at best exit', vendor: 'Min vendor profit', de: 'Min DE profit', ah: 'Min AH profit' }

type View = 'list' | 'favorites' | 'table' | 'prices' | 'intermediates' | 'detable' | 'settings' | 'shopping'
const VIEW_KEY = 'wow-forever-shuffle:view'
const savedView = (): View => {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'favorites' || v === 'table' || v === 'prices' || v === 'intermediates' || v === 'detable' || v === 'settings' || v === 'shopping' ? v : 'list'
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
  const [filters, setFilters] = useState<RecipeFilters>({ search: '', professions: new Set(), minProfitGold: null, hideUnpriced: false, hideBop: false, exit: 'all' })
  const [view, setView] = useState<View>(savedView)
  // List and Prices stay mounted once opened (hidden while another view shows): see keepAlive.ts
  const [kept, setKept] = useState<Set<View>>(() => new Set([view]))
  const [tableCount, setTableCount] = useState<number | null>(null)
  const addMessage = (m: string) => setMessage((prev) => (prev ? `${prev} ${m}` : m))
  const history = usePriceHistory(addMessage)
  const prices = usePriceImport(store, setMessage, history.keep)
  const api = useApiPrices(effectiveSettings(config, edits).apiHouse, addMessage)
  const dragging = usePageDrop((f) => (/\.json$/i.test(f.name) ? importEditsFile(store, f, setMessage) : prices.importFile(f)))

  useEffect(() => {
    loadGameData().then(setGame, (e: Error) => setError(e.message))
  }, [])

  const result = useMemo(() => (game ? compute(game, config, edits, api.data) : null), [game, edits, api.data])
  const text = useMemo(() => new Map((result?.recipes ?? []).map((r) => [r, searchText(r)])), [result])
  const rows = useMemo(() => (result ? filterRecipes(result.recipes, filters, text) : []), [result, filters, text])
  const shopIds = useMemo(() => new Set(edits.shopping.recipes.map((r) => r.id)), [edits.shopping])
  // Favorites: only the search box filters them (a favorite never disappears because its price moved).
  const favRows = useMemo(() => {
    const all: RecipeFilters = { search: filters.search, professions: new Set(), minProfitGold: null, hideUnpriced: false, hideBop: false, exit: 'all' }
    return new Map((result ? filterRecipes(result.recipes, all, text) : []).map((r) => [r.recipe.id, r]))
  }, [result, filters.search, text])

  const chooseView = useCallback((v: View) => {
    setView(v)
    setKept((k) => (k.has(v) ? k : new Set(k).add(v)))
    setTableCount(null)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // a per-browser convenience only
    }
  }, [])
  // Stable callbacks and card props, so the kept-alive List skips re-rendering when nothing it shows changed.
  const update = store.update
  const updateFav = useCallback((fn: (f: FavoritesEdits) => FavoritesEdits) => update((cur) => ({ ...cur, favorites: fn(cur.favorites) })), [update])
  const onUseChains = useCallback((id: number, on: boolean) => update((cur) => setUseChains(cur, id, on)), [update])
  const onShop = useCallback((id: number) => update((cur) => addRecipe(cur, id)), [update])
  const onOpenShopping = useCallback(() => chooseView('shopping'), [chooseView])
  const cardProps = useMemo(
    () => (result && game ? { result, game, onUseChains, shopping: shopIds, onShop, onOpenShopping, favorites: edits.favorites, updateFav } : null),
    [result, game, onUseChains, shopIds, onShop, onOpenShopping, edits.favorites, updateFav],
  )

  if (error) return <div className="message error">{error}</div>
  if (!game || !result || !cardProps) return <div className="message">Loading game data…</div>

  const favCount = favoriteCount(edits.favorites)
  const count = view === 'table' && tableCount !== null ? tableCount : rows.length

  const toggleProfession = (p: string) => {
    const next = new Set(filters.professions)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setFilters({ ...filters, professions: next })
  }

  return (
    <div className="app">
      {/* Row 1 and row 2 are the same on every tab; each view's own filters come below them. */}
      <header className="toolbar">
        <h1>Forever shuffle</h1>
        <div className="seg" role="group" aria-label="View">
          <button className={view === 'list' ? 'on' : ''} onClick={() => chooseView('list')} title="Compact list; click a recipe for the full breakdown">List</button>
          <button className={view === 'favorites' ? 'on' : ''} onClick={() => chooseView('favorites')} title="Recipes you starred, in your own groups">
            Favorites{favCount ? ` (${favCount})` : ''}
          </button>
          <button className={view === 'table' ? 'on' : ''} onClick={() => chooseView('table')} title="Every column, spreadsheet style">Table</button>
          <button className={view === 'prices' ? 'on' : ''} onClick={() => chooseView('prices')} title="Custom prices, vendor buy prices, and the price each item ends up using">Prices</button>
          <button className={view === 'intermediates' ? 'on' : ''} onClick={() => chooseView('intermediates')} title="Reagents that can be crafted: buy or craft, and Allow crafting">Intermediates</button>
          <button className={view === 'detable' ? 'on' : ''} onClick={() => chooseView('detable')} title="What each disenchant yields, by item level and quality">DE table</button>
          <button className={view === 'settings' ? 'on' : ''} onClick={() => chooseView('settings')} title="Price sources, AH cut, Arcane Salvager, crafting chains">Settings</button>
          <button className={view === 'shopping' ? 'on' : ''} onClick={() => chooseView('shopping')} title="Reagents for the recipes you picked, as an Auctionator shopping list">
            Shopping{edits.shopping.recipes.length ? ` (${edits.shopping.recipes.length})` : ''}
          </button>
        </div>
        <DataMenu
          store={store} onMessage={setMessage} onImportPrices={prices.importFile} onPastePrices={prices.openPaste}
          link={{ supported: prices.linkSupported, file: prices.linked?.file ?? null, onLink: prices.linkFile, onUnlink: prices.unlinkFile }}
          history={{ supported: history.supported, folder: history.folder, onChoose: history.choose, onStop: history.stop }}
          auctionData={{ supported: api.supported, folder: api.folder, onChoose: api.choose, onStop: api.stop }}
        />
      </header>
      <div className="statusbar">
        <span className="sb-msg">
          {message && <span className="note">{message} <button className="link" onClick={() => setMessage(null)}>dismiss</button></span>}
          {!message && store.status.kind !== 'loading' && isEmptyEdits(edits) && !prices.linked && !api.folder && (
            <span className="note">No prices yet: drop BavvbScan.lua (after /bscan in game) on the page, or use the File menu (Link price file to skip this next time).</span>
          )}
        </span>
        {(edits.importsInfo || prices.linked || history.folder || api.folder) && (
          <span className="note prices-info">
            {api.folder && (
              <span className="papi" title={`Hourly auction data from the collector (${api.folder}), read when the app opens and every 10 minutes. Per item, the newer of this and your import is used.`}>
                API: {api.data
                  ? (<>
                    {new Date(api.data.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}, house {api.data.house},{' '}
                    {plural(api.data.rows.length, 'item')}{' '}
                    <span className={api.now - Date.parse(api.data.at) > API_OLD_MS ? 'status warn' : 'papi-age'}>({ageText(api.data.at, api.now)})</span>
                    {!result.settings.useApiPrices && <span className="status warn"> (off in Settings)</span>}
                  </>)
                  : api.needsPermission ? 'Chrome needs your OK to read the folder' : api.error ?? 'reading…'}
                {api.needsPermission && <>{' '}<button className="button" onClick={api.refresh}>Allow reading</button></>}
                {!prices.linked && !api.needsPermission && <>{' '}<button className="button" onClick={api.refresh}>Refresh now</button></>}
              </span>
            )}
            {edits.importsInfo && (
              <span title={prices.linked ? undefined : 'Drop a new BavvbScan.lua on the page to refresh'}>
                Import: {edits.importsInfo.source}, {new Date(edits.importsInfo.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })},{' '}
                {plural(edits.importsInfo.count, 'item')}
              </span>
            )}
            {prices.linked && (
              <span className="plink" title="Checked when the app opens; WoW writes the file on /reload, logout or exit">
                Linked: {prices.linked.file}
                {prices.linked.needsPermission && <span className="status warn"> (Chrome needs your OK to read it)</span>}{' '}
                <button className="button" onClick={() => { prices.linked?.refresh(); if (api.folder) api.refresh() }}>Refresh now</button>
              </span>
            )}
            {history.folder && (
              <span className="phist" title="Every scan you import is saved here: the whole scan, zipped, and a per-item summary">
                History: {history.folder}{history.countText && `, ${history.countText}`}
                {history.needsPermission && (<>
                  {' '}<button className="button" onClick={history.approve}>
                    {history.waiting ? `Allow saving (${history.waiting} waiting)` : 'Allow saving'}
                  </button>
                </>)}
              </span>
            )}
          </span>
        )}
      </div>
      {(view === 'list' || view === 'table' || view === 'favorites') && (
        <div className="rfilters">
          <input
            className="search" type="search" placeholder="Search recipes, items, reagents…"
            value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          />
          <span className="field">
            Exit
            <span className="seg" role="group" aria-label="Exit">
              {EXIT_OPTIONS.map((o) => (
                <button key={o.key} className={filters.exit === o.key ? 'on' : ''} title={o.title} onClick={() => setFilters({ ...filters, exit: o.key })}>{o.label}</button>
              ))}
            </span>
          </span>
          {(view === 'list' || view === 'table') && (<>
          <label className="field">
            {MIN_PROFIT_LABEL[filters.exit]}
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
          <label className="field" title="Hide recipes whose product binds when picked up (the AH view always leaves them out)">
            <input type="checkbox" checked={filters.hideBop} onChange={(e) => setFilters({ ...filters, hideBop: e.target.checked })} />
            Hide BoP
          </label>
          <span className="count">{count.toLocaleString()} of {result.recipes.length.toLocaleString()} recipes</span>
          </>)}
        </div>
      )}
      {(view === 'list' || view === 'table') && (
        <nav className="chips">
          <button className={filters.professions.size === 0 ? 'chip on' : 'chip'} onClick={() => setFilters({ ...filters, professions: new Set() })}>
            All professions
          </button>
          {game.professions.map((p) => (
            <button key={p} className={filters.professions.has(p) ? 'chip on' : 'chip'} onClick={() => toggleProfession(p)}>{p}</button>
          ))}
        </nav>
      )}
      {kept.has('list') && (
        <div className={view === 'list' ? 'vkeep' : 'vkeep off'}>
          <RecipeList rows={rows} exit={filters.exit} active={view === 'list'} {...cardProps} />
        </div>
      )}
      {kept.has('prices') && (
        <div className={view === 'prices' ? 'vkeep' : 'vkeep off'}>
          <PricesView game={game} deTable={edits.deTable ?? config.deTable} edits={edits} result={result} update={store.update} active={view === 'prices'} />
        </div>
      )}
      {view === 'list' || view === 'prices' ? null : view === 'shopping' ? (
        <ShoppingView game={game} result={result} edits={edits} update={store.update} />
      ) : view === 'detable' ? (
        <DeTableView defaults={config.deTable} edits={edits} result={result} update={store.update} />
      ) : view === 'intermediates' ? (
        <IntermediatesView game={game} result={result} update={store.update} />
      ) : view === 'settings' ? (
        <SettingsView defaults={config.settings} settings={result.settings} edits={edits} update={store.update} />
      ) : view === 'favorites' ? (
        <FavoritesView rowsById={favRows} searching={!!filters.search.trim()} exit={filters.exit} {...cardProps} />
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
