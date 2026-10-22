import { useEffect, useMemo, useState } from 'react'
import { config, loadGameData } from './data'
import { RecipesGrid, type RecipeFilters } from './grid/RecipesGrid'
import { DataMenu, importEditsFile } from './DataMenu'
import { compute, type GameData } from './model'
import { plural, usePageDrop, usePriceImport } from './PriceImport'
import { isEmptyEdits } from './storage/doc'
import { useEditsStore } from './storage/useEditsStore'
import './App.css'

export function App() {
  const [game, setGame] = useState<GameData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const store = useEditsStore()
  const edits = store.edits
  const [message, setMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState<RecipeFilters>({ search: '', professions: new Set(), minProfitGold: null, hideUnpriced: false })
  const [count, setCount] = useState(0)
  const prices = usePriceImport(store, setMessage)
  const dragging = usePageDrop((f) => (/\.json$/i.test(f.name) ? importEditsFile(store, f, setMessage) : prices.importFile(f)))

  useEffect(() => {
    loadGameData().then(setGame, (e: Error) => setError(e.message))
  }, [])

  const result = useMemo(() => (game ? compute(game, config, edits) : null), [game, edits])

  if (error) return <div className="message error">{error}</div>
  if (!game || !result) return <div className="message">Loading game data…</div>

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
        <span className="count">{count} of {result.recipes.length} recipes</span>
        <DataMenu store={store} onMessage={setMessage} onImportPrices={prices.importFile} onPastePrices={prices.openPaste} />
      </header>
      <nav className="chips">
        <button className={filters.professions.size === 0 ? 'chip on' : 'chip'} onClick={() => setFilters({ ...filters, professions: new Set() })}>
          All professions
        </button>
        {game.professions.map((p) => (
          <button key={p} className={filters.professions.has(p) ? 'chip on' : 'chip'} onClick={() => toggleProfession(p)}>{p}</button>
        ))}
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
      <RecipesGrid rows={result.recipes} filters={filters} onCount={setCount} />
      {prices.dialogs}
      {dragging && <div className="drop-overlay">Drop Auctionator.zip (or a price .csv, or an edits .json) to import</div>}
    </div>
  )
}
