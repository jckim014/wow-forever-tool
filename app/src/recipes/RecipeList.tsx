import { memo, useMemo, useState } from 'react'
import { formatMoneyShort, formatQty } from '../format'
import type { GameData, ModelResult, Money, RecipeRow } from '../model'
import { RecipeCard } from './RecipeCard'

type SortKey = 'name' | 'skill' | 'best' | 'profit' | 'cost' | 'ret'
const COLUMNS: { key: SortKey; label: string; num?: boolean; cls?: string; title?: string }[] = [
  { key: 'name', label: 'Recipe' },
  { key: 'skill', label: 'Skill', num: true, cls: 'c-skill', title: 'Profession skill needed to learn the recipe' },
  { key: 'best', label: 'Best exit', title: 'The priced exit worth the most per craft (ties: Vendor, then Disenchant, then AH). An amber marker names exits that apply but have no price yet.' },
  { key: 'profit', label: 'Profit', num: true, title: 'Best exit value minus the cheapest path, per craft' },
  { key: 'cost', label: 'Cost', num: true, cls: 'c-cost', title: 'Reagent cost by the cheapest path (crafting intermediates when cheaper and allowed)' },
  { key: 'ret', label: 'Return', num: true, cls: 'c-ret', title: 'Value of the best priced exit per craft' },
]
const sortValue: Record<SortKey, (r: RecipeRow) => string | number | null> = {
  name: (r) => r.recipe.name,
  skill: (r) => r.recipe.skill || null,
  best: (r) => r.bestExitName,
  profit: (r) => r.profitBest,
  cost: (r) => r.cheapest,
  ret: (r) => r.bestValue,
}
const EXIT_LABEL = { Vendor: 'Vendor', Disenchant: 'DE', AH: 'AH' } as const

export function Gold({ v, signed }: { v: Money; signed?: boolean }) {
  if (v === null) return <span className="blank">—</span>
  if (!signed) return <>{formatMoneyShort(v)}</>
  return <span className={`profit ${v >= 0 ? 'pos' : 'neg'}`}>{v > 0 ? '+' : ''}{formatMoneyShort(v)}</span>
}

export function ExitBadge({ name }: { name: RecipeRow['bestExitName'] }) {
  return name ? <span className={`badge b-${name}`}>{EXIT_LABEL[name]}</span> : <span className="badge b-none">no priced exit</span>
}

const Row = memo(function Row({ r, open, onToggle }: { r: RecipeRow; open: boolean; onToggle: (id: number) => void }) {
  const makes = r.productName !== r.recipe.name || r.qtyMade !== 1
    ? ` · makes ${r.qtyMade !== 1 ? `${formatQty(r.qtyMade)}× ` : ''}${r.productName}` : ''
  return (
    <div
      className={`rrow${open ? ' open' : ''}`} role="button" tabIndex={0} aria-expanded={open}
      onClick={() => !window.getSelection()?.toString() && onToggle(r.recipe.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle(r.recipe.id))}
    >
      <div className="rname">
        <div className="name">{r.recipe.name}</div>
        <div className="sub">{r.recipe.profession}{r.recipe.skill ? <span className="sub-skill"> · {r.recipe.skill}</span> : ''}{makes}</div>
      </div>
      <div className="num c-skill">{r.recipe.skill || <span className="blank">—</span>}</div>
      <div>
        <ExitBadge name={r.bestExitName} />
        {r.unpricedExits.length > 0 && (
          <span className="unpriced" title={`${r.unpricedExits.join(', ')} unpriced: this exit applies but has no price yet`}>
            {r.unpricedExits.join(', ')} ?
          </span>
        )}
      </div>
      <div className="num"><Gold v={r.profitBest} signed /></div>
      <div className="num c-cost"><Gold v={r.cheapest} /></div>
      <div className="num c-ret"><Gold v={r.bestValue} /></div>
      <div className="chev" aria-hidden>›</div>
    </div>
  )
})

export function RecipeList({ rows, result, game, onUseChains }: {
  rows: RecipeRow[]
  result: ModelResult
  game: GameData
  onUseChains: (recipeId: number, on: boolean) => void
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'profit', dir: -1 })
  const [open, setOpen] = useState<Set<number>>(() => new Set())

  const sorted = useMemo(() => {
    const get = sortValue[sort.key]
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1 // blanks last either way
      return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir
    })
  }, [rows, sort])

  const toggle = useMemo(() => (id: number) => setOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'best' || key === 'skill' ? 1 : -1 }))

  return (
    <div className="rlist">
      <div className="rhead" role="row">
        {COLUMNS.map((c) => (
          <div key={c.key} className={[c.num && 'num', c.cls].filter(Boolean).join(' ')}>
            <button onClick={() => onSort(c.key)} title={c.title}>
              {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
            </button>
          </div>
        ))}
        <div />
      </div>
      {sorted.length === 0 && <div className="rempty">No recipes match these filters.</div>}
      {sorted.map((r) => (
        <div key={r.recipe.id}>
          <Row r={r} open={open.has(r.recipe.id)} onToggle={toggle} />
          {open.has(r.recipe.id) && <RecipeCard row={r} result={result} game={game} onUseChains={onUseChains} />}
        </div>
      ))}
    </div>
  )
}
