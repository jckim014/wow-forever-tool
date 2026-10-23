import { memo, useCallback, useMemo, useState } from 'react'
import { formatMoney, formatQty, sourceLabel } from '../format'
import type { Edits, GameData, IntermediateRow, Money, ModelResult } from '../model'
import { interViewRows, setAllowCrafting, type InterViewRow } from './inter'

type SourceFilter = 'all' | 'Craft' | 'Buy' | 'none'
type SortKey = 'name' | 'maker' | 'level' | 'allow' | 'buy' | 'craft' | 'best' | 'used'
const COLUMNS: { key: SortKey; label: string; num?: boolean; cls?: string; title?: string }[] = [
  { key: 'name', label: 'Item' },
  { key: 'maker', label: 'Made by', cls: 'c-maker', title: 'The recipe the app uses to craft it (cooldown crafts only when nothing else makes it)' },
  { key: 'level', label: 'Level', num: true, title: 'Crafting steps deep: 1 = made from raw materials, 2 = one ingredient is itself crafted, and so on' },
  { key: 'allow', label: 'Allow crafting', title: 'Off: the item is always bought. Cooldown crafts (Transmutes, Mooncloth) start off.' },
  { key: 'buy', label: 'Buy', num: true, title: 'Its price as a reagent: custom, else vendor buy, else imported' },
  { key: 'craft', label: 'Craft', num: true, title: 'Cost to craft one, with each ingredient at its own best cost' },
  { key: 'best', label: 'Best', num: true, title: 'The cheaper of buying and crafting (ties: buy)' },
  { key: 'used', label: 'Used in', num: true, cls: 'c-used', title: 'Recipes that use it as a reagent' },
]
const sortValue: Record<SortKey, (r: InterViewRow) => string | number | null> = {
  name: (r) => r.row.name,
  maker: (r) => `${r.row.profession} ${r.row.recipe.name}`,
  level: (r) => r.row.depth,
  allow: (r) => (r.row.allowCrafting ? 1 : 0),
  buy: (r) => r.row.buy,
  craft: (r) => r.row.craft,
  best: (r) => r.row.best,
  used: (r) => r.usedIn,
}
const col = (v: Money) => (v === null ? <span className="blank">—</span> : formatMoney(v, true))

interface Props {
  game: GameData
  result: ModelResult
  update: (fn: (cur: Edits) => Edits) => void
}

export function IntermediatesView({ game, result, update }: Props) {
  const [search, setSearch] = useState('')
  const [profs, setProfs] = useState<Set<string>>(() => new Set())
  const [source, setSource] = useState<SourceFilter>('all')
  const [offOnly, setOffOnly] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [open, setOpen] = useState<Set<number>>(() => new Set())

  const all = useMemo(() => interViewRows(game, result), [game, result])
  const professions = useMemo(() => game.professions.filter((p) => all.some((r) => r.row.profession === p)), [game, all])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const shown = all.filter((r) =>
      (!profs.size || profs.has(r.row.profession)) &&
      (source === 'all' || (source === 'none' ? r.row.source === null : r.row.source === source)) &&
      (!offOnly || !r.row.allowCrafting) &&
      (!q || `${r.row.name} ${r.row.recipe.name}`.toLowerCase().includes(q)))
    const get = sortValue[sort.key]
    return shown.sort((a, b) => {
      const x = get(a), y = get(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1 // blanks last either way
      return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir
    })
  }, [all, search, profs, source, offOnly, sort])

  const onAllow = useCallback((row: IntermediateRow, on: boolean) => update((cur) => setAllowCrafting(cur, row, on)), [update])
  const toggle = useCallback((id: number) => setOpen((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }), [])
  const toggleProf = (p: string) => {
    const next = new Set(profs)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    setProfs(next)
  }
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' || key === 'maker' ? 1 : -1 }))
  const count = (s: SourceFilter) => all.filter((r) => (s === 'none' ? r.row.source === null : r.row.source === s)).length

  return (
    <div className="pview">
      <div className="pfilters">
        <input className="search" type="search" placeholder="Search items or recipes…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className={profs.size === 0 ? 'chip on' : 'chip'} onClick={() => setProfs(new Set())}>All professions</button>
        {professions.map((p) => (
          <button key={p} className={profs.has(p) ? 'chip on' : 'chip'} onClick={() => toggleProf(p)}>{p}</button>
        ))}
      </div>
      <div className="pfilters">
        <div className="seg" role="group" aria-label="Best source">
          <button className={source === 'all' ? 'on' : ''} onClick={() => setSource('all')}>All</button>
          <button className={source === 'Craft' ? 'on' : ''} onClick={() => setSource('Craft')}>Craft ({count('Craft')})</button>
          <button className={source === 'Buy' ? 'on' : ''} onClick={() => setSource('Buy')}>Buy ({count('Buy')})</button>
          <button className={source === 'none' ? 'on' : ''} onClick={() => setSource('none')}>Unpriced ({count('none')})</button>
        </div>
        <label className="field"><input type="checkbox" checked={offOnly} onChange={(e) => setOffOnly(e.target.checked)} /> Crafting off</label>
        <span className="count">{rows.length.toLocaleString()} of {all.length.toLocaleString()} intermediates</span>
      </div>
      <div className="plist">
        <div className="phead ihead" role="row">
          {COLUMNS.map((c) => (
            <div key={c.key} className={[c.num && 'num', c.cls].filter(Boolean).join(' ')}>
              <button onClick={() => onSort(c.key)} title={c.title}>
                {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
              </button>
            </div>
          ))}
          <div />
        </div>
        {rows.length === 0 && <div className="rempty">No intermediates match these filters.</div>}
        {rows.map((r) => (
          <div key={r.row.item}>
            <Row r={r} open={open.has(r.row.item)} onToggle={toggle} onAllow={onAllow} />
            {open.has(r.row.item) && <Detail r={r} game={game} />}
          </div>
        ))}
      </div>
    </div>
  )
}

const Row = memo(function Row({ r, open, onToggle, onAllow }: {
  r: InterViewRow
  open: boolean
  onToggle: (id: number) => void
  onAllow: (row: IntermediateRow, on: boolean) => void
}) {
  const row = r.row
  const cooldown = !row.allowDefault
  return (
    <div className={`prow irow${open ? ' open' : ''}`} onClick={(e) => !(e.target as HTMLElement).closest('label, button') && onToggle(row.item)}>
      <div className="pname">{row.name}</div>
      <div className="c-maker imaker">
        {row.profession} · {row.recipe.name}
        {row.qtyMade !== 1 && <span className="muted"> (makes {formatQty(row.qtyMade)})</span>}
        {cooldown && <span className="tag">cooldown</span>}
      </div>
      <div className="num">{row.depth}</div>
      <div className="iallow">
        <label className={row.professionOn ? 'switch' : 'switch off'}
          title={row.professionOn ? undefined : `${row.profession} crafting is off in Settings > Crafting chains`}>
          <input type="checkbox" checked={row.allowCrafting} disabled={!row.professionOn} onChange={(e) => onAllow(row, e.target.checked)} />
          {row.allowCrafting ? 'On' : 'Off'}
        </label>
        {!row.professionOn && <span className="dflt">{row.profession} off in Settings</span>}
        {row.professionOn && r.edited && (
          <span className="dflt">default: {row.allowDefault ? 'on' : 'off'} · <button className="link" onClick={() => onAllow(row, row.allowDefault)}>reset</button></span>
        )}
      </div>
      <div className={`num${row.source === 'Buy' ? ' win' : ''}`}>{col(row.buy)}</div>
      <div className={`num${row.source === 'Craft' ? ' win' : ''}`}>
        {row.craft === null && r.potential !== null
          ? <span className="would" title="Crafting is off, so this cost is not used">{formatMoney(r.potential, true)}</span>
          : col(row.craft)}
      </div>
      <div className="num">
        {row.source === null ? <span className="miss">unpriced</span> : <span className={`vs-chip win`}>{row.source === 'Craft' ? '✓ Craft' : '✓ Buy'}</span>}
      </div>
      <div className="num c-used">{r.usedIn}</div>
      <div className="chev" aria-hidden>›</div>
    </div>
  )
})

function Detail({ r, game }: { r: InterViewRow; game: GameData }) {
  const row = r.row
  const name = (id: number) => game.items[String(id)]?.name ?? `Item ${id}`
  const priced = r.ingredients.every((g) => g.unit !== null)
  return (
    <div className="icard">
      <div className="icard-main">
        <h3>Ingredients <span>per craft{row.qtyMade !== 1 ? `, makes ${formatQty(row.qtyMade)}` : ''}</span></h3>
        <table className="cost">
          <tbody>
            {r.ingredients.map((g) => (
              <tr key={g.item}>
                <td><div className="lead">{formatQty(g.qty)}× {g.name}{g.loopBreak && <span className="tag">loop: bought</span>}</div></td>
                <td className="num">
                  {g.unit === null ? <span className="src miss">unpriced</span> : <><span className={`src${g.source === 'craft' ? ' craft' : ''}`}>{sourceLabel(g.source)}</span> {formatMoney(g.unit, true)}</>}
                </td>
                <td className="num">{g.unit === null ? '' : formatMoney(g.unit * g.qty, true)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="total">
              <td>Craft cost{row.qtyMade !== 1 ? ` (÷ ${formatQty(row.qtyMade)} = each)` : ' (each)'}</td><td />
              <td className="num">{r.potential === null ? '—' : formatMoney(r.potential, true)}</td>
            </tr>
          </tfoot>
        </table>
        {!row.allowCrafting && <p className="hint">Crafting is off for this item, so the craft cost is not used.</p>}
        {row.allowCrafting && !row.professionOn && <p className="hint">{row.profession} crafting is off in Settings, so the craft cost is not used.</p>}
        {row.allowCrafting && row.professionOn && !priced && <p className="hint">The craft cost stays blank until every ingredient has a price.</p>}
      </div>
      <div className="icard-side">
        {row.loopBreaks.length > 0 && (
          <p className="hint">Crafting loop: {row.loopBreaks.map((j) => name(row.recipe.reagents[j].item)).join(', ')} leads back to this item, so it is priced at its buy price here.</p>
        )}
        {!row.allowDefault && <p className="hint">A cooldown craft, so crafting starts off. Turn it on if you have the cooldown spare.</p>}
        {row.alsoMadeBy.length > 0 && (
          <p className="hint">Also made by: {row.alsoMadeBy.map((x) => `${x.profession} · ${x.name}`).join('; ')}. The app uses {row.recipe.name}.</p>
        )}
      </div>
    </div>
  )
}
