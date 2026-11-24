import { memo, useCallback, useMemo, useRef, useState, type DragEvent } from 'react'
import { formatMoneyShort, formatQty } from '../format'
import type { FavoritesEdits, GameData, ModelResult, Money, RecipeRow } from '../model'
import { RecipeCard } from './RecipeCard'
import type { SalesData } from '../apiprices/read'
import { exitFigures, type ExitView } from './filter'
import { FavPicker } from '../favorites/FavPicker'
import { useResetOnShow } from '../keepAlive'
import { toggleStar } from '../favorites/fav'

export type SortKey = 'name' | 'skill' | 'best' | 'profit' | 'cost' | 'ret' | 'sold' | 'tsm'
const COLUMNS: { key: SortKey; label: string; num?: boolean; cls?: string; title?: string }[] = [
  { key: 'name', label: 'Recipe' },
  { key: 'skill', label: 'Skill', num: true, cls: 'c-skill', title: 'Profession skill needed to learn the recipe' },
  { key: 'best', label: 'Best exit', title: 'The priced exit worth the most per craft (ties: Vendor, then Disenchant, then AH). An amber marker names exits that apply but have no price yet.' },
  { key: 'profit', label: 'Profit', num: true, title: 'Best exit value minus the cheapest path, per craft' },
  { key: 'cost', label: 'Cost', num: true, cls: 'c-cost', title: 'Reagent cost by the cheapest path (crafting intermediates when cheaper and allowed)' },
  { key: 'ret', label: 'Return', num: true, cls: 'c-ret', title: 'Value of the best priced exit per craft' },
  { key: 'sold', label: 'Sold / day', num: true, cls: 'c-sold', title: "Our estimate of the product sold per day on the API house's faction, last 7 days (as in Forever Market): from the hourly listings; includes some cancellations, misses items bought within the hour" },
  { key: 'tsm', label: 'TSM / day', num: true, cls: 'c-sold', title: "TSM's region sold per day for the product: pooled sales of TSM users across all Forever-US realms (from the TSM app, updated about daily)" },
]

/** The two sale figures per product: ours on one house, TSM's region-wide. Undefined = no data loaded; null = none seen. */
export interface SaleInfo { sales: SalesData | null; house: number }
const soldOf = (s: SaleInfo, item: number): number | null | undefined => {
  const h = s.sales?.houses[s.house]
  if (!h || !h.hours) return undefined
  return h.items.get(item) ?? null
}
const tsmOf = (s: SaleInfo, item: number): number | null | undefined => (s.sales?.tsm ? s.sales.tsm.items.get(item) ?? null : undefined)
const FACTION: Record<number, string> = { 111: 'Alliance', 114: 'Horde' }
export const soldLabel = (house: number) => `${FACTION[house] ?? `House ${house}`} / day`
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
const sortValue: Record<SortKey, (r: RecipeRow, exit: ExitView, s: SaleInfo) => string | number | null> = {
  name: (r) => r.recipe.name,
  skill: (r) => r.recipe.skill || null,
  best: (r) => r.bestExitName,
  profit: (r, e) => exitFigures(r, e).profit,
  cost: (r) => r.cheapest,
  ret: (r, e) => exitFigures(r, e).value,
  sold: (r, _e, s) => soldOf(s, r.recipe.product) ?? null,
  tsm: (r, _e, s) => tsmOf(s, r.recipe.product) ?? null,
}
const EXIT_LABEL = { Vendor: 'Vendor', Disenchant: 'DE', AH: 'AH' } as const

export function sortRows(rows: RecipeRow[], sort: Sort, exit: ExitView, sale: SaleInfo = { sales: null, house: 111 }): RecipeRow[] {
  const get = sortValue[sort.key]
  return [...rows].sort((a, b) => {
    const x = get(a, exit, sale), y = get(b, exit, sale)
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

export function ListHead({ sort, exit, onSort, house }: { sort: Sort | null; exit: ExitView; onSort: (key: SortKey) => void; house: number }) {
  const single = exit !== 'all'
  return (
    <div className="rhead" role="row">
      <div />
      {COLUMNS.filter((c) => !single || c.key !== 'best').map((c) => (
        <div key={c.key} className={[c.num && 'num', c.cls].filter(Boolean).join(' ')}>
          <button onClick={() => onSort(c.key)} title={(single && EXIT_TITLE[exit][c.key]) || c.title}>
            {c.key === 'sold' ? soldLabel(house) : c.label}{sort?.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
          </button>
        </div>
      ))}
      <div />
    </div>
  )
}

/** Units per day: one decimal under 10, "<0.1" for a trickle, a dash when there is no data. */
function PerDay({ v, none }: { v: number | null | undefined; none: string }) {
  if (v === undefined) return <span className="blank" title="No sale data: link the auction data folder (File menu); the PC sync writes sales.json">—</span>
  if (v === null || v === 0) return <span className="muted" title={none}>0</span>
  const text = v < 0.1 ? '<0.1' : v < 10 ? (Math.round(v * 10) / 10).toLocaleString() : Math.round(v).toLocaleString()
  return <>{text}</>
}

export const Row = memo(function Row({ r, open, exit, onToggle, fav, onStar, onGrip, sale }: {
  r: RecipeRow
  sale: SaleInfo
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
      <div className="num c-sold"><PerDay v={soldOf(sale, r.recipe.product)} none="None seen sold in the last 7 days" /></div>
      <div className="num c-sold"><PerDay v={tsmOf(sale, r.recipe.product)} none="TSM has no region sales for this item" /></div>
      <div className="chev" aria-hidden>›</div>
    </div>
  )
})

export interface CardProps {
  /** our sale-rate estimate (sales.json from the auction data folder), for the card's Sold / day */
  sales: SalesData | null
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
      row={r} result={p.result} game={p.game} sales={p.sales} onUseChains={p.onUseChains}
      inShopping={p.shopping.has(r.recipe.id)} onShop={p.onShop} onOpenShopping={p.onOpenShopping}
      fav={<FavPicker recipeId={r.recipe.id} favorites={p.favorites} updateFav={p.updateFav} />}
    />
  )
}

const DEFAULT_SORT: Sort = { key: 'profit', dir: -1 }

/** Sale figures for the rows: one object while the sales file and the API house stay the same (rows are memoised). */
export const useSaleInfo = (p: CardProps): SaleInfo => {
  const house = p.result.settings.apiHouse
  return useMemo(() => ({ sales: p.sales, house }), [p.sales, house])
}

/** The rows themselves: memoised apart from RecipeList so showing or hiding the kept-alive list doesn't re-render them. */
const ListBody = memo(function ListBody({ sorted, open, exit, toggle, favIds, onStar, p, sale }: {
  sale: SaleInfo
  sorted: RecipeRow[]; open: Set<number>; exit: ExitView; toggle: (id: number) => void
  favIds: Set<number>; onStar: (id: number) => void; p: CardProps
}) {
  return (<>
    {sorted.length === 0 && <div className="rempty">No recipes match these filters.</div>}
    {sorted.map((r) => (
      <div key={r.recipe.id}>
        <Row r={r} open={open.has(r.recipe.id)} exit={exit} onToggle={toggle} fav={favIds.has(r.recipe.id)} onStar={onStar} sale={sale} />
        {open.has(r.recipe.id) && <Card r={r} p={p} />}
      </div>
    ))}
  </>)
}, (a, b) => a.sale === b.sale && a.sorted === b.sorted && a.open === b.open && a.exit === b.exit && a.toggle === b.toggle && a.favIds === b.favIds &&
  a.onStar === b.onStar && (Object.keys(a.p) as (keyof CardProps)[]).every((k) => a.p[k] === b.p[k]))

export const RecipeList = memo(function RecipeList({ rows, exit, active = true, ...p }: CardProps & { rows: RecipeRow[]; exit: ExitView; active?: boolean }) {
  const [chosenSort, setSort] = useState<Sort>(DEFAULT_SORT)
  const { open, setOpen, toggle } = useOpenSet()
  const listRef = useRef<HTMLDivElement>(null)
  // Shown again after another view: start fresh, as when the list was rebuilt on every switch.
  useResetOnShow(active, () => {
    setSort(DEFAULT_SORT)
    setOpen((o) => (o.size ? new Set() : o))
    if (listRef.current) listRef.current.scrollTop = 0
  })
  const sort = effectiveSort(chosenSort, exit)!
  const sale = useSaleInfo(p)
  const sorted = useMemo(() => sortRows(rows, sort, exit, sale), [rows, sort.key, sort.dir, exit, sale]) // eslint-disable-line react-hooks/exhaustive-deps
  const favIds = useMemo(() => new Set(p.favorites.groups.flatMap((g) => g.recipes)), [p.favorites])
  const onStar = useStable((id: number) => p.updateFav((f) => toggleStar(f, id)))

  return (
    <div ref={listRef} className={exit !== 'all' ? 'rlist r-single' : 'rlist'}>
      <ListHead sort={sort} exit={exit} onSort={(key) => setSort((s) => nextSort(s, key))} house={sale.house} />
      <ListBody sorted={sorted} open={open} exit={exit} toggle={toggle} favIds={favIds} onStar={onStar} p={p} sale={sale} />
    </div>
  )
})
