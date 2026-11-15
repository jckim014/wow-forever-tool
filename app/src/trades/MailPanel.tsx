// "From the mailbox": BavvbScan's mailbox log (mailSales.ts) applied by itself, given each character's role (Josh,
// 2026-11-14): trader purchases become cards, Blackwater sale + purchase pairs become transfers, trader sales are added
// while the faction holds the units. What can't be applied waits here: transfer halves without their other half, and
// records that need a look (Add / Dismiss).
import { useEffect, useMemo, useState } from 'react'
import { newId, type Side, type TradesDoc } from './model'
import { addRecord, dismiss, plan, setRole, sideOf, visitOk, type MailRecord, type MailVisit, type Role } from './mailSales'
import type { MailLinkState } from './mailLink'
import { Fac, Money, plural, when } from './parts'

type Update = (fn: (d: TradesDoc) => TradesDoc) => void
const iso = (t: number) => new Date(t * 1000).toISOString()

const ROLE_TEXT: Record<Role, string> = {
  trader: 'Trader: buys and sells on its own auction house',
  transfer: 'Transfer: lists on and buys from Blackwater',
  none: 'Not a trading character',
}

function VisitLine({ v, onDismiss }: { v: MailVisit; onDismiss: () => void }) {
  const side = sideOf(v.faction)
  const ok = visitOk(v)
  const goldPart = v.goldIn > 0 || v.sales > 0 || v.missing > 0
  return (
    <div className={`t-visit ${ok ? '' : 't-visit-bad'}`}>
      <span className={ok ? 't-pos' : 't-warn'}>{ok ? '✓' : '⚠'}</span>
      <span className="t-nowrap">{when(iso(v.t0))}</span>
      <span>{v.char}{side && <> (<Fac s={side} />)</>}</span>
      <span>
        {goldPart && <>
          gold <Money v={v.goldIn} sign /> = {plural(v.sales, 'sale')} <Money v={v.received} />
          {v.deposits > 0 && <> + deposits back <Money v={v.deposits} /></>}
          {v.other > 0 && <> + other mail <Money v={v.other} /></>}
          {v.unexplained > 0 && <> + <b className="t-warn">no mail accounts for <Money v={v.unexplained} /></b></>}
          {v.missing > 0 && <> · <b className="t-warn">{plural(v.missing, 'sale mail')} left without {v.missing === 1 ? 'its' : 'their'} gold</b></>}
        </>}
        {goldPart && (v.buys > 0 || v.buyMissing > 0) && ' · '}
        {v.buys > 0 && <>{plural(v.buys, 'purchase')} <Money v={v.spent} />, items arrived</>}
        {v.buyMissing > 0 && <>{v.buys > 0 && ' · '}<b className="t-warn">{plural(v.buyMissing, 'won mail')} left without {v.buyMissing === 1 ? 'its' : 'their'} items reaching the bags</b></>}
      </span>
      {!ok && <button className="t-link t-inline" onClick={onDismiss}>Dismiss</button>}
    </div>
  )
}

/** What a record is, in the words of the chain. */
function what(r: MailRecord, role: Role | undefined) {
  if (role === 'transfer') return r.kind === 'sale' ? 'Blackwater listing sold' : 'bought on Blackwater'
  return r.kind === 'sale' ? 'sold' : 'bought'
}

function RecordTable({ rows, roleOf, onAdd, onDismiss }: {
  rows: { r: MailRecord; reason?: string }[]; roleOf: (c: string) => Role | undefined
  onAdd: (r: MailRecord) => void; onDismiss: (r: MailRecord) => void
}) {
  return (
    <table className="t-hist t-mailtable">
      <thead><tr><th>When</th><th>Character</th><th>What</th><th>Item</th><th className="t-r">Quantity</th><th className="t-r">Gold</th><th /></tr></thead>
      <tbody>
        {rows.map(({ r, reason }) => {
          const side = sideOf(r.faction) as Side
          return (
            <tr key={r.id}>
              <td className="t-nowrap">{when(iso(r.t))}</td>
              <td>{r.char} (<Fac s={side} />)</td>
              <td>{what(r, roleOf(r.char))}{reason && <div className="t-warn t-small">⚠ {reason}</div>}</td>
              <td><strong>{r.item}</strong></td>
              <td className="t-r">{r.count.toLocaleString()}</td>
              <td className="t-r"><Money v={r.kind === 'buy' ? r.price : r.received} /></td>
              <td className="t-rowbtns">
                <button onClick={() => onAdd(r)} title={r.kind === 'buy' ? 'Add it as a purchase' : 'Add it as a sale'}>Add as {r.kind === 'buy' ? 'purchase' : 'sale'}</button>
                <button onClick={() => onDismiss(r)}>Dismiss</button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function MailPanel({ doc, update, link }: {
  doc: TradesDoc; update: Update
  link: { state: MailLinkState; link: () => void; unlinkAll: () => void; refresh: () => void }
}) {
  const st = link.state
  const p = useMemo(() => (st.kind === 'ok' ? plan(doc, st.log, newId) : null), [doc, st])
  const [last, setLast] = useState<{ purchases: number; transfers: number; sales: number; at: Date } | null>(null)
  const [editRoles, setEditRoles] = useState(false)

  // Apply what can be applied, once per new read or change (the records it adds are marked handled, so this settles).
  const total = p ? p.added.purchases + p.added.transfers + p.added.sales : 0
  useEffect(() => {
    if (!p || total === 0 || st.kind !== 'ok') return
    const log = st.log
    update((d) => plan(d, log, newId).doc)
    setLast({ ...p.added, at: new Date() })
  }, [p, total, st, update])

  if (st.kind === 'none') return null
  const head = (
    <div className="t-mailhead">
      <h2>From the mailbox</h2>
      <span className="t-muted t-small">
        {st.kind === 'ok' ? <>Read {st.readAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} from {plural(st.files, 'file')}</> : null}
      </span>
      <button onClick={link.refresh}>Refresh</button>
      <button className="t-link t-inline" onClick={link.link}>Link another BavvbScan.lua</button>
    </div>
  )
  if (st.kind === 'needs-permission') {
    return <section className="t-mail">{head}<button className="t-primary" onClick={link.refresh}>Allow reading BavvbScan.lua ({plural(st.files, 'file')})</button></section>
  }
  if (!p) return null

  const unset = p.chars.filter((c) => c.role === undefined)
  const roleOf = (c: string) => p.chars.find((x) => x.char === c)?.role
  const lastText = last && [
    last.purchases && plural(last.purchases, 'purchase'), last.transfers && plural(last.transfers, 'transfer'), last.sales && plural(last.sales, 'sale'),
  ].filter(Boolean).join(', ')

  return (
    <section className="t-mail">
      {head}
      {st.errors.map((e) => <p key={e} className="t-err t-small">{e}</p>)}

      {(unset.length > 0 || editRoles) ? (
        <div className="t-chars t-roles">
          <span>{unset.length ? 'What does each character do? Mail from characters without a role is ignored.' : 'Character roles:'}</span>
          {p.chars.map((c) => {
            const side = sideOf(c.faction) as Side | null
            return (
              <label key={c.char} className="t-char">
                <span>{c.char}{side && <> (<Fac s={side} />)</>}</span>
                <select value={c.role ?? ''} onChange={(e) => update((d) => setRole(d, c.char, e.target.value as Role))}>
                  {c.role === undefined && <option value="">Choose…</option>}
                  {(['trader', 'transfer', 'none'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_TEXT[r]}</option>)}
                </select>
              </label>
            )
          })}
          {unset.length === 0 && <button className="t-link t-inline" onClick={() => setEditRoles(false)}>Done</button>}
        </div>
      ) : (
        <p className="t-muted t-small">
          {p.chars.filter((c) => c.role === 'trader' || c.role === 'transfer').map((c) => `${c.char}: ${c.role}`).join(' · ')} · <button className="t-link t-inline" onClick={() => setEditRoles(true)}>change roles</button>
        </p>
      )}

      {lastText && <p className="t-added">✓ Added from the mailbox: {lastText} <span className="t-muted t-small">({last!.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}; see History)</span></p>}

      {p.visits.length > 0 && <div className="t-visits">{p.visits.map((v) => <VisitLine key={v.id} v={v} onDismiss={() => update((d) => dismiss(d, [v.id]))} />)}</div>}

      {p.waiting.length > 0 && (
        <>
          <h3 className="t-mailsub">Waiting for the other side ({p.waiting.length})</h3>
          <p className="t-muted t-small">Half of a transfer. It's added by itself once the other character collects its mail. If someone else bought your Blackwater listing, add it as a sale.</p>
          <RecordTable rows={p.waiting.map((r) => ({ r }))} roleOf={roleOf}
            onAdd={(r) => update((d) => addRecord(d, r, newId))} onDismiss={(r) => update((d) => dismiss(d, [r.id]))} />
        </>
      )}
      {p.look.length > 0 && (
        <>
          <h3 className="t-mailsub">Needs a look ({p.look.length})</h3>
          <RecordTable rows={p.look.map((l) => ({ r: l.record, reason: l.reason }))} roleOf={roleOf}
            onAdd={(r) => update((d) => addRecord(d, r, newId))} onDismiss={(r) => update((d) => dismiss(d, [r.id]))} />
        </>
      )}
      {p.waiting.length === 0 && p.look.length === 0 && unset.length === 0 && <p className="t-muted">Nothing waiting. Everything from the mailbox has been added.</p>}
    </section>
  )
}
