import { Fragment, useEffect, useMemo, useState } from 'react'
import { config } from '../data'
import { sourceLabel } from '../format'
import type { SalesData } from '../apiprices/read'
import type { Edits, GameData, ModelResult, RecipeRow } from '../model'
import { NumberField } from '../NumberField'
import { auctionatorImport } from '../shopping/list'
import { minSkill, plan, routeItems, type LevelingData, type LvRecipe, type Plan, type Segment } from './plan'

const KEY = 'wow-forever-shuffle:leveling'
interface Inputs { profession: string; from: number; to: number; perCraftSilver: number }
const DEFAULTS: Inputs = { profession: 'Tailoring', from: 1, to: 300, perCraftSilver: 1 }

function loadInputs(): Inputs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return v && typeof v === 'object' ? { ...DEFAULTS, ...v } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

let cached: Promise<LevelingData> | null = null
const loadLevelingData = () =>
  (cached ??= fetch(`${import.meta.env.BASE_URL}leveling-data.json`).then((r) => {
    if (!r.ok) throw new Error(`Could not load leveling data (HTTP ${r.status}).`)
    return r.json() as Promise<LevelingData>
  }))

/** Money in coin colours: "1g 23s 04c" with each part coloured, blank stays blank. */
function Coins({ v, sign, short }: { v: number | null; sign?: boolean; /** drop copper once there is gold */ short?: boolean }) {
  if (v == null || !Number.isFinite(v)) return null
  const c = Math.round(Math.abs(v))
  const g = Math.floor(c / 10000), sv = Math.floor((c % 10000) / 100), cc = c % 100
  const p2 = (n: number) => String(n).padStart(2, '0')
  const parts: [string, string][] = c === 0 ? [['0c', 'lv-cc']]
    : g && short ? [[`${g.toLocaleString()}g`, 'lv-cg'], [`${p2(sv)}s`, 'lv-cs']]
    : g ? [[`${g.toLocaleString()}g`, 'lv-cg'], [`${p2(sv)}s`, 'lv-cs'], [`${p2(cc)}c`, 'lv-cc']]
      : sv ? [[`${sv}s`, 'lv-cs'], [`${p2(cc)}c`, 'lv-cc']] : [[`${cc}c`, 'lv-cc']]
  return <span className="lv-money">{v < 0 && c ? '−' : sign && c ? '+' : ''}{parts.map(([t, k], i) => <span key={i} className={k}>{i > 0 ? ' ' : ''}{t}</span>)}</span>
}
const m = (v: number | null) => <Coins v={v} />
const q = (n: number) => (Math.round(n * 10) / 10).toLocaleString()
const ACCESS: Record<string, string> = { trainer: 'Trainer', ah: 'AH', starter: 'Known', extra: 'Your list' }
/** Wowhead source codes, for the More recipes list */
const SOURCES: Record<number, string> = { 2: 'Drop', 4: 'Quest', 5: 'Vendor', 6: 'Trainer', 7: 'Discovery', 16: 'Fishing' }
const sourceText = (r: LvRecipe) => {
  const names = [...new Set(r.source.map((c) => SOURCES[c] ?? 'Other'))]
  const base = names.length ? names.join(', ') : 'Unknown'
  return r.recipeItems?.length ? `${base}; AH, no price now` : base
}
const QUEUE_TIP = 'How many crafts to queue for this stretch. Skill-ups on yellow and green recipes are luck: this number is enough 9 times in 10 '
  + '(and never below the average). If you run out before the end of the stretch, set From skill to where you are and the route re-plans; '
  + 'if you finish early, the spare reagents carry into the next stretch.'

const FACTION: Record<number, string> = { 111: 'Alliance', 114: 'Horde' }

/** The route on screen, with the prices it was planned at. Kept outside the component so it survives switching tabs
 *  (the view unmounts); a page reload plans afresh. */
interface Kept { p: Plan | null; result: ModelResult; inpKey: string; route: string; at: number }
let keptMemo: Kept | null = null
const SETTLE_MS = 20_000

export function LevelingView({ game, result: live, sales, edits, update }: {
  game: GameData; result: ModelResult; sales: SalesData | null; edits: Edits; update: (fn: (cur: Edits) => Edits) => void
}) {
  const [data, setData] = useState<LevelingData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inp, setInp] = useState<Inputs>(loadInputs)
  const [open, setOpen] = useState<Set<number>>(new Set())
  useEffect(() => {
    loadLevelingData().then(setData, (e: Error) => setError(e.message))
  }, [])
  const set = (patch: Partial<Inputs>) => {
    const next = { ...inp, ...patch }
    setInp(next)
    setOpen(new Set())
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* per-browser convenience only */ }
  }
  const item = (id: number) => game.items[id] ?? data?.items[id]
  const name = (id: number) => item(id)?.name ?? `Item ${id}`

  // The route at the current prices. It replaces the one on screen only when the inputs change, when it is the same
  // route (fresh numbers), or on Re-plan: new prices arriving mid-session (API data every 10 min, an import) must not
  // swap the route under Josh while he follows it (2026-11-16).
  const lvEdits = edits.leveling
  const bonusPts = lvEdits.overtime.on ? lvEdits.overtime.pts : 0
  const extraKey = [...lvEdits.recipes].sort((a, b) => a - b).join(',')
  const inpKey = `${inp.profession}|${inp.from}|${inp.to}|${inp.perCraftSilver}|${bonusPts}|${extraKey}`
  const fresh: Plan | null = useMemo(() => {
    if (!data || inp.to <= inp.from) return null
    return plan({
      profession: inp.profession, from: inp.from, to: inp.to, recipes: data.recipes, price: live.prices,
      intermediates: live.intermediates, item: (id) => game.items[id] ?? data.items[id],
      cooldownCrafts: config.cooldownCrafts, perCraft: Math.round(inp.perCraftSilver * 100),
      extra: new Set(extraKey ? extraKey.split(',').map(Number) : []), bonus: bonusPts / 100,
    })
  }, [data, live, game, inp, extraKey, bonusPts])
  const setLeveling = (fn: (l: Edits['leveling']) => Edits['leveling']) => {
    setOpen(new Set())
    update((cur) => ({ ...cur, leveling: fn(cur.leveling) }))
  }
  const tick = (id: number, on: boolean) =>
    setLeveling((l) => ({ ...l, recipes: on ? [...l.recipes.filter((x) => x !== id), id] : l.recipes.filter((x) => x !== id) }))
  const [kept, setKeptState] = useState<Kept | null>(() => keptMemo)
  const keep = () => {
    keptMemo = { p: fresh, result: live, inpKey, route: routeKey(fresh), at: Date.now() }
    setKeptState(keptMemo)
  }
  // Start-up loading (the save file, the first API read) lands within seconds of the first plan: it replaces the route
  // silently. After SETTLE_MS a different route waits for Re-plan.
  const settling = !kept || !kept.p || Date.now() - kept.at < SETTLE_MS
  const stale = !!kept && kept.inpKey === inpKey && !settling && kept.route !== routeKey(fresh)
  useEffect(() => {
    if (!kept || kept.inpKey !== inpKey || settling || (!stale && kept.p !== fresh)) keep()
  }, [fresh, inpKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const p = kept && kept.inpKey === inpKey ? kept.p : fresh
  const result = kept && kept.inpKey === inpKey ? kept.result : live
  const rowsById = useMemo(() => new Map(result.recipes.map((r) => [r.recipe.id, r])), [result])

  if (error) return <div className="message error">{error}</div>
  if (!data) return <div className="message">Loading leveling data…</div>

  const totalCrafts = p ? p.segments.reduce((t, s) => t + s.crafts.mean + s.makerCrafts.reduce((u, x) => u + x.mean, 0), 0) : 0
  const bought = p ? p.learn.filter((l) => l.access !== 'starter') : []

  return (
    <div className="lv">
      <div className="sgroup lv-wide">
        <div className="srow lv-inputs">
          <label>Profession{' '}
            <select value={inp.profession} onChange={(e) => set({ profession: e.target.value })}>
              {game.professions.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          <label>From skill <NumberField value={inp.from} min={1} max={449} integer onCommit={(n) => set({ from: n })} /></label>
          <label>to <NumberField value={inp.to} min={2} max={450} integer onCommit={(n) => set({ to: n })} /></label>
          <label title="Counted only when choosing between recipes, so a cheap recipe with a low skill-up chance doesn't win by sheer number of crafts. Never added to the gold totals.">
            Your time per craft <NumberField value={inp.perCraftSilver} min={0} max={1000} onCommit={(n) => set({ perCraftSilver: n })} /> silver</label>
          <span className="lv-ot" title="Legacy talent: a better chance of a skill-up. Added to a green recipe's chance (orange and yellow are already 100%, grey stays 0%). 12 points is a tentative figure from testing; the talent's text says 20%.">
            <label><input type="checkbox" checked={lvEdits.overtime.on} onChange={(e) => setLeveling((l) => ({ ...l, overtime: { ...l.overtime, on: e.target.checked } }))} />
              {' '}Working Overtime ⓘ</label>
            {' '}+<NumberField value={lvEdits.overtime.pts} min={0} max={100} onCommit={(n) => setLeveling((l) => ({ ...l, overtime: { ...l.overtime, pts: n } }))} /> points on green</span>
        </div>
        {inp.to <= inp.from && <p className="hint">The target skill must be above the starting skill.</p>}
        {stale && kept && (
          <div className="lv-stale">
            <span>Prices have updated since this route was planned ({new Date(kept.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}),
              and the route would change. It stays as it is until you re-plan; its figures are the prices it was planned with.</span>
            <button className="button primary" onClick={() => { keep(); setOpen(new Set()) }}>Re-plan</button>
          </div>
        )}
        {p && (
          <div className="lv-sum">
            <div><span className="muted">Expected cost</span><b>{m(p.totalMean)}</b></div>
            <div className="lv-tip" title="Skill-ups are luck: the whole route costs this or less 9 times in 10."><span className="muted">Bad luck ⓘ</span><b>{m(p.totalSafe)}</b></div>
            <div><span className="muted">of which recipes and training</span><b>{m(p.learnCost)}</b></div>
            <div><span className="muted">Crafts, expected</span><b>{Math.round(totalCrafts).toLocaleString()}</b></div>
          </div>
        )}
        {p && p.gaps.length > 0 && (
          <p className="hint lv-warn">No usable recipe raises skill {p.gaps[0]}{p.gaps.length > 1 ? ` (nor ${p.gaps.length - 1} more levels up to ${p.gaps[p.gaps.length - 1]})` : ''}: the route stops there.
            A recipe from a drop, quest or vendor that hasn't been seen on the AH would be needed.</p>
        )}
        <p className="hint">Cost = reagents at the app's prices, minus what the crafted items sell to a vendor for, plus recipes and training.
          Skill-up chance: 100% while orange, then (grey − skill) / (grey − yellow){bonusPts ? <>, plus {bonusPts} points on green (Working Overtime)</> : null}.
          Uses starter, trainer and AH recipes (recipe items with a current price) and the ones you tick under More recipes (free);
          leaves out specialisation recipes and cooldowns.</p>
      </div>

      {p && bought.length > 0 && (
        <div className="sgroup lv-wide">
          <h2>Recipes to learn</h2>
          <table className="lv-table">
            <thead><tr><th>At skill</th><th>Recipe</th><th>From</th><th className="num">Cost</th><th className="num" title="How much more the route would cost without this recipe">Saves</th></tr></thead>
            <tbody>
              {bought.map((l) => (
                <tr key={l.recipe.id}>
                  <td className="num lv-skill">{l.firstUsed}</td>
                  <td>{l.recipe.name}</td>
                  <td>{l.access === 'ah' ? <>AH <span className="muted">{l.recipeItem?.name}</span></> : ACCESS[l.access]}</td>
                  <td className="num">{l.access === 'extra' ? '' : m(l.cost)}</td>
                  <td className="num">{l.saving == null ? '' : m(l.saving)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p && <MoreRecipes p={p} ticked={lvEdits.recipes} recipes={data.recipes} profession={inp.profession} from={inp.from} to={inp.to}
        learnUsed={new Set(p.learn.map((l) => l.recipe.id))} onTick={tick} />}

      {p && p.segments.length > 0 && (
        <div className="sgroup lv-wide">
          <h2>Route</h2>
          <table className="lv-table lv-route">
            <thead>
              <tr className="lv-group">
                <th colSpan={5} />
                <th colSpan={4} className="lv-x lv-x1">If you sell what one craft makes</th>
              </tr>
              <tr>
                <th>Skill</th><th>Recipe</th>
                <th className="num lv-tip" title={QUEUE_TIP}>Craft ⓘ</th>
                <th className="num" title="Expected gold for this stretch: reagents minus vendor value of what you make">Gold</th>
                <th className="num" title="What one craft costs: its reagents (and the ingredients of the reagents you craft)">Cost each</th>
                <th className="num lv-tip lv-x lv-x1" title={EXIT_TIP + ' Vendor is the one counted in Gold.'}>Vendor ⓘ</th>
                <th className="num lv-tip lv-x" title={EXIT_TIP + ' AH: sold on the AH after the cut.'}>AH ⓘ</th>
                <th className="num lv-tip lv-x" title={EXIT_TIP + ' Disenchant: materials sold on the AH after the cut.'}>Disenchant ⓘ</th>
                <th className="num lv-tip lv-x" title={salesTip(sales, result.settings.apiHouse)}>Sold / day ⓘ</th>
              </tr>
            </thead>
            <tbody>
              {p.segments.map((s, i) => {
                const row = rowsById.get(s.action.recipe.id)
                const isOpen = open.has(i)
                return (
                  <Fragment key={i}>
                    <tr className={isOpen ? 'lv-seg on' : 'lv-seg'} onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n })}>
                      <td className="lv-skill">{s.from}–{s.to}</td>
                      <td>
                        <span className="lv-caret">{isOpen ? '▾' : '▸'}</span> {s.action.recipe.name}
                        {s.action.crafted.length > 0 && <span className="muted"> + craft {s.action.crafted.map((c) => name(c.item)).join(', ')}</span>}
                      </td>
                      <td className="num" title={`Expected ${q(s.crafts.mean)} crafts on average; ${s.crafts.safe} is enough 9 times in 10.`}>{s.crafts.safe}</td>
                      <td className="num"><Coins v={s.costMean} short /></td>
                      <td className="num"><Coins v={s.action.cost} short /></td>
                      <ExitCells s={s} row={row} />
                      <td className="num lv-x">{soldCell(s, sales, result.settings.apiHouse)}</td>
                    </tr>
                    {isOpen && <tr className="lv-detail"><td /><td colSpan={8}><SegmentDetail s={s} name={name} result={result} /></td></tr>}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
          <p className="hint">Click a stretch for its shopping list. Craft = crafts to queue for that stretch (hover a number for the average).
            Vendor, AH and Disenchant: what one craft brings back if you sell what you make that way; the best of the three is green.
            Only Vendor is counted in Gold (the AH can't absorb dozens of the same item at today's price): compare Craft with Sold / day.</p>
        </div>
      )}

      {p && p.segments.length > 0 && <RouteShopping p={p} inp={inp} name={name} result={result} />}
    </div>
  )
}

/** Recipes outside the trainer and the AH: tick the ones you have or can get (free in the planner). Unticked ones show
 *  what they would save; the ones that wouldn't change the route are behind a toggle. */
function MoreRecipes({ p, ticked, recipes, profession, from, to, learnUsed, onTick }: {
  p: Plan; ticked: number[]; recipes: LvRecipe[]; profession: string; from: number; to: number; learnUsed: Set<number>
  onTick: (id: number, on: boolean) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const tickedSet = new Set(ticked)
  const mine = recipes.filter((r) => r.profession === profession && tickedSet.has(r.id))
    .sort((a, b) => minSkill(a) - minSkill(b) || a.name.localeCompare(b.name))
  const useful = p.candidates.filter((c) => c.fills > 0 || c.saving != null)
  const rest = p.candidates.filter((c) => !(c.fills > 0 || c.saving != null))
  const rows = showAll ? [...useful, ...rest] : useful
  const skill = (r: LvRecipe) => `${minSkill(r)} · ${r.colors[1] || r.colors[0]}–${r.colors[3]}`
  return (
    <div className="sgroup lv-wide">
      <h2>More recipes</h2>
      <p className="hint">Recipes the planner can't buy from a trainer or on the AH: BoP vendor recipes (e.g. Merchant's Favor), reputation, drops, quests.
        Tick the ones you have or will get; they count as free. Saves = how much cheaper the route {from}–{to} gets with that one recipe, the rest as planned.</p>
      {mine.length + rows.length > 0 ? (
        <table className="lv-table lv-more">
          <thead><tr><th /><th>Recipe</th><th title="Learned at · yellow–grey">Skill</th><th>Source</th>
            <th className="num" title="Unticked: how much cheaper the route would be with this recipe. Ticked: whether the route uses it.">Saves</th></tr></thead>
          <tbody>
            {mine.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked onChange={() => onTick(r.id, false)} /></td>
                <td>{r.name}</td>
                <td className="lv-skill">{skill(r)}</td>
                <td className="muted">{sourceText(r)}</td>
                <td className="num">{learnUsed.has(r.id) ? 'in the route' : <span className="muted">not used</span>}</td>
              </tr>
            ))}
            {rows.map((c) => (
              <tr key={c.recipe.id}>
                <td><input type="checkbox" checked={false} onChange={() => onTick(c.recipe.id, true)} /></td>
                <td>{c.recipe.name}</td>
                <td className="lv-skill">{skill(c.recipe)}</td>
                <td className="muted">{sourceText(c.recipe)}</td>
                <td className="num">{c.fills > 0 ? <span className="lv-warn">reaches {c.fills} more level{c.fills > 1 ? 's' : ''}</span>
                  : c.saving != null ? m(c.saving) : <span className="muted">no change</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="hint">{p.candidates.length ? 'None of the other recipes would make this route cheaper.' : 'No other recipes for this skill range.'}</p>}
      {rest.length > 0 && (
        <button className="link" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Hide' : 'Show'} {rest.length} that wouldn't change this route</button>
      )}
    </div>
  )
}

function RouteShopping({ p, inp, name, result }: { p: Plan; inp: Inputs; name: (id: number) => string; result: ModelResult }) {
  const all = useMemo(() => routeItems(p, result.prices), [p, result])
  const auto = `${inp.profession} ${inp.from}-${inp.to}`
  const [listName, setListName] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const ah = all.filter((x) => !x.vendor)
  const vendor = all.filter((x) => x.vendor)
  const text = auctionatorImport(listName ?? auto, ah.map((x) => ({ item: x.item, name: x.name ?? name(x.item), qty: x.qty, ticked: true })))
  const cost = (xs: typeof all) => xs.reduce((t, x) => t + (x.price ?? 0) * x.qty, 0)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('Copied. In game: Auctionator > Shopping > Import, paste, OK.')
    } catch {
      setCopied('Could not copy here: select the text below and press Ctrl+C.')
    }
  }
  const table = (xs: typeof all) => (
    <table className="lv-table">
      <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price each</th><th className="num">Cost</th></tr></thead>
      <tbody>
        {xs.map((x) => (
          <tr key={x.item}>
            <td>{x.name ?? name(x.item)}</td>
            <td className="num">{x.qty.toLocaleString()}</td>
            <td className="num">{m(x.price)}</td>
            <td className="num">{x.price == null ? '' : m(x.price * x.qty)}</td>
          </tr>
        ))}
        <tr className="lv-total"><td colSpan={3}>Total</td><td className="num">{m(cost(xs))}</td></tr>
      </tbody>
    </table>
  )
  return (
    <div className="sgroup lv-wide">
      <h2>Shopping list for the whole route</h2>
      <div className="srow">
        <label>Auctionator list name <input className="shop-name" value={listName ?? auto} onChange={(e) => setListName(e.target.value === auto ? null : e.target.value)} /></label>
      </div>
      <textarea className="shop-text" readOnly value={text} rows={3} onFocus={(e) => e.target.select()} />
      <div className="srow">
        <button className="button primary" onClick={copy}>Copy</button>
        {copied && <span className="muted">{copied}</span>}
      </div>
      <p className="hint">Every reagent of every stretch at the amounts shown there, plus the recipes to buy on the AH. Items a vendor sells are
        left out (below). The totals are what you spend before selling what you craft, so they are higher than the expected cost above. Importing a list whose name already exists in Auctionator replaces it.</p>
      <h2 className="lv-sub">On the list ({ah.length})</h2>
      {table(ah)}
      {vendor.length > 0 && <>
        <h2 className="lv-sub">Buy from a vendor ({vendor.length}, not on the list)</h2>
        {table(vendor)}
      </>}
    </div>
  )
}

/** What makes two routes the same route: the stretches (skill range, recipe, crafted reagents) and the recipes to learn. */
function routeKey(p: Plan | null): string {
  if (!p) return ''
  return p.segments.map((s) => `${s.from}-${s.to}:${s.action.key}`).join(',') + '|' + p.learn.map((l) => l.recipe.id).join(',')
}

function salesTip(sales: SalesData | null, house: number): string {
  const where = FACTION[house] ? `the ${FACTION[house]} AH` : `house ${house}`
  const base = `How many of the crafted item sell per day on ${where}, over the last 7 days: our estimate from the hourly auction `
    + 'listings (as in Forever Market; includes some cancellations, misses items bought within the hour). Compare with Craft: '
    + '50 crafts of an item that sells 2 a day take about 25 days to sell.'
  if (!sales) return base + " Needs the auction data folder (File > Link auction data folder) and the PC sync's sales.json."
  if (!sales.houses[house]) return base + ` No estimate for house ${house}: only Alliance (111) and Horde (114) have one.`
  return base + ` Estimate made ${new Date(sales.at).toLocaleString()}.`
}

function soldCell(s: Segment, sales: SalesData | null, house: number) {
  const product = s.action.recipe.product
  const h = sales?.houses[house]
  if (product == null || !h || !h.hours) return ''
  const n = h.items.get(product)
  if (n == null) return <span className="muted">none</span>
  return n < 10 ? (Math.round(n * 10) / 10).toLocaleString() : Math.round(n).toLocaleString()
}

const EXIT_TIP = 'What one craft brings back if you sell what it makes this way. The best of the three is green; hover a value for the profit or loss against Cost each.'
const fmtShort = (c: number) => {
  const r = Math.round(c), g = Math.floor(r / 10000), s = Math.floor((r % 10000) / 100), cc = r % 100
  return g ? `${g}g ${s}s` : s ? `${s}s ${cc}c` : `${cc}c`
}

function ExitCells({ s, row }: { s: Segment; row: RecipeRow | undefined }) {
  const a = s.action
  // value per craft, or 'na' where the exit doesn't apply, or null where it is unpriced
  const vendor: number | null | 'na' = a.recipe.product == null ? 'na' : a.credit > 0 ? a.credit : 'na'
  const de: number | null | 'na' = !row || !row.deBand ? 'na' : row.deValue
  const ah: number | null | 'na' = !row || row.bind === 'pickup' ? (row ? 'bop' as 'na' : 'na') : row.ahValue
  const exits = [vendor, ah, de]
  const profits = exits.map((v) => (typeof v === 'number' ? v - a.cost : null))
  // the exit worth the most (ties: Vendor, then AH, then Disenchant)
  let best = -1
  exits.forEach((v, i) => { if (typeof v === 'number' && (best < 0 || v > (exits[best] as number))) best = i })
  return (
    <>
      {exits.map((v, i) => (
        <td key={i} className={i === 0 ? 'num lv-x lv-x1' : 'num lv-x'}>
          {v === 'na' ? (i === 1 && row?.bind === 'pickup' ? <span className="muted">BoP</span> : '')
            : v == null ? <span className="muted">unpriced</span>
              : <span className={`lv-exit ${i === best ? 'lv-pos' : 'lv-neg'}`}
                title={`${profits[i]! > 0 ? 'Profit' : 'Loss'} per craft: ${fmtShort(Math.abs(profits[i]!))} (value minus Cost each)`}><Coins v={v} short /></span>}
        </td>
      ))}
    </>
  )
}

function SegmentDetail({ s, name, result }: { s: Segment; name: (id: number) => string; result: ModelResult }) {
  const total = s.shopping.reduce((t, l) => t + (l.price ?? 0) * l.qtySafe, 0)
  return (
    <div className="lv-shop">
      {s.makerCrafts.length > 0 && (
        <p className="lv-make">Craft {s.makerCrafts.map((x, i) => (
          <span key={i} title={`Expected ${q(x.mean)} on average`}>{i > 0 && ', '}<b>{x.safe}</b> × {x.recipe.name}</span>
        ))}, then <span title={`Expected ${q(s.crafts.mean)} on average`}><b>{s.crafts.safe}</b> × {s.action.recipe.name}</span>.</p>
      )}
      <table className="lv-table">
        <thead><tr><th>Buy</th><th className="num lv-tip" title="Enough for the queued crafts (hover a number for the average use)">Qty ⓘ</th><th className="num">Price each</th><th>Price from</th><th className="num">Cost</th></tr></thead>
        <tbody>
          {s.shopping.map((l) => (
            <tr key={l.item}>
              <td>{name(l.item)}</td>
              <td className="num" title={`Uses ${q(l.qtyMean)} on average`}>{Math.ceil(l.qtySafe - 1e-9).toLocaleString()}</td>
              <td className="num">{m(l.price)}</td>
              <td className="muted">{priceFrom(l.item, result)}</td>
              <td className="num">{l.price == null ? '' : m(l.price * l.qtySafe)}</td>
            </tr>
          ))}
          <tr className="lv-total"><td colSpan={4}>Reagents for the queued crafts</td><td className="num">{m(total)}</td></tr>
        </tbody>
      </table>
    </div>
  )
}

function priceFrom(id: number, result: ModelResult): string {
  const im = result.intermediates.get(id)
  if (im && im.source === 'Craft') return 'crafted (Intermediates)'
  return sourceLabel(result.prices(id).reagentSource)
}
