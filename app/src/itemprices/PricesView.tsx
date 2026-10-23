import { memo, useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { formatMoney, sourceLabel } from '../format'
import type { DeBand, Edits, GameData, Money, ModelResult } from '../model'
import { hasUsage, itemPriceRows, joinMoney, setCustomPrice, setVendorBuy, splitMoney, type ItemPriceRow, type UsageKey } from './items'

const USAGE_CHIPS: { key: UsageKey; label: string }[] = [
  { key: 'reagent', label: 'Reagents' },
  { key: 'deMaterial', label: 'DE materials' },
  { key: 'product', label: 'Products' },
  { key: 'craftable', label: 'Craftable' },
]

type SortKey = 'name' | 'used' | 'custom' | 'vendor' | 'imported' | 'price'
const COLUMNS: { key: SortKey; label: string; num?: boolean; cls?: string; title?: string }[] = [
  { key: 'name', label: 'Item' },
  { key: 'used', label: 'Used as', cls: 'c-used', title: 'Reagent (and in how many recipes), product, disenchanting material, craftable reagent' },
  { key: 'custom', label: 'Custom', title: 'Your own price: overrides every other source for this item' },
  { key: 'vendor', label: 'Vendor buy', title: "What a vendor sells it for (Wowhead's price unless you've corrected it). Used for reagent cost only." },
  { key: 'imported', label: 'Imported', num: true, cls: 'c-imp', title: 'From your last price import, in the column chosen in Settings' },
  { key: 'price', label: 'Price used', num: true,
    title: 'For a reagent, what it costs: custom, else vendor buy, else imported. For an item only sold, its sale price: custom, else imported (never a vendor price). A second line shows the sale price when it differs.' },
]
const sortValue: Record<SortKey, (r: ItemPriceRow) => string | number | null> = {
  name: (r) => r.name,
  used: (r) => r.usage.reagentIn || null,
  custom: (r) => r.price.typed,
  vendor: (r) => r.price.vendorBuy,
  imported: (r) => r.price.imported,
  price: (r) => (r.usage.reagentIn ? r.price.reagent : r.price.selling),
}

interface Props {
  game: GameData
  deTable: DeBand[]
  edits: Edits
  result: ModelResult
  update: (fn: (cur: Edits) => Edits) => void
}

export function PricesView({ game, deTable, edits, result, update }: Props) {
  const [search, setSearch] = useState('')
  const [uses, setUses] = useState<Set<UsageKey>>(() => new Set())
  const [only, setOnly] = useState({ custom: false, edited: false, unpriced: false, differs: false })
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })

  const all = useMemo(() => itemPriceRows(game, deTable, edits, result.prices), [game, deTable, edits, result])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const shown = all.filter((r) =>
      (!uses.size || [...uses].some((k) => hasUsage(r.usage, k))) &&
      (!only.custom || r.price.typed !== null) &&
      (!only.edited || r.override !== undefined) &&
      (!only.unpriced || r.unpriced) &&
      (!only.differs || r.differs) &&
      (!q || r.name.toLowerCase().includes(q)))
    const get = sortValue[sort.key]
    return shown.sort((a, b) => {
      const x = get(a), y = get(b)
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1 // blanks last either way
      return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sort.dir
    })
  }, [all, search, uses, only, sort])

  const onCustom = useCallback((id: number, v: Money) => update((cur) => setCustomPrice(cur, id, v)), [update])
  const onVendor = useCallback((id: number, v: 'wowhead' | Money) => update((cur) => setVendorBuy(cur, id, v)), [update])

  const toggleUse = (k: UsageKey) => {
    const next = new Set(uses)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setUses(next)
  }
  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }))

  return (
    <div className="pview">
      <div className="pfilters">
        <input className="search" type="search" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className={uses.size === 0 ? 'chip on' : 'chip'} onClick={() => setUses(new Set())}>All items</button>
        {USAGE_CHIPS.map((c) => (
          <button key={c.key} className={uses.has(c.key) ? 'chip on' : 'chip'} onClick={() => toggleUse(c.key)}>{c.label}</button>
        ))}
        <label className="field"><input type="checkbox" checked={only.custom} onChange={(e) => setOnly({ ...only, custom: e.target.checked })} /> Custom prices</label>
        <label className="field"><input type="checkbox" checked={only.edited} onChange={(e) => setOnly({ ...only, edited: e.target.checked })} /> Vendor buy edited</label>
        <label className="field"><input type="checkbox" checked={only.unpriced} onChange={(e) => setOnly({ ...only, unpriced: e.target.checked })} /> Unpriced</label>
        <label className="field" title="Items a vendor sells for a different price than they sell for on the AH (possible vendor flips)">
          <input type="checkbox" checked={only.differs} onChange={(e) => setOnly({ ...only, differs: e.target.checked })} /> Vendor ≠ AH
        </label>
        <span className="count">{rows.length.toLocaleString()} of {all.length.toLocaleString()} items</span>
      </div>
      <div className="plist">
        <div className="phead" role="row">
          {COLUMNS.map((c) => (
            <div key={c.key} className={[c.num && 'num', c.cls].filter(Boolean).join(' ')}>
              <button onClick={() => onSort(c.key)} title={c.title}>
                {c.label}{sort.key === c.key ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
              </button>
            </div>
          ))}
        </div>
        {rows.length === 0 && <div className="rempty">No items match these filters.</div>}
        {rows.map((r) => <Row key={r.id} r={r} onCustom={onCustom} onVendor={onVendor} />)}
      </div>
    </div>
  )
}

const Row = memo(function Row({ r, onCustom, onVendor }: {
  r: ItemPriceRow
  onCustom: (id: number, v: Money) => void
  onVendor: (id: number, v: 'wowhead' | Money) => void
}) {
  const u = r.usage
  return (
    <div className={`prow${r.unpriced ? ' is-unpriced' : ''}`}>
      <div className="pname">
        <span className={r.quality !== null && r.quality >= 2 ? `qual-${r.quality}` : undefined}>{r.name}</span>
      </div>
      <div className="c-used">
        {u.reagentIn > 0 && <span className="tag">reagent · {u.reagentIn}</span>}
        {u.craftable && <span className="tag">craftable</span>}
        {u.deMaterial && <span className="tag">DE material</span>}
        {u.product && !u.craftable && <span className="tag">product</span>}
      </div>
      <div>
        <MoneyBoxes value={r.price.typed} onCommit={(v) => onCustom(r.id, v)} label={`Custom price for ${r.name}`} />
        {r.price.typed !== null && <button className="clear" title="Clear the custom price" onClick={() => onCustom(r.id, null)}>✕</button>}
      </div>
      <div>{u.reagentIn > 0 ? <VendorBuy r={r} onVendor={onVendor} /> : <span className="blank">—</span>}</div>
      <div className="num c-imp">{r.price.imported === null ? <span className="blank">—</span> : formatMoney(r.price.imported, true)}</div>
      <div className="num">
        {u.reagentIn > 0
          ? <Used v={r.price.reagent} src={r.price.reagentSource} />
          : <Used v={r.price.selling} src={sellSource(r)} />}
        {r.differs && (
          <div className="sells">{r.price.selling === null ? 'no AH price to sell at' : <>sells for {formatMoney(r.price.selling, true)}</>}</div>
        )}
      </div>
    </div>
  )
})

const sellSource = (r: ItemPriceRow) => (r.price.selling === null ? null : r.price.typed !== null ? 'Typed' : 'Imported')

function Used({ v, src }: { v: Money; src: string | null }) {
  if (v === null) return <span className="miss">unpriced</span>
  return <>{formatMoney(v, true)} <span className="src">{sourceLabel(src)}</span></>
}

/** Wowhead's vendor price, or the user's correction: no vendor sells it, or another price. */
function VendorBuy({ r, onVendor }: { r: ItemPriceRow; onVendor: (id: number, v: 'wowhead' | Money) => void }) {
  const [other, setOther] = useState(false)
  const mode = typeof r.override === 'number' || other ? 'other' : r.override === null ? 'none' : 'wowhead'
  const choose = (m: string) => {
    setOther(m === 'other')
    if (m === 'wowhead') onVendor(r.id, 'wowhead')
    else if (m === 'none') onVendor(r.id, null)
    // 'other' waits for a price to be typed
  }
  return (
    <div className={`vbuy${r.override !== undefined ? ' edited' : ''}`}>
      <select value={mode} onChange={(e) => choose(e.target.value)} aria-label={`Vendor buy price for ${r.name}`}
        title={r.override !== undefined ? 'You have corrected this vendor price' : undefined}>
        <option value="wowhead">{r.wowheadBuy === null ? 'None listed' : `Wowhead ${formatMoney(r.wowheadBuy)}`}</option>
        {r.wowheadBuy !== null && <option value="none">No vendor sells it</option>}
        <option value="other">Other price…</option>
      </select>
      {mode === 'other' && (
        <MoneyBoxes value={typeof r.override === 'number' ? r.override : null} label={`Vendor buy price for ${r.name}`}
          onCommit={(v) => onVendor(r.id, v === null ? 'wowhead' : v)} />
      )}
    </div>
  )
}

type Draft = { g: string; s: string; c: string }
const toDraft = (v: Money): Draft => {
  if (v === null) return { g: '', s: '', c: '' }
  const { g, s, c } = splitMoney(v)
  return { g: g ? String(g) : '', s: g || s ? String(s) : '', c: String(c) }
}
/** Empty boxes count as 0; all three empty = no price. Silver and copper must be 0-99. */
function parseDraft(d: Draft): { ok: boolean; v: Money } {
  if (!d.g.trim() && !d.s.trim() && !d.c.trim()) return { ok: true, v: null }
  const n = (t: string, max?: number) => {
    if (!t.trim()) return 0
    if (!/^\d+$/.test(t.trim())) return NaN
    const x = Number(t)
    return max !== undefined && x > max ? NaN : x
  }
  const g = n(d.g), s = n(d.s, 99), c = n(d.c, 99)
  return Number.isNaN(g + s + c) ? { ok: false, v: null } : { ok: true, v: joinMoney(g, s, c) }
}

/** Three small boxes for gold, silver and copper. Commits each valid value as it is typed. */
function MoneyBoxes({ value, onCommit, label }: { value: Money; onCommit: (v: Money) => void; label: string }) {
  const [d, setD] = useState<Draft>(() => toDraft(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setD(toDraft(value))
  }, [value])
  const { ok } = parseDraft(d)
  const change = (k: keyof Draft, t: string) => {
    const next = { ...d, [k]: t }
    setD(next)
    const p = parseDraft(next)
    if (p.ok && p.v !== value) onCommit(p.v)
  }
  const box = (k: keyof Draft, unit: string) => (
    <label className={`mbox u-${unit}`}>
      <input
        inputMode="numeric" placeholder=" " value={d[k]} aria-label={`${label}: ${unit === 'g' ? 'gold' : unit === 's' ? 'silver' : 'copper'}`}
        onChange={(e) => change(k, e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {unit}
    </label>
  )
  return (
    <span
      className={ok ? 'mboxes' : 'mboxes bad'} title={ok ? undefined : 'Whole numbers only; silver and copper 0-99'}
      onFocus={() => { focused.current = true }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        focused.current = false
        setD(toDraft(value))
      }}
    >
      {box('g', 'g')}{box('s', 's')}{box('c', 'c')}
    </span>
  )
}
