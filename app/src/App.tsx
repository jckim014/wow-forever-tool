import { useEffect, useMemo, useState } from 'react'
import { config, loadGameData } from './data'
import { RecipesGrid, type RecipeFilters } from './grid/RecipesGrid'
import { compute, emptyEdits, normalizeEdits, type Edits, type GameData } from './model'
import './App.css'

export function App() {
  const [game, setGame] = useState<GameData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Edits>(emptyEdits)
  const [editsNote, setEditsNote] = useState<string | null>(null)
  const [filters, setFilters] = useState<RecipeFilters>({ search: '', professions: new Set(), minProfitGold: null, hideUnpriced: false })
  const [count, setCount] = useState(0)

  useEffect(() => {
    loadGameData().then(setGame, (e: Error) => setError(e.message))
  }, [])

  const result = useMemo(() => (game ? compute(game, config, edits) : null), [game, edits])

  // Temporary (step 2): load an edits file into memory only. Step 3 replaces this with saved storage.
  async function loadEditsFile(file: File) {
    try {
      const { edits: e, warnings } = normalizeEdits(JSON.parse(await file.text()))
      setEdits(e)
      setEditsNote(`Loaded ${file.name} (not saved)` + (warnings.length ? `, ${warnings.length} warning(s): ${warnings.slice(0, 3).join('; ')}` : ''))
    } catch (err) {
      setEditsNote(`Could not load ${file.name}: ${(err as Error).message}`)
    }
  }

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
        <label className="button">
          Load edits file
          <input type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && loadEditsFile(e.target.files[0])} />
        </label>
      </header>
      <nav className="chips">
        <button className={filters.professions.size === 0 ? 'chip on' : 'chip'} onClick={() => setFilters({ ...filters, professions: new Set() })}>
          All professions
        </button>
        {game.professions.map((p) => (
          <button key={p} className={filters.professions.has(p) ? 'chip on' : 'chip'} onClick={() => toggleProfession(p)}>{p}</button>
        ))}
        {editsNote && <span className="note">{editsNote}</span>}
        {!editsNote && <span className="note">No prices loaded: most rows show as unpriced until you load an edits file.</span>}
      </nav>
      <RecipesGrid rows={result.recipes} filters={filters} onCount={setCount} />
    </div>
  )
}
