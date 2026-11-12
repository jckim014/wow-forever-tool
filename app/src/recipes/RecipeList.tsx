import { memo, useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { formatMoneyShort, formatQty } from '../format'
import type { FavoritesEdits, GameData, ModelResult, Money, RecipeRow } from '../model'
import { RecipeCard } from './RecipeCard'
import { exitFigures, type ExitView } from './filter'
import { FavPicker } from '../favorites/FavPicker'
import { toggleStar } from '../favorites/fav'

export type SortKey = 'name' | 'skill' | 'best' | 'profit' | 'cost' | 'ret'
const COLUMNS: { key: SortKey; label: string; num?: boolean; cls?: string; title?: string }[] = [
  { key: 'name', label: 'Recipe' },
  { key: 'skill', label: 'Skill', num: true, cls: 'c-skill', title: 'Profession skill needed to learn the recipe' },
  { key: 'best', label: 'Best exit', title: 'The priced exit worth the most per craft (ties: Vendor, then Disenchant, then AH). An amber marker names exits that apply but have no price yet.' },
  { key: 'profit', label: 'Profit', num: true, title: 'Best exit value minus the cheapest path, per craft' },
  { key: 'cost', label: 'Cost', num: true, cls: 'c-cost', title: 'Reagent cost by the cheapest path (crafting intermediates when cheaper and allowed)' },
  { key: 'ret', label: 'Return', num: true, cls: 'c-ret', title: 'Value of the best priced exit per craft' },
]
// Column titles when the list is judged on a single exit.
const EXIT_TITLE: Record<Exclude<ExitView, 'all'>, Partial<Record<SortKey, string>>> = {
  vendor: {
    profit: 'Vendor value minus the cheapest path, per craft',
    ret: 'What a vendor pays for the items made by one craft',
  },
  de: {
    profit: 'Expected disenchant value minus the cheapest path, per craft',
    ret: 'Expected value of disenchanting the items made by one craft (after Arcane Salvager and AH cut)',
  },
  ah: {
    profit: 'AH value minus the cheapest path, per craft',
    ret: 'AH sale price of the items made by one craft, after the AH cut',
  },
}
export type Sort = { key: SortKey; dir: 1 | -1 }
const sortValue: Record<SortKey, (r: RecipeRow, exit: ExitView) => string | number | null> = {
  name: (r) => r.recipe.name,
  skill: (r) => r.recipe.skill || null,
  best: (r) => r.bestExitName,
  profit: (r, e) => exitFigures(r, e).profit,
  cost: (r) => r.cheapest,
  ret: (r, e) => exitFigures(r, e).value,
}
const EXIT_LABEL = { Vendor: 'Vendor', Disenchant: 'DE', AH: 'AH' } as const

export function sortRows(rows: RecipeRow[], sort: Sort, exit: ExitView): RecipeRow[] {
  const get = sortValue[sort.key]
  return [...rows].sort((a, b) => {
    const x = get(a, exit), y = get(b, exit)
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1 // blanks last either way
    return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir
  })
}

/** Best exit has no column when the list is judged on one exit, so a sort on it falls back to profit. */
export const effectiveSort = (s: Sort | null, exit: ExitView): Sort | null =>
  s && exit !== 'all' && s.key === 'best' ? { key: 'profit', dir: -1 } : s

export const nextSort = (s: Sort | null, key: SortKey): Sort =>
  s && s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'best' || key === 'skill' ? 1 : -1 }

/** Which recipes are open, with a stable toggle for the memoised rows. */
export function useOpenSet() {
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const toggle = useCallback((id: number) => setOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  return { open, setOpen, toggle }
}

/** A callback with one identity that always calls the latest function, so memoised rows don't re-render. */
export function useStable<A extends unknown[]>(fn: (...a: A) => void) {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...a: A) => ref.current(...a), [])
}

export function Gold({ v, signed }: { v: Money; signed?: boolean }) {
  if (v === null) return <span className="blank">—</span>
  if (!signed) return <>{formatMoneyShort(v)}</>
  return <span className={`profit ${v >= 0 ? 'pos' : 'neg'}`}>{v > 0 ? '+' : ''}{formatMoneyShort(v)}</span>
}

export function ExitBadge({ name }: { name: RecipeRow['bestExitName'] }) {
  return name ? <span className={`badge b-${name}`}>{EXIT_LABEL[name]}</span> : <span className="badge b-none">no priced exit</span>
}

export function ListHead({ sort, exit, onSort }: { sort: Sort | null; exit: ExitView; onSort: (key: SortKey) => void }) {
  const single = exit !== 'all'
  return (
    <div className="rhead" role="row">
      <div />
      {COLUMNS.filter((c) => !single || c.key !== 'best').map((c) => (
        <div key={c.key} className={[c.num && 'num', c.cls].filter(Boolean).join(' ')}>
          <button onClick={() => onSort(c.key)} title={(single && EXIT_TITLE[exit][c.key]) || c.title}>
            {c.label}{sort?.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
          </button>
        </div>
      ))}
      <div />
    </div>
  )
}

export const Row = memo(function Row({ r, open, exit, onToggle, fav, onStar, onGrip }: {
  r: RecipeRow
  open: boolean
  exit: ExitView
  onToggle: (id: number) => void
  /** in Favorites */
  fav: boolean
  onStar: (id: number) => void
  /** set when the row can be dragged (Favorites, in your own order) */
  onGrip?: (id: number, e: DragEvent<HTMLElement>) => void
}) {
  const fig = exitFigures(r, exit)
  const makes = r.productName !== r.recipe.name || r.qtyMade !== 1
    ? ` · makes ${r.qtyMade !== 1 ? `${formatQty(r.qtyMade)}× ` : ''}${r.productName}` : ''
  return (
    <div
      className={`rrow${open ? ' open' : ''}`} role="button" tabIndex={0} aria-expanded={open}
      onClick={() => !window.getSelection()?.toString() && onToggle(r.recipe.id)}
      onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle(r.recipe.id))}
    >
      <div className="rlead">
        {onGrip && (
          <span
            className="fav-grip" draggable title="Drag to reorder, or onto another group's header to move it there"
            onClick={(e) => e.stopPropagation()} onDragStart={(e) => onGrip(r.recipe.id, e)}
          >⠿</span>
        )}
        <button
          className={fav ? 'fav-star on' : 'fav-star'} title={fav ? 'Remove from Favorites' : 'Add to Favorites (Unsorted)'}
          aria-pressed={fav} onClick={(e) => { e.stopPropagation(); onStar(r.recipe.id) }}
        >{fav ? '★' : '☆'}</button>
      </div>
      <div className="rname">
        <div className="name">{r.recipe.name}</div>
        <div className="sub">{r.recipe.profession}{r.recipe.skill ? <span className="sub-skill"> · {r.recipe.skill}</span> : ''}{makes}</div>
      </div>
      <div className="num c-skill">{r.recipe.skill || <span className="blank">—</span>}</div>
      {exit === 'all' && (
        <div>
          <ExitBadge name={r.bestExitName} />
          {r.unpricedExits.length > 0 && (
            <span className="unpriced" title={`${r.unpricedExits.join(', ')} unpriced: this exit applies but has no price yet`}>
              {r.unpricedExits.join(', ')} ?
            </span>
          )}
        </div>
      )}
      <div className="num"><Gold v={fig.profit} signed /></div>
      <div className="num c-cost"><Gold v={r.cheapest} /></div>
      <div className="num c-ret"><Gold v={fig.value} /></div>
      <div className="chev" aria-hidden>›</div>
    </div>
  )
})

export interface CardProps {
  result: ModelResult
  game: GameData
  onUseChains: (recipeId: number, on: boolean) => void
  shopping: Set<number>
  onShop: (recipeId: number) => void
  onOpenShopping: () => void
  favorites: FavoritesEdits
  updateFav: (fn: (f: FavoritesEdits) => FavoritesEdits) => void
}

/** The open recipe's card, with the shopping and Favorites controls. */
export function Card({ r, p }: { r: RecipeRow; p: CardProps }) {
  return (
    <RecipeCard
      row={r} result={p.result} game={p.game} onUseChains={p.onUseChains}
      inShopping={p.shopping.has(r.recipe.id)} onShop={p.onShop} onOpenShopping={p.onOpenShopping}
      fav={<FavPicker recipeId={r.recipe.id} favorites={p.favorites} updateFav={p.updateFav} />}
    />
  )
}

export function RecipeList({ rows, exit, ...p }: CardProps & { rows: RecipeRow[]; exit: ExitView }) {
  const [chosenSort, setSort] = useState<Sort>({ key: 'profit', dir: -1 })
  const { open, toggle } = useOpenSet()
  const sort = effectiveSort(chosenSort, exit)!
  const sorted = useMemo(() => sortRows(rows, sort, exit), [rows, sort.key, sort.dir, exit]) // eslint-disable-line react-hooks/exhaustive-deps
  const favIds = useMemo(() => new Set(p.favorites.groups.flatMap((g) => g.recipes)), [p.favorites])
  const onStar = useStable((id: number) => p.updateFav((f) => toggleStar(f, id)))

  return (
    <div className={exit !== 'all' ? 'rlist r-single' : 'rlist'}>
      <ListHead sort={sort} exit={exit} onSort={(key) => setSort((s) => nextSort(s, key))} />
      {sorted.length === 0 && <div className="rempty">No recipes match these filters.</div>}
      {sorted.map((r) => (
        <div key={r.recipe.id}>
          <Row r={r} open={open.has(r.recipe.id)} exit={exit} onToggle={toggle} fav={favIds.has(r.recipe.id)} onStar={onStar} />
          {open.has(r.recipe.id) && <Card r={r} p={p} />}
        </div>
      ))}
    </div>
  )
}
