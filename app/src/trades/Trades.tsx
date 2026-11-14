// The trade tracker page (trades.html): balances, open batches, finished batches, history. Figures from model.ts.
import { useMemo, useState, type ReactNode } from 'react'
import {
  SIDE_NAME, batchProfit, history, isFinished, newId, other, parseMoney, received, soldQty, tiedUp, totals, transferLoss,
  unsoldQty, type Adjustment, type Batch, type HistoryEvent, type Sale, type Side, type TradesDoc,
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

function MoneyInput({ label, value, onChange, allowNegative = false, autoFocus = false }: {
  label: string; value: string; onChange: (v: string) => void; allowNegative?: boolean; autoFocus?: boolean
}) {
  const v = parseMoney(value)
  const bad = value.trim() !== '' && (v === null || (!allowNegative && v < 0))
  return (
    <label className="t-field">
      <span>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 12g 40s, or 12.4" autoFocus={autoFocus} className={bad ? 't-bad' : ''} />
      <small>{bad ? 'Type gold like 12g 40s 5c, or a number of gold' : v !== null ? <Money v={v} /> : ' '}</small>
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

// ---- dialogs ----

type Open =
  | { kind: 'start' }
  | { kind: 'purchase'; batch?: Batch }
  | { kind: 'transfer'; batch: Batch }
  | { kind: 'sale'; batch: Batch; sale?: Sale }
  | { kind: 'adjust'; adj?: Adjustment }

type Update = (fn: (d: TradesDoc) => TradesDoc) => void
const mapBatch = (d: TradesDoc, id: string, fn: (b: Batch) => Batch): TradesDoc => ({ ...d, batches: d.batches.map((b) => (b.id === id ? fn(b) : b)) })

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

function PurchaseDialog({ doc, batch, update, close }: { doc: TradesDoc; batch?: Batch; update: Update; close: () => void }) {
  const [side, setSide] = useState<Side>(batch?.side ?? 'A')
  const [item, setItem] = useState(batch?.item ?? '')
  const [qty, setQty] = useState(batch ? String(batch.qty) : '')
  const [cost, setCost] = useState(batch ? moneyText(batch.cost) : '')
  const items = useMemo(() => [...new Set(doc.batches.map((b) => b.item))].sort(), [doc.batches])
  const q = Number(qty), c = parseMoney(cost)
  const minQty = batch ? soldQty(batch) : 1
  const ok = item.trim() !== '' && Number.isInteger(q) && q >= Math.max(1, minQty) && c !== null && c > 0
  return (
    <Dialog title={batch ? 'Edit purchase' : 'Purchase'} onClose={close} canSave={ok} onSave={() => {
      if (batch) update((d) => mapBatch(d, batch.id, (b) => ({ ...b, side, item: item.trim(), qty: q, cost: c! })))
      else update((d) => ({ ...d, batches: [...d.batches, { id: newId(), item: item.trim(), qty: q, side, cost: c!, at: new Date().toISOString(), transfer: null, sales: [] }] }))
      close()
    }}>
      <SidePick label="Bought on" value={side} onChange={setSide} />
      <label className="t-field"><span>Item</span>
        <input value={item} onChange={(e) => setItem(e.target.value)} list="t-items" autoFocus />
        <datalist id="t-items">{items.map((i) => <option key={i} value={i} />)}</datalist>
      </label>
      <label className="t-field"><span>Quantity</span>
        <input type="number" min={Math.max(1, minQty)} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        <small>{batch && minQty > 0 ? `At least ${minQty} (already sold)` : ' '}</small>
      </label>
      <MoneyInput label="Gold spent (total)" value={cost} onChange={setCost} />
    </Dialog>
  )
}

function TransferDialog({ batch, update, close }: { batch: Batch; update: Update; close: () => void }) {
  const [price, setPrice] = useState(moneyText(batch.transfer?.price ?? batch.cost))
  const p = parseMoney(price)
  const ok = p !== null && p > 0
  const to = other(batch.side)
  return (
    <Dialog title={`Transfer ${batch.item} to ${SIDE_NAME[to]}`} onClose={close} canSave={ok} saveLabel={batch.transfer ? 'Save' : 'Record transfer'} onSave={() => {
      update((d) => mapBatch(d, batch.id, (b) => ({ ...b, transfer: { price: p!, at: b.transfer?.at ?? new Date().toISOString() } })))
      close()
    }}>
      <MoneyInput label="Listed on Blackwater for" value={price} onChange={setPrice} autoFocus />
      {ok && (
        <p className="t-hint">
          <Fac s={to} /> pays <Money v={p!} />. Blackwater keeps 15% (<Money v={transferLoss(p!)} />), so <Fac s={batch.side} /> gets back <Money v={p! - transferLoss(p!)} />.
        </p>
      )}
    </Dialog>
  )
}

function SaleDialog({ batch, sale, update, close }: { batch: Batch; sale?: Sale; update: Update; close: () => void }) {
  const left = unsoldQty(batch) + (sale?.qty ?? 0)
  const [qty, setQty] = useState(String(sale?.qty ?? left))
  const [rec, setRec] = useState(sale ? moneyText(sale.received) : '')
  const q = Number(qty), r = parseMoney(rec)
  const ok = Number.isInteger(q) && q >= 1 && q <= left && r !== null && r >= 0
  const side = other(batch.side)
  return (
    <Dialog title={`${sale ? 'Edit sale' : 'Sale'}: ${batch.item} on ${SIDE_NAME[side]}`} onClose={close} canSave={ok} onSave={() => {
      update((d) => mapBatch(d, batch.id, (b) => ({
        ...b,
        sales: sale ? b.sales.map((s) => (s.id === sale.id ? { ...s, qty: q, received: r! } : s)) : [...b.sales, { id: newId(), qty: q, received: r!, at: new Date().toISOString() }],
      })))
      close()
    }}>
      <label className="t-field"><span>Quantity sold</span>
        <input type="number" min={1} max={left} step={1} value={qty} onChange={(e) => setQty(e.target.value)} />
        <small>{left.toLocaleString()} not yet sold</small>
      </label>
      <MoneyInput label="Gold received in the mailbox" value={rec} onChange={setRec} autoFocus />
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

function BatchCard({ b, open, onDelete }: { b: Batch; open: (o: Open) => void; onDelete: () => void }) {
  const sold = soldQty(b), done = isFinished(b), to = other(b.side)
  return (
    <div className={`t-card${done ? ' t-done' : ''}`}>
      <div className="t-cardhead">
        <strong>{b.item}</strong>
        <span className="t-muted">{plural(b.qty, 'unit')} · bought on <Fac s={b.side} /> for <Money v={b.cost} /> · {when(b.at)}</span>
      </div>
      <div className="t-steps">
        {b.transfer
          ? <div>✓ Transferred to <Fac s={to} /> at <Money v={b.transfer.price} /> <span className="t-muted">(lost <Money v={transferLoss(b.transfer.price)} />) · {when(b.transfer.at)}</span></div>
          : <div className="t-muted">Not transferred yet</div>}
        {b.sales.length > 0 && (
          <div>Sold {sold.toLocaleString()} of {b.qty.toLocaleString()}: <Money v={received(b)} /> received
            {!done && <span className="t-muted"> · <Money v={tiedUp(b)} /> still in items</span>}</div>
        )}
        {(done || b.sales.length > 0) && (
          <div className={batchProfit(b) >= 0 ? 't-pos' : 't-neg'}>{done ? 'Profit' : 'Profit so far'}: <Money v={batchProfit(b)} sign /></div>
        )}
      </div>
      <div className="t-cardbtns">
        {!b.transfer && <button className="t-primary" onClick={() => open({ kind: 'transfer', batch: b })}>Transfer to {SIDE_NAME[to]}</button>}
        {b.transfer && !done && <button className="t-primary" onClick={() => open({ kind: 'sale', batch: b })}>Record sale</button>}
        <button onClick={() => open({ kind: 'purchase', batch: b })}>Edit</button>
        <button className="t-del" onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<HistoryEvent['kind'], string> = { start: 'Start', purchase: 'Purchase', transfer: 'Transfer', sale: 'Sale', adjustment: 'Adjustment' }

function HistoryTable({ doc, open, update }: { doc: TradesDoc; open: (o: Open) => void; update: Update }) {
  const ev = history(doc)
  if (!ev.length) return <p className="t-muted">Nothing recorded yet.</p>
  const del = (e: HistoryEvent) => {
    if (e.kind === 'sale' && confirm('Delete this sale?')) update((d) => mapBatch(d, e.batch!.id, (b) => ({ ...b, sales: b.sales.filter((s) => s.id !== e.sale!.id) })))
    if (e.kind === 'transfer' && confirm(e.batch!.sales.length ? 'Undo this transfer? Its sales are deleted too.' : 'Undo this transfer?')) update((d) => mapBatch(d, e.batch!.id, (b) => ({ ...b, transfer: null, sales: [] })))
    if (e.kind === 'adjustment' && confirm('Delete this adjustment?')) update((d) => ({ ...d, adjustments: d.adjustments.filter((a) => a.id !== e.adjustment!.id) }))
  }
  return (
    <table className="t-hist">
      <thead><tr><th>When</th><th>What</th><th>Details</th><th className="t-r">Alliance</th><th className="t-r">Horde</th><th /></tr></thead>
      <tbody>
        {ev.map((e, i) => (
          <tr key={i} className={e.kind === 'adjustment' ? 't-adjrow' : ''}>
            <td className="t-nowrap">{when(e.at)}</td>
            <td><span className={`t-tag t-tag-${e.kind}`}>{KIND_LABEL[e.kind]}</span></td>
            <td>
              {e.kind === 'start' && 'Starting gold'}
              {e.kind === 'purchase' && <>{e.batch!.item} · {plural(e.batch!.qty, 'unit')}</>}
              {e.kind === 'transfer' && <>{e.batch!.item} to <Fac s={other(e.batch!.side)} /> <span className="t-muted">(Blackwater kept <Money v={transferLoss(e.batch!.transfer!.price)} />)</span></>}
              {e.kind === 'sale' && <>{e.batch!.item} · {plural(e.sale!.qty, 'unit')}</>}
              {e.kind === 'adjustment' && <>“{e.adjustment!.note}”</>}
            </td>
            {(['A', 'H'] as Side[]).map((s) => <td key={s} className="t-r">{e.delta[s] !== undefined ? <Money v={e.delta[s]!} sign={e.kind !== 'start'} /> : ''}</td>)}
            <td className="t-rowbtns">
              {e.kind === 'start' && <button onClick={() => open({ kind: 'start' })}>Edit</button>}
              {e.kind === 'purchase' && <button onClick={() => open({ kind: 'purchase', batch: e.batch })}>Edit</button>}
              {e.kind === 'transfer' && <><button onClick={() => open({ kind: 'transfer', batch: e.batch! })}>Edit</button><button className="t-del" onClick={() => del(e)}>Undo</button></>}
              {e.kind === 'sale' && <><button onClick={() => open({ kind: 'sale', batch: e.batch!, sale: e.sale })}>Edit</button><button className="t-del" onClick={() => del(e)}>Delete</button></>}
              {e.kind === 'adjustment' && <><button onClick={() => open({ kind: 'adjust', adj: e.adjustment })}>Edit</button><button className="t-del" onClick={() => del(e)}>Delete</button></>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Trades() {
  const s = useTradesStore()
  const { doc, update } = s
  const [dlg, setDlg] = useState<Open | null>(null)
  const [showDone, setShowDone] = useState(false)
  const t = totals(doc)
  const openB = doc.batches.filter((b) => !isFinished(b)).reverse()
  const doneB = doc.batches.filter(isFinished).reverse()
  const close = () => setDlg(null)
  const deleteBatch = (b: Batch) => {
    if (confirm(`Delete the ${b.item} purchase${b.transfer || b.sales.length ? ', with its transfer and sales' : ''}?`)) update((d) => ({ ...d, batches: d.batches.filter((x) => x.id !== b.id) }))
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
        <div className="t-tile"><span>Tied up in items</span><b><Money v={t.tiedUp} /></b><small>{t.openBatches} open batch{t.openBatches === 1 ? '' : 'es'}, not in the total</small></div>
        <div className="t-tile"><span>Trading profit</span><b className={t.profit >= 0 ? 't-pos' : 't-neg'}><Money v={t.profit} sign /></b>
          <small title="Gold received, minus what the sold units cost, minus Blackwater's cut. Unsold items count at what you paid. Adjustments are left out.">sold units only ⓘ</small></div>
      </section>

      <div className="t-bar">
        <button className="t-primary" onClick={() => setDlg({ kind: 'purchase' })}>+ Purchase</button>
        <button onClick={() => setDlg({ kind: 'adjust' })}>Adjust balance</button>
        {doc.start.at && <button className="t-link" onClick={() => setDlg({ kind: 'start' })}>Starting gold: <Money v={doc.start.A} /> / <Money v={doc.start.H} /></button>}
      </div>

      <h2>Open batches</h2>
      {openB.length ? openB.map((b) => <BatchCard key={b.id} b={b} open={setDlg} onDelete={() => deleteBatch(b)} />) : <p className="t-muted">None. Record a purchase to start one.</p>}

      {doneB.length > 0 && (
        <>
          <h2><button className="t-link" onClick={() => setShowDone(!showDone)}>{showDone ? '▾' : '▸'} Finished batches ({doneB.length})</button></h2>
          {showDone && doneB.map((b) => <BatchCard key={b.id} b={b} open={setDlg} onDelete={() => deleteBatch(b)} />)}
        </>
      )}

      <h2>History</h2>
      <HistoryTable doc={doc} open={setDlg} update={update} />

      {dlg?.kind === 'start' && <StartDialog doc={doc} update={update} close={close} />}
      {dlg?.kind === 'purchase' && <PurchaseDialog doc={doc} batch={dlg.batch} update={update} close={close} />}
      {dlg?.kind === 'transfer' && <TransferDialog batch={dlg.batch} update={update} close={close} />}
      {dlg?.kind === 'sale' && <SaleDialog batch={dlg.batch} sale={dlg.sale} update={update} close={close} />}
      {dlg?.kind === 'adjust' && <AdjustDialog adj={dlg.adj} update={update} close={close} />}
    </div>
  )
}
