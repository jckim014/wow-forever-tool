// The trade tracker page (trades.html): balances, items in stock, history. Figures from model.ts.
import { useMemo, useState, type ReactNode } from 'react'
import {
  SIDE_NAME, awaitingTransfer, entryDelta, history, itemKey, ordered, ledger, newId, onHand, other, parseMoney, totals, transferLoss, transfersOf, leftToTransfer,
  type Adjustment, type Entry, type EntryKind, type HistoryEvent, type ItemSummary, type Ledger, type Purchase, type Side, type TradesDoc, type Transfer,
} from './model'
import { useTradesStore, type TradesStatus } from './store'

// ---- small pieces ----

/** Copper -> coin-coloured "12g 40s 05c" (zero parts after a larger one kept, so amounts read evenly). */
function Money({ v, sign = false }: { v: number; sign?: boolean }) {
  const c = Math.round(Math.abs(v))
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100
  const parts: ReactNode[] = []
  if (g) parts.push(<span key="g" className="t-g">{g.toLocaleString()}g</span>)
  if (g || s) parts.push(<span key="s" className="t-s">{g ? String(s).padStart(2, '0') : s}s</span>)
  parts.push(<span key="c" className="t-c">{g || s ? String(cc).padStart(2, '0') : cc}c</span>)
  const pre = v < 0 && c ? '−' : sign && c ? '+' : ''
  return <span className="t-money">{pre}{parts.reduce<ReactNode[]>((a, p, i) => (i ? [...a, ' ', p] : [p]), [])}</span>
}

const Fac = ({ s }: { s: Side }) => <span className={s === 'A' ? 't-ally' : 't-horde'}>{SIDE_NAME[s]}</span>
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`
const Profit = ({ v }: { v: number }) => <span className={v >= 0 ? 't-pos' : 't-neg'}><Money v={v} sign /></span>

function MoneyInput({ label, value, onChange, allowNegative = false, autoFocus = false, extra }: {
  label: string; value: string; onChange: (v: string) => void; allowNegative?: boolean; autoFocus?: boolean; extra?: ReactNode
}) {
  const v = parseMoney(value)
  const bad = value.trim() !== '' && (v === null || (!allowNegative && v < 0))
  return (
    <label className="t-field">
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 12g 40s, or 12.4" autoFocus={autoFocus} className={bad ? 't-bad' : ''} />
      <small>{bad ? 'Type gold like 12g 40s 5c, or a number of gold' : v !== null ? <Money v={v} /> : ' '}{extra}</small>
    </label>
  )
}

function SidePick({ value, onChange, label }: { value: Side; onChange: (s: Side) => void; label: string }) {
  return (
    <div className="t-field">
      <span>{label}</span>
      <div className="t-seg">
        {(['A', 'H'] as Side[]).map((s) => (
          <button key={s} type="button" className={value === s ? `on ${s === 'A' ? 't-ally-on' : 't-horde-on'}` : ''} onClick={() => onChange(s)}>{SIDE_NAME[s]}</button>
        ))}
      </div>
    </div>
  )
}

function Dialog({ title, children, onClose, onSave, canSave, saveLabel = 'Save' }: {
  title: string; children: ReactNode; onClose: () => void; onSave: () => void; canSave: boolean; saveLabel?: string
}) {
  return (
    <div className="t-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="t-dialog" onSubmit={(e) => { e.preventDefault(); if (canSave) onSave() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <h2>{title}</h2>
        {children}
        <div className="t-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="t-primary" disabled={!canSave}>{saveLabel}</button>
        </div>
      </form>
    </div>
  )
}

const moneyText = (c: number) => {
  const g = Math.floor(c / 10000), s = Math.floor((c % 10000) / 100), cc = c % 100
  return [g && `${g}g`, s && `${s}s`, cc && `${cc}c`].filter(Boolean).join(' ') || '0'
}

/** ISO time <-> the value of a datetime-local input (local time, to the minute). */
const toLocalInput = (iso: string) => {
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

// ---- dialogs ----

type Open =
  | { kind: 'start' }
  | { kind: 'purchase'; entry?: Purchase; item?: string }
  | { kind: 'cardTransfer'; purchase: Purchase; entry?: Transfer }
  | { kind: 'item'; key: string }
  | { kind: 'transfer' | 'sale'; entry?: Entry; item?: string; side?: Side }
  | { kind: 'adjust'; adj?: Adjustment }

type Update = (fn: (d: TradesDoc) => TradesDoc) => void

function StartDialog({ doc, update, close }: { doc: TradesDoc; update: Update; close: () => void }) {
  const [a, setA] = useState(doc.start.at ? moneyText(doc.start.A) : '')
  const [h, setH] = useState(doc.start.at ? moneyText(doc.start.H) : '')
  const va = parseMoney(a), vh = parseMoney(h)
  const ok = va !== null && vh !== null && va >= 0 && vh >= 0
  return (
    <Dialog title="Starting gold" onClose={close} canSave={ok} onSave={() => {
      update((d) => ({ ...d, start: { A: va!, H: vh!, at: d.start.at ?? new Date().toISOString() } }))
      close()
    }}>
      <p className="t-hint">The gold each faction had when you started tracking. Every trade and adjustment is added to these.</p>
      <MoneyInput label="Alliance" value={a} onChange={setA} autoFocus />
      <MoneyInput label="Horde" value={h} onChange={setH} />
    </Dialog>
  )
}

function PurchaseDialog({ doc, entry, item: item0, update, close }: { doc: TradesDoc; entry?: Purchase; item?: string; update: Update; close: () => void }) {
  const last = [...doc.entries].reverse().find((e): e is Purchase => e.kind === 'purchase')
  const [side, setSide] = useState<Side>(entry?.side ?? last?.side ?? 'A')
  const [item, setItem] = useState(entry?.item ?? item0 ?? '')
  const [qty, setQty] = useState(entry ? String(entry.qty) : '')
  const [cost, setCost] = useState(entry ? moneyText(entry.cost) : '')
  const names = useMemo(() => [...new Map(doc.entries.map((e) => [itemKey(e.item), e.item.trim()])).values()].sort(), [doc.entries])
  const q = Number(qty), c = parseMoney(cost)
  const ok = item.trim() !== '' && Number.isInteger(q) && q >= 1 && c !== null && c > 0
  return (
    <Dialog title={entry ? 'Edit purchase' : 'Purchase'} onClose={close} canSave={ok} onSave={() => {
      const p: Purchase = { kind: 'purchase', id: entry?.id ?? newId(), at: entry?.at ?? new Date().toISOString(), side, item: item.trim(), qty: q, cost: c! }
      update((d) => ({
        ...d,
        entries: entry
          // Its card transfers move its units, so they follow its item and faction; a single transfer that moved all
          // of it also follows its quantity.
          ? d.entries.map((x) => {
              if (x.id === entry.id) return p
              if (x.kind !== 'transfer' || x.purchase !== entry.id) return x
              const whole = transfersOf(d, entry).length === 1 && x.qty === entry.qty
              return { ...x, item: p.item, from: p.side, qty: whole ? p.qty : x.qty }
            })
          : [...d.entries, p],
      }))
      close()
    }}>
      <SidePick label="Bought on" value={side} onChange={setSide} />
      <label className="t-field"><span>Item</span>
        <input value={item} onChange={(e) => setItem(e.target.value)} list="t-items" autoFocus={!item0} />
        <datalist id="t-items">{names.map((i) => <option key={i} value={i} />)}</datalist>
      </label>
      <label className="t-field"><span>Quantity</span>
        <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus={!!item0} />
      </label>
      <MoneyInput label="Gold spent (total)" value={cost} onChange={setCost} />
    </Dialog>
  )
}

/** A transfer of some or all of a purchase's remaining units, from its card (or editing one made there). */
function CardTransferDialog({ doc, purchase, entry: existing, update, close }: { doc: TradesDoc; purchase: Purchase; entry?: Transfer; update: Update; close: () => void }) {
  // Units this transfer can move: what is left on the card, plus its own units when editing.
  const max = leftToTransfer(doc, purchase) + (existing?.qty ?? 0)
  const qty0 = existing?.qty ?? max
  const [qty, setQty] = useState(String(qty0))
  const q = Number(qty)
  const qtyOk = Number.isInteger(q) && q >= 1 && q <= max
  // Price typed per unit; stored as the total. Left untouched with the same quantity, the original total is kept
  // exactly (no rounding).
  const total0 = existing?.price ?? (qty0 === purchase.qty ? purchase.cost : Math.round((purchase.cost * qty0) / purchase.qty))
  const text0 = moneyText(Math.round(total0 / Math.max(1, qty0)))
  const [price, setPrice] = useState(text0)
  const each = parseMoney(price)
  const p = each === null || !qtyOk ? null : price === text0 && q === qty0 ? total0 : each * q
  const ok = qtyOk && each !== null && each > 0 && p !== null && p > 0
  const to = other(purchase.side)
  return (
    <Dialog title={`Transfer ${purchase.item} to ${SIDE_NAME[to]}`} onClose={close} canSave={ok} saveLabel={existing ? 'Save' : 'Record transfer'} onSave={() => {
      update((d) => ({
        ...d,
        entries: existing
          ? d.entries.map((x) => (x.id === existing.id ? { ...existing, qty: q, price: p! } : x))
          : [...d.entries, { kind: 'transfer', id: newId(), at: new Date().toISOString(), item: purchase.item, qty: q, from: purchase.side, price: p!, purchase: purchase.id }],
      }))
      close()
    }}>
      <label className="t-field"><span>Quantity</span>
        <input type="number" min={1} max={max} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        <small className={qty !== '' && !qtyOk ? 't-warn' : ''}>
          {qty !== '' && !qtyOk ? `Between 1 and ${max}` : qtyOk && q < max ? `${plural(max - q, 'unit')} stay waiting for transfer` : `All ${plural(max, 'unit')}`}
        </small>
      </label>
      <MoneyInput label="Listed on Blackwater for (per unit)" value={price} onChange={setPrice} autoFocus />
      {ok && (
        <p className="t-hint">
          {q > 1 && <>{plural(q, 'unit')}, <Money v={p!} /> in all. </>}<Fac s={to} /> pays <Money v={p!} />. Blackwater keeps 15% (<Money v={transferLoss(p!)} />), so <Fac s={purchase.side} /> gets back <Money v={p! - transferLoss(p!)} />.
        </p>
      )}
    </Dialog>
  )
}

function PurchaseCard({ p, left, open, onDelete }: { p: Purchase; left: number; open: (o: Open) => void; onDelete: () => void }) {
  const to = other(p.side)
  return (
    <div className="t-card">
      <div className="t-cardhead">
        <strong>{p.item}</strong>
        <span className="t-muted">{left < p.qty ? `${left} of ${p.qty} units left to transfer` : plural(p.qty, 'unit')} · bought on <Fac s={p.side} /> for <Money v={p.cost} /> · {when(p.at)}</span>
      </div>
      <div className="t-cardbtns">
        <button className="t-primary" onClick={() => open({ kind: 'cardTransfer', purchase: p })}>Transfer to {SIDE_NAME[to]}</button>
        <button onClick={() => open({ kind: 'purchase', entry: p })}>Edit</button>
        <button className="t-del" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

const ENTRY_TEXT: Record<EntryKind, { title: string; side: string; money: string }> = {
  purchase: { title: 'Purchase', side: 'Bought on', money: 'Gold spent (total)' },
  transfer: { title: 'Transfer', side: 'From', money: 'Listed on Blackwater for (per unit)' },
  sale: { title: 'Sale', side: 'Sold on', money: 'Gold received in the mailbox (total)' },
}
const entrySide = (e: Entry): Side => (e.kind === 'transfer' ? e.from : e.side)
const entryMoney = (e: Entry) => (e.kind === 'purchase' ? e.cost : e.kind === 'transfer' ? e.price : e.received)

/** Purchase, transfer or sale: faction, item, quantity, gold, time. */
function EntryDialog({ kind, entry, item: item0, side: side0, doc, update, close }: {
  kind: 'transfer' | 'sale'; entry?: Entry; item?: string; side?: Side; doc: TradesDoc; update: Update; close: () => void
}) {
  const t = ENTRY_TEXT[kind]
  const last = [...doc.entries].reverse().find((e) => e.kind === kind)
  const [side, setSide] = useState<Side>(entry ? entrySide(entry) : side0 ?? (last ? entrySide(last) : kind === 'sale' ? 'H' : 'A'))
  const [item, setItem] = useState(entry?.item ?? item0 ?? '')
  const [qty, setQty] = useState(entry ? String(entry.qty) : '')
  // A transfer's price is typed per unit and stored as the total; left untouched (with the same quantity), the
  // original total is kept exactly.
  const money0 = entry ? moneyText(kind === 'transfer' ? Math.round(entryMoney(entry) / entry.qty) : entryMoney(entry)) : ''
  const [money, setMoney] = useState(money0)
  const initialWhen = useMemo(() => toLocalInput(entry?.at ?? new Date().toISOString()), [entry])
  const [whenText, setWhen] = useState(initialWhen)

  const names = useMemo(() => [...new Map(doc.entries.map((e) => [itemKey(e.item), e.item.trim()])).values()].sort(), [doc.entries])
  // What the faction holds now, leaving out the entry being edited.
  const without = useMemo(() => (entry ? { ...doc, entries: doc.entries.filter((e) => e.id !== entry.id) } : doc), [doc, entry])
  const held = item.trim() ? onHand(without, item, side) : null
  const q = Number(qty), typed = parseMoney(money)
  const m = kind !== 'transfer' || typed === null ? typed
    : entry && money === money0 && q === entry.qty ? entryMoney(entry)
    : Number.isInteger(q) && q >= 1 ? typed * q : null
  const whenOk = whenText !== '' && !Number.isNaN(new Date(whenText).getTime())
  const ok = item.trim() !== '' && Number.isInteger(q) && q >= 1 && m !== null && (kind === 'sale' ? m >= 0 : m > 0) && whenOk
  const avgCost = held && held.units > 0 && Number.isInteger(q) && q >= 1 ? Math.round((held.cost * Math.min(q, held.units)) / held.units) : null
  const avgEach = held && held.units > 0 ? Math.round(held.cost / held.units) : null

  const save = () => {
    const at = whenText === initialWhen ? entry?.at ?? new Date().toISOString() : new Date(whenText).toISOString()
    const base = { id: entry?.id ?? newId(), at, item: item.trim(), qty: q }
    const e: Entry =
      kind === 'transfer' ? { ...base, kind, from: side, price: m!, ...(entry?.kind === 'transfer' && entry.purchase ? { purchase: entry.purchase } : {}) }
      : { ...base, kind, side, received: m! }
    update((d) => ({ ...d, entries: entry ? d.entries.map((x) => (x.id === entry.id ? e : x)) : [...d.entries, e] }))
    close()
  }

  return (
    <Dialog title={`${entry ? 'Edit ' + t.title.toLowerCase() : t.title}${kind === 'transfer' ? ` to ${SIDE_NAME[other(side)]}` : ''}`} onClose={close} canSave={ok} onSave={save}>
      <SidePick label={t.side} value={side} onChange={setSide} />
      <label className="t-field"><span>Item</span>
        <input value={item} onChange={(e) => setItem(e.target.value)} list="t-items" autoFocus={!item0} />
        <datalist id="t-items">{names.map((i) => <option key={i} value={i} />)}</datalist>
        <small>{held && <>{SIDE_NAME[side]} holds {plural(held.units, 'unit')}{held.units > 0 && <> · <button type="button" className="t-link t-inline" onClick={() => setQty(String(held.units))}>use all</button></>}</>}</small>
      </label>
      <label className="t-field"><span>Quantity</span>
        <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} autoFocus={!!item0} />
        <small className={held && q > held.units ? 't-warn' : ''}>{held && q > held.units ? `More than ${SIDE_NAME[side]} holds; the extra ${plural(q - held.units, 'unit')} will count at no cost` : ' '}</small>
      </label>
      <MoneyInput label={t.money} value={money} onChange={setMoney} extra={kind === 'transfer' && avgEach !== null && <> · <button type="button" className="t-link t-inline" onClick={() => setMoney(moneyText(avgEach))}>use what they cost ({moneyText(avgEach)} each)</button></>} />
      {kind === 'transfer' && m !== null && m > 0 && (
        <p className="t-hint">{q > 1 && <>{plural(q, 'unit')}, <Money v={m} /> in all. </>}<Fac s={other(side)} /> pays <Money v={m} />. Blackwater keeps 15% (<Money v={transferLoss(m)} />), so <Fac s={side} /> gets back <Money v={m - transferLoss(m)} />.</p>
      )}
      {kind === 'sale' && m !== null && avgCost !== null && (
        <p className="t-hint">These units cost <Money v={avgCost} /> on average, so this sale makes <Profit v={m - avgCost} />.</p>
      )}
      <label className="t-field"><span>When</span>
        <input type="datetime-local" value={whenText} onChange={(e) => setWhen(e.target.value)} />
        <small>Entries count in time order, so a sale can be typed before its purchase.</small>
      </label>
    </Dialog>
  )
}

function AdjustDialog({ adj, update, close }: { adj?: Adjustment; update: Update; close: () => void }) {
  const [side, setSide] = useState<Side>(adj?.side ?? 'A')
  const [dir, setDir] = useState<1 | -1>(adj && adj.amount < 0 ? -1 : 1)
  const [amount, setAmount] = useState(adj ? moneyText(Math.abs(adj.amount)) : '')
  const [note, setNote] = useState(adj?.note ?? '')
  const v = parseMoney(amount)
  const ok = v !== null && v > 0 && note.trim() !== ''
  return (
    <Dialog title={adj ? 'Edit adjustment' : 'Adjust balance'} onClose={close} canSave={ok} onSave={() => {
      const a = { side, amount: dir * v!, note: note.trim() }
      update((d) => ({
        ...d,
        adjustments: adj ? d.adjustments.map((x) => (x.id === adj.id ? { ...x, ...a } : x)) : [...d.adjustments, { id: newId(), at: new Date().toISOString(), ...a }],
      }))
      close()
    }}>
      <p className="t-hint">For gold that moves outside your trades. Adjustments change the balance but never count as trading profit.</p>
      <SidePick label="Faction" value={side} onChange={setSide} />
      <div className="t-field"><span>Change</span>
        <div className="t-seg">
          <button type="button" className={dir === 1 ? 'on' : ''} onClick={() => setDir(1)}>Add gold</button>
          <button type="button" className={dir === -1 ? 'on' : ''} onClick={() => setDir(-1)}>Remove gold</button>
        </div>
      </div>
      <MoneyInput label="Amount" value={amount} onChange={setAmount} autoFocus />
      <label className="t-field"><span>Note (required)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. quest gold, bought a mount" />
      </label>
    </Dialog>
  )
}

// ---- page parts ----

function StatusLine({ status, s }: { status: TradesStatus; s: ReturnType<typeof useTradesStore> }) {
  const [menu, setMenu] = useState(false)
  const label =
    status.kind === 'loading' ? 'Loading…'
    : status.kind === 'saved' ? `Saved to ${status.file} ✓`
    : status.kind === 'saving' ? `Saving to ${status.file}…`
    : status.kind === 'needs-permission' ? null
    : status.kind === 'error' ? status.message
    : status.fileApi ? 'Saved in this browser only' : 'Saved in this browser only (this browser cannot save to a file)'
  return (
    <div className="t-status">
      {status.kind === 'needs-permission'
        ? <button className="t-primary" onClick={s.reconnect}>Allow saving to {status.file}</button>
        : <span className={status.kind === 'error' ? 't-err' : status.kind === 'browser-only' ? 't-warn' : ''}>{label}</span>}
      <div className="t-menuwrap">
        <button onClick={() => setMenu(!menu)}>File ▾</button>
        {menu && (
          <div className="t-menu" onClick={() => setMenu(false)}>
            <button onClick={s.createFile}>Create trades file…</button>
            <button onClick={s.openFile}>Open trades file…</button>
            <button onClick={s.exportFile}>Download a copy</button>
            {(status.kind === 'saved' || status.kind === 'saving' || status.kind === 'needs-permission') && <button onClick={s.disconnect}>Stop saving to the file</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function StockCell({ units, cost }: { units: number; cost: number }) {
  if (units <= 0) return <span className="t-muted">–</span>
  return <>{units.toLocaleString()} <span className="t-muted t-each">· <Money v={Math.round(cost / units)} /> each</span></>
}

function ItemsTable({ items, open }: { items: ItemSummary[]; open: (o: Open) => void }) {
  return (
    <table className="t-hist t-items">
      <thead><tr><th>Item</th><th className="t-r">Alliance holds</th><th className="t-r">Horde holds</th><th className="t-r">Tied up</th><th className="t-r">Sold</th><th className="t-r">Received</th><th className="t-r">Profit</th>
        <th className="t-r" title="Gold spent on all purchases of the item ÷ units bought (Blackwater's cut not included)">Avg buy ⓘ</th>
        <th className="t-r" title="Gold received from sales, as recorded ÷ units sold">Avg sell ⓘ</th><th /></tr></thead>
      <tbody>
        {items.map((it) => {
          const { A, H } = it.stock
          const has = A.units > 0 || H.units > 0
          return (
            <tr key={it.key}>
              <td><strong>{it.name}</strong></td>
              <td className="t-r"><StockCell {...A} /></td>
              <td className="t-r"><StockCell {...H} /></td>
              <td className="t-r">{has ? <Money v={A.cost + H.cost} /> : ''}</td>
              <td className="t-r">{it.soldUnits ? it.soldUnits.toLocaleString() : ''}</td>
              <td className="t-r">{it.received ? <Money v={it.received} /> : ''}</td>
              <td className="t-r" title={`Received, minus what the sold units cost, minus Blackwater's cut (${moneyText(it.transferLoss)})`}>{it.soldUnits || it.transferLoss ? <Profit v={it.profit} /> : ''}</td>
              <td className="t-r">{it.boughtUnits ? <Money v={Math.round(it.boughtCost / it.boughtUnits)} /> : ''}</td>
              <td className="t-r">{it.soldUnits ? <Money v={Math.round(it.received / it.soldUnits)} /> : ''}</td>
              <td className="t-rowbtns">
                <button onClick={() => open({ kind: 'item', key: it.key })}>Edit</button>
                <button onClick={() => open({ kind: 'purchase', item: it.name })}>Buy</button>
                {has && <button onClick={() => open({ kind: 'transfer', item: it.name, side: A.units > 0 || H.units <= 0 ? 'A' : 'H' })}>Transfer</button>}
                {has && <button onClick={() => open({ kind: 'sale', item: it.name, side: H.units > 0 || A.units <= 0 ? 'H' : 'A' })}>Sell</button>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

const KIND_LABEL: Record<HistoryEvent['kind'], string> = { start: 'Start', purchase: 'Purchase', transfer: 'Transfer', sale: 'Sale', adjustment: 'Adjustment' }

/** Delete one entry (a purchase takes its card transfer with it; a card transfer is "undone"). */
function deleteEntry(doc: TradesDoc, update: Update, e: Entry) {
  const linked = new Set(e.kind === 'purchase' ? transfersOf(doc, e).map((x) => x.id) : [])
  const q = e.kind === 'transfer' && e.purchase ? 'Undo this transfer? Its units go back to waiting for transfer.'
    : linked.size ? `Delete this purchase, with its ${linked.size === 1 ? 'transfer' : `${linked.size} transfers`}?` : `Delete this ${e.kind}?`
  if (confirm(q)) update((d) => ({ ...d, entries: d.entries.filter((x) => x.id !== e.id && !linked.has(x.id)) }))
}
/** Open the dialog an entry was made with. */
function editEntry(doc: TradesDoc, open: (o: Open) => void, e: Entry) {
  if (e.kind === 'purchase') open({ kind: 'purchase', entry: e })
  else if (e.kind === 'transfer' && e.purchase) {
    const p = doc.entries.find((x): x is Purchase => x.kind === 'purchase' && x.id === e.purchase)
    open(p ? { kind: 'cardTransfer', purchase: p, entry: e } : { kind: 'transfer', entry: e })
  } else open({ kind: e.kind, entry: e })
}

/** Fix typos for one item: rename it everywhere, edit or delete its entries, or delete it with all its entries. */
function ItemDialog({ itemKey: key, doc, l, update, open, close }: {
  itemKey: string; doc: TradesDoc; l: Ledger; update: Update; open: (o: Open) => void; close: () => void
}) {
  const it = l.items.find((x) => x.key === key)
  const [name, setName] = useState(it?.name ?? '')
  if (!it) return null
  const entries = ordered(doc.entries).filter((e) => itemKey(e.item) === key).reverse()
  const newKey = itemKey(name)
  const mergeInto = newKey !== key ? l.items.find((x) => x.key === newKey) : undefined
  const canRename = name.trim() !== '' && name.trim() !== it.name
  const rename = () => {
    if (mergeInto && !confirm(`${mergeInto.name} already exists. Merge ${it.name} into it?`)) return
    const to = mergeInto?.name ?? name.trim()
    update((d) => ({ ...d, entries: d.entries.map((e) => (itemKey(e.item) === key ? { ...e, item: to } : e)) }))
    close()
  }
  const deleteItem = () => {
    const change: Record<Side, number> = { A: 0, H: 0 }
    for (const e of entries) for (const [s, v] of Object.entries(entryDelta(e)) as [Side, number][]) change[s] -= v
    const fmt = (v: number) => (v === 0 ? 'no change' : `${v < 0 ? '−' : '+'}${moneyText(Math.abs(v))}`)
    if (!confirm(`Delete ${it.name} and ${entries.length === 1 ? 'its entry' : `all ${entries.length} of its entries`}?\n\nBalances change: Alliance ${fmt(change.A)}, Horde ${fmt(change.H)}.`)) return
    update((d) => ({ ...d, entries: d.entries.filter((e) => itemKey(e.item) !== key) }))
    close()
  }
  const goEdit = (e: Entry) => { close(); editEntry(doc, open, e) }
  return (
    <div className="t-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div className="t-dialog t-wide" onKeyDown={(e) => { if (e.key === 'Escape') close() }}>
        <h2>Edit {it.name}</h2>
        <form className="t-rename" onSubmit={(e) => { e.preventDefault(); if (canRename) rename() }}>
          <label className="t-field"><span>Name (changes it on every entry)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <small>{mergeInto ? `Matches ${mergeInto.name}: saving merges the two items` : ' '}</small>
          </label>
          <button type="submit" className="t-primary" disabled={!canRename}>{mergeInto ? 'Merge' : 'Rename'}</button>
        </form>
        <div className="t-field"><span>Entries (fix a wrong quantity or amount here)</span></div>
        <table className="t-hist t-mini">
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="t-nowrap">{when(e.at)}</td>
                <td><span className={`t-tag t-tag-${e.kind}`}>{KIND_LABEL[e.kind]}</span></td>
                <td>{e.kind === 'transfer' ? <><Fac s={e.from} /> → <Fac s={other(e.from)} /></> : <Fac s={e.side} />}</td>
                <td className="t-r">{plural(e.qty, 'unit')}</td>
                <td className="t-r"><Money v={entryMoney(e)} /></td>
                <td className="t-rowbtns">
                  <button onClick={() => goEdit(e)}>Edit</button>
                  <button className="t-del" onClick={() => deleteEntry(doc, update, e)}>{e.kind === 'transfer' && e.purchase ? 'Undo' : 'Delete'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="t-actions">
          <button type="button" className="t-del t-left" onClick={deleteItem}>Delete item and all its entries</button>
          <button type="button" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  )
}

function HistoryTable({ doc, l, open, update }: { doc: TradesDoc; l: Ledger; open: (o: Open) => void; update: Update }) {
  const ev = history(doc)
  if (!ev.length) return <p className="t-muted">Nothing recorded yet.</p>
  const delEntry = (e: Entry) => deleteEntry(doc, update, e)
  const edit = (e: Entry) => editEntry(doc, open, e)
  const delAdj = (a: Adjustment) => {
    if (confirm('Delete this adjustment?')) update((d) => ({ ...d, adjustments: d.adjustments.filter((x) => x.id !== a.id) }))
  }
  return (
    <table className="t-hist">
      <thead><tr><th>When</th><th>What</th><th>Details</th><th className="t-r">Alliance</th><th className="t-r">Horde</th><th /></tr></thead>
      <tbody>
        {ev.map((e, i) => {
          const en = e.entry
          const short = en ? l.short[en.id] : undefined
          return (
            <tr key={en?.id ?? e.adjustment?.id ?? `s${i}`} className={e.kind === 'adjustment' ? 't-adjrow' : ''}>
              <td className="t-nowrap">{when(e.at)}</td>
              <td><span className={`t-tag t-tag-${e.kind}`}>{KIND_LABEL[e.kind]}</span></td>
              <td>
                {e.kind === 'start' && 'Starting gold'}
                {en && <>{en.item} · {plural(en.qty, 'unit')}</>}
                {en?.kind === 'transfer' && <> to <Fac s={other(en.from)} /> <span className="t-muted">(Blackwater kept <Money v={transferLoss(en.price)} />)</span></>}
                {en?.kind === 'sale' && l.saleProfit[en.id] !== undefined && <span className="t-muted"> · profit <Profit v={l.saleProfit[en.id]} /></span>}
                {short ? <div className="t-warn t-small">⚠ {plural(short, 'unit')} more than {SIDE_NAME[en!.kind === 'transfer' ? en!.from : (en as { side: Side }).side]} held at the time (counted at no cost)</div> : null}
                {e.kind === 'adjustment' && <>“{e.adjustment!.note}”</>}
              </td>
              {(['A', 'H'] as Side[]).map((s) => <td key={s} className="t-r">{e.delta[s] !== undefined ? <Money v={e.delta[s]!} sign={e.kind !== 'start'} /> : ''}</td>)}
              <td className="t-rowbtns">
                {e.kind === 'start' && <button onClick={() => open({ kind: 'start' })}>Edit</button>}
                {en && <><button onClick={() => edit(en)}>Edit</button><button className="t-del" onClick={() => delEntry(en)}>{en.kind === 'transfer' && en.purchase ? 'Undo' : 'Delete'}</button></>}
                {e.adjustment && <><button onClick={() => open({ kind: 'adjust', adj: e.adjustment })}>Edit</button><button className="t-del" onClick={() => delAdj(e.adjustment!)}>Delete</button></>}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function Trades() {
  const s = useTradesStore()
  const { doc, update } = s
  const [dlg, setDlg] = useState<Open | null>(null)
  const [showSoldOut, setShowSoldOut] = useState(false)
  const l = useMemo(() => ledger(doc), [doc])
  const t = totals(doc, l)
  const newestFirst = [...l.items].sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0))
  const inStock = newestFirst.filter((it) => it.stock.A.units > 0 || it.stock.H.units > 0)
  const soldOut = newestFirst.filter((it) => !(it.stock.A.units > 0 || it.stock.H.units > 0))
  const close = () => setDlg(null)
  const waiting = awaitingTransfer(doc, l).reverse()
  const deletePurchase = (p: Purchase) => {
    const ts = new Set(transfersOf(doc, p).map((x) => x.id))
    const withT = ts.size === 0 ? '' : ts.size === 1 ? ', with its transfer' : `, with its ${ts.size} transfers`
    if (confirm(`Delete the ${p.item} purchase${withT}?`)) update((d) => ({ ...d, entries: d.entries.filter((x) => x.id !== p.id && !ts.has(x.id)) }))
  }

  return (
    <div className="t-page">
      <header className="t-top">
        <h1>Cross-faction trades</h1>
        <StatusLine status={s.status} s={s} />
      </header>

      {!doc.start.at && (
        <div className="t-setup">
          <span>Start by entering how much gold each faction has now.</span>
          <button className="t-primary" onClick={() => setDlg({ kind: 'start' })}>Set starting gold</button>
        </div>
      )}

      <section className="t-tiles">
        <div className="t-tile"><span className="t-ally">Alliance</span><b><Money v={t.balance.A} /></b></div>
        <div className="t-tile"><span className="t-horde">Horde</span><b><Money v={t.balance.H} /></b></div>
        <div className="t-tile t-total"><span>Total gold</span><b><Money v={t.total} /></b></div>
        <div className="t-tile"><span>Tied up in items</span><b><Money v={t.tiedUp} /></b><small>{plural(t.itemsInStock, 'item')} in stock, not in the total</small></div>
        <div className="t-tile"><span>Trading profit</span><b className={t.profit >= 0 ? 't-pos' : 't-neg'}><Money v={t.profit} sign /></b>
          <small title="Gold received, minus what the sold units cost (at the item's average cost), minus Blackwater's cut. Unsold items count at what you paid. Adjustments are left out.">sold units only ⓘ</small></div>
      </section>

      <div className="t-bar">
        <button className="t-primary" onClick={() => setDlg({ kind: 'purchase' })}>+ Purchase</button>
        <button className="t-primary" onClick={() => setDlg({ kind: 'sale' })}>+ Sale</button>
        <button onClick={() => setDlg({ kind: 'adjust' })}>Adjust balance</button>
        {doc.start.at && <button className="t-link" onClick={() => setDlg({ kind: 'start' })}>Starting gold: <Money v={doc.start.A} /> / <Money v={doc.start.H} /></button>}
      </div>

      <h2>Waiting for transfer</h2>
      {waiting.length ? waiting.map((p) => <PurchaseCard key={p.id} p={p} left={leftToTransfer(doc, p)} open={setDlg} onDelete={() => deletePurchase(p)} />) : <p className="t-muted">None. Record a purchase to start one.</p>}

      <h2>Items in stock</h2>
      {inStock.length ? <ItemsTable items={inStock} open={setDlg} /> : <p className="t-muted">None yet.</p>}

      {soldOut.length > 0 && (
        <>
          <h2><button className="t-link" onClick={() => setShowSoldOut(!showSoldOut)}>{showSoldOut ? '▾' : '▸'} Sold out ({soldOut.length})</button></h2>
          {showSoldOut && <ItemsTable items={soldOut} open={setDlg} />}
        </>
      )}

      <h2>History</h2>
      <HistoryTable doc={doc} l={l} open={setDlg} update={update} />

      {dlg?.kind === 'start' && <StartDialog doc={doc} update={update} close={close} />}
      {dlg?.kind === 'purchase' && <PurchaseDialog doc={doc} entry={dlg.entry} item={dlg.item} update={update} close={close} />}
      {dlg?.kind === 'item' && <ItemDialog itemKey={dlg.key} doc={doc} l={l} update={update} open={setDlg} close={close} />}
      {dlg?.kind === 'cardTransfer' && <CardTransferDialog doc={doc} purchase={dlg.purchase} entry={dlg.entry} update={update} close={close} />}
      {dlg && (dlg.kind === 'transfer' || dlg.kind === 'sale') && (
        <EntryDialog kind={dlg.kind} entry={dlg.entry} item={dlg.item} side={dlg.side} doc={doc} update={update} close={close} />
      )}
      {dlg?.kind === 'adjust' && <AdjustDialog adj={dlg.adj} update={update} close={close} />}
    </div>
  )
}
