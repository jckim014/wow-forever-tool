import { useMemo } from 'react'
import { formatMoney, formatQty, QUALITY_NAMES, sourceLabel } from '../format'
import { recipeDetail, type ExitDetail, type GameData, type ModelResult, type Money, type RecipeRow } from '../model'
import type { LineSource } from '../model/detail'

const exact = (v: Money) => (v === null ? '—' : formatMoney(v))
/** For right-aligned money columns: padded so silver and copper line up. */
const col = (v: Money) => (v === null ? '—' : formatMoney(v, true))
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`
const EXIT_TITLE = { Vendor: 'Vendor', Disenchant: 'Disenchant', AH: 'Auction house' } as const

function Signed({ v }: { v: Money }) {
  if (v === null) return <span className="blank">—</span>
  return <span className={`profit ${v >= 0 ? 'pos' : 'neg'}`}>{v > 0 ? '+' : ''}{formatMoney(v, true)}</span>
}

function Source({ s, unit }: { s: LineSource; unit: Money }) {
  if (unit === null) return <span className="src miss">unpriced</span>
  return <span className={`src${s === 'Craft' ? ' craft' : ''}`}>{sourceLabel(s)}</span>
}

/** One plain-language line on how an exit's value is worked out. */
function How({ e, cut }: { e: ExitDetail; cut: number }) {
  const per = e.qtyMade !== 1 ? `${formatQty(e.qtyMade)} × ` : ''
  const less = cut ? `, less ${pct(cut)} AH cut` : ''
  if (e.vendor) return <>{per}sells to a vendor for {exact(e.vendor.unitSell)}</>
  if (e.ah) return e.ah.unit === null ? <>no AH price for this item yet</> : <>{per}{exact(e.ah.unit)} ({sourceLabel(e.ah.source)}){less}</>
  const d = e.disenchant!
  return (
    <>
      {d.band}{per && `, ${per.trim()} items`}{d.multiplier !== 1 && `, × ${formatQty(d.multiplier)} Salvager`}{less}
      <ul className="mats">
        {d.materials.map((m) => (
          <li key={m.name}>
            {m.name} <span className="muted">{pct(m.chance)} × {formatQty(m.avgQty)}</span>{' '}
            {m.price === null ? (m.chance * m.avgQty > 0 ? <span className="miss">unpriced</span> : null) : <>@ {exact(m.price)}</>}
          </li>
        ))}
      </ul>
    </>
  )
}

export function RecipeCard({ row, result, game }: { row: RecipeRow; result: ModelResult; game: GameData }) {
  const d = useMemo(() => recipeDetail(result, row, game), [result, row, game])
  const has = new Set(d.exits.map((e) => e.name))
  const missing: { name: string; why: string }[] = [
    ...(has.has('Vendor') ? [] : [{ name: 'Vendor', why: 'no vendor price' }]),
    ...(has.has('Disenchant') ? [] : [{ name: 'Disenchant', why: 'not disenchantable' }]),
  ]
  const showBuyAll = row.buyAll !== null && row.cheapest !== null && Math.round(row.buyAll) !== Math.round(row.cheapest)

  return (
    <div className="rcard">
      <section>
        <h3>Exits <span>value / profit per craft</span></h3>
        <table className="exits">
          <tbody>
            {d.exits.map((e) => (
              <ExitRows key={e.name} e={e} cut={d.ahCut} />
            ))}
            {missing.map((m) => (
              <tr key={m.name} className="na-row"><td>{m.name}</td><td colSpan={2} className="na">{m.why}</td></tr>
            ))}
          </tbody>
        </table>
        <dl className="meta">
          <dt>Makes</dt><dd>{formatQty(row.qtyMade)}× {row.productName}</dd>
          <dt>Item</dt>
          <dd>
            {row.quality !== null ? <span className={`qual-${row.quality}`}>{QUALITY_NAMES[row.quality] ?? row.quality}</span> : '—'}
            {row.ilvl ? ` · item level ${row.ilvl}` : ''}
          </dd>
          <dt>AH price</dt><dd>{row.ahPrice === null ? <span className="na">none</span> : <>{exact(row.ahPrice)} each ({sourceLabel(row.ahSource)})</>}</dd>
          <dt>Reagents sell to vendor for</dt><dd>{exact(row.reagentsVendorValue)}{row.reagentsWithoutSell ? ` (${row.reagentsWithoutSell} without a sell price)` : ''}</dd>
          <dt>Recipe ID</dt><dd>{row.recipe.id}</dd>
        </dl>
      </section>
      <section>
        <h3>Cost <b>{col(row.cheapest)}</b></h3>
        <table className="cost">
          <tbody>
            {d.lines.map((l) => (
              <CostRows key={l.item} l={l} />
            ))}
          </tbody>
          <tfoot>
            <tr className="total"><td>Cheapest path</td><td /><td className="num">{col(row.cheapest)}</td></tr>
            {showBuyAll && <tr><td>Buying everything</td><td /><td className="num">{col(row.buyAll)}</td></tr>}
            {!row.useChains && <tr><td colSpan={3}>Use chains is off for this recipe: every reagent is bought.</td></tr>}
          </tfoot>
        </table>
        {d.unpricedReagents.length > 0 && (
          <p className="note">Unpriced: {d.unpricedReagents.join(', ')}. Cost and profit stay blank until these have a price.</p>
        )}
      </section>
    </div>
  )
}

function ExitRows({ e, cut }: { e: ExitDetail; cut: number }) {
  return (
    <>
      <tr className={e.isBest ? 'best' : undefined}>
        <td>{EXIT_TITLE[e.name]}</td>
        {e.value === null
          ? <td colSpan={2} className="na">unpriced</td>
          : <><td className="num">{col(e.value)}</td><td className="num"><Signed v={e.profit} /></td></>}
      </tr>
      <tr className="how-row"><td colSpan={3}><div className="how"><How e={e} cut={cut} /></div></td></tr>
    </>
  )
}

function CostRows({ l }: { l: ReturnType<typeof recipeDetail>['lines'][number] }) {
  return (
    <>
      <tr>
        <td><div className="lead">{formatQty(l.qty)}× {l.name}</div></td>
        <td className="num"><Source s={l.source} unit={l.unit} /> {l.unit === null ? '' : col(l.unit)}</td>
        <td className="num">{l.total === null ? '' : col(l.total)}</td>
      </tr>
      {l.craft && (
        <tr className="subr">
          <td colSpan={3}>
            {/* how a crafted reagent's cost was reached; explanation only, so no amounts in the price columns */}
            {l.craft.lines.map((s) => (
              <div key={s.item}>
                {formatQty(s.qty)}× {s.name}{' '}
                {s.unit === null
                  ? <span className="miss">unpriced</span>
                  : <>at {exact(s.unit)} ({sourceLabel(s.source)}) = {exact(s.total)}</>}
              </div>
            ))}
            {/* crafting vs buying, both as totals for the quantity this recipe needs */}
            <div className="vs">
              <span className="vs-chip win">✓ Craft {exact(l.total)}</span>
              <span className="vs-chip">{l.buyUnit === null ? 'Buy: no price' : <>Buy {exact(l.buyUnit * l.qty)}</>}</span>
              <span className="vs-tag" title={`${l.craft.profession}: ${l.craft.recipe}`}>
                {l.craft.profession}{l.craft.qtyMade !== 1 ? ` · makes ${formatQty(l.craft.qtyMade)}` : ''}
              </span>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
