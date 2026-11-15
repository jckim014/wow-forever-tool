// "Sales from the mailbox": suggestions from BavvbScan's sales log (mailSales.ts), ticked by default where the
// tracker holds the item; Josh checks them and adds them as sale entries.
import { useEffect, useMemo, useState } from 'react'
import { newId, type Side, type TradesDoc } from './model'
import { addSales, dismiss, setChars, sideOf, suggestions, visitOk, type MailRecord, type MailVisit, type Suggestion } from './mailSales'
import type { MailLinkState } from './mailLink'
import { Fac, Money, plural, when } from './parts'

type Update = (fn: (d: TradesDoc) => TradesDoc) => void
const iso = (t: number) => new Date(t * 1000).toISOString()

function VisitLine({ v, onDismiss }: { v: MailVisit; onDismiss: () => void }) {
  const side = sideOf(v.faction)
  const ok = visitOk(v)
  return (
    <div className={`t-visit ${ok ? '' : 't-visit-bad'}`}>
      <span className={ok ? 't-pos' : 't-warn'}>{ok ? '✓' : '⚠'}</span>
      <span className="t-nowrap">{when(iso(v.t0))}</span>
      <span>{v.char}{side && <> (<Fac s={side} />)</>}</span>
      <span>
        gold <Money v={v.goldIn} sign /> = {plural(v.sales, 'sale')} <Money v={v.received} />
        {v.deposits > 0 && <> + deposits back <Money v={v.deposits} /></>}
        {v.other > 0 && <> + other mail <Money v={v.other} /></>}
        {v.unexplained > 0 && <> + <b className="t-warn">no mail accounts for <Money v={v.unexplained} /></b></>}
        {v.missing > 0 && <> · <b className="t-warn">{plural(v.missing, 'sale mail')} left without {v.missing === 1 ? 'its' : 'their'} gold</b></>}
      </span>
      {!ok && <button className="t-link t-inline" onClick={onDismiss}>Dismiss</button>}
    </div>
  )
}

function GroupRows({ g, ticked, toggle, onDismiss }: {
  g: Suggestion; ticked: Set<string>; toggle: (ids: string[], on: boolean) => void; onDismiss: () => void
}) {
  const [open, setOpen] = useState(false)
  const on = g.records.filter((r) => ticked.has(r.id))
  const all = on.length === g.records.length, none = on.length === 0
  const units = on.reduce((n, r) => n + r.count, 0)
  const unitsAll = g.records.reduce((n, r) => n + r.count, 0)
  const flagged = g.records.some((r) => r.status !== 'ok') || unitsAll > g.held
  return (
    <>
      <tr className={none ? 't-off' : ''}>
        <td><input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = !all && !none }} onChange={() => toggle(g.records.map((r) => r.id), !all)} /></td>
        <td><strong>{g.item}</strong></td>
        <td><Fac s={g.side} /></td>
        <td className="t-r">{none ? plural(unitsAll, 'unit') : units === unitsAll ? plural(units, 'unit') : `${units} of ${plural(unitsAll, 'unit')}`}</td>
        <td className="t-r"><Money v={(none ? g.records : on).reduce((n, r) => n + r.received, 0)} /></td>
        <td className={`t-r ${unitsAll > g.held ? 't-warn' : 't-muted'}`}>{g.tracked ? `holds ${g.held}` : ''}</td>
        <td className="t-rowbtns">
          <button className="t-link t-inline" onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} {plural(g.records.length, 'sale')}{flagged && !open ? ' ⚠' : ''}</button>
          <button onClick={onDismiss}>Dismiss</button>
        </td>
      </tr>
      {open && g.records.map((r) => <RecordRow key={r.id} r={r} on={ticked.has(r.id)} toggle={(v) => toggle([r.id], v)} />)}
    </>
  )
}

function RecordRow({ r, on, toggle }: { r: MailRecord; on: boolean; toggle: (on: boolean) => void }) {
  return (
    <tr className={`t-sub ${on ? '' : 't-off'}`}>
      <td><input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} /></td>
      <td className="t-nowrap" colSpan={2}>{when(iso(r.t))} · {r.char}</td>
      <td className="t-r">{plural(r.count, 'unit')}</td>
      <td className="t-r"><Money v={r.received} /></td>
      <td colSpan={2} className="t-small">
        {r.status !== 'ok' && <span className="t-warn">⚠ the mail went but no matching gold came</span>}
        {r.src === 'subject' && <span className="t-warn">⚠ deposit unknown: amount is the whole mail</span>}
      </td>
    </tr>
  )
}

export function MailPanel({ doc, update, link }: {
  doc: TradesDoc; update: Update
  link: { state: MailLinkState; link: () => void; unlinkAll: () => void; refresh: () => void }
}) {
  const st = link.state
  const s = useMemo(() => (st.kind === 'ok' ? suggestions(doc, st.log) : null), [doc, st])
  const defaults = useMemo(() => new Set(s ? [...s.tracked, ...s.other].flatMap((g) => g.ticked) : []), [s])
  const [ticked, setTicked] = useState(defaults)
  useEffect(() => setTicked(defaults), [defaults])
  const [showOther, setShowOther] = useState(false)
  const [editChars, setEditChars] = useState(false)

  if (st.kind === 'none') return null
  const head = (
    <div className="t-mailhead">
      <h2>Sales from the mailbox</h2>
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
  if (!s) return null

  const chosen = new Set(doc.mail?.chars ?? [])
  const toggle = (ids: string[], on: boolean) => setTicked((t) => {
    const n = new Set(t)
    for (const id of ids) if (on) n.add(id); else n.delete(id)
    return n
  })
  const groups = [...s.tracked, ...s.other]
  const nAdd = groups.filter((g) => g.records.some((r) => ticked.has(r.id))).length
  const rows = (gs: Suggestion[]) => gs.map((g) => (
    <GroupRows key={g.key} g={g} ticked={ticked} toggle={toggle} onDismiss={() => update((d) => dismiss(d, g.records.map((r) => r.id)))} />
  ))
  const table = (gs: Suggestion[]) => (
    <table className="t-hist t-mailtable">
      <thead><tr><th /><th>Item</th><th>Sold on</th><th className="t-r">Quantity</th><th className="t-r">Received</th><th className="t-r">In stock</th><th /></tr></thead>
      <tbody>{rows(gs)}</tbody>
    </table>
  )

  return (
    <section className="t-mail">
      {head}
      {st.errors.map((e) => <p key={e} className="t-err t-small">{e}</p>)}

      {(chosen.size === 0 || editChars) ? (
        <div className="t-chars">
          <span>{chosen.size === 0 ? 'Which characters make your trade sales? Sales by other characters are ignored.' : 'Trading characters:'}</span>
          {s.chars.length === 0 && <span className="t-muted">No sales recorded yet. Collect auction money at a mailbox, then /reload and Refresh.</span>}
          {s.chars.map((c) => {
            const side = sideOf(c.faction) as Side | null
            return (
              <label key={c.char} className="t-char">
                <input type="checkbox" checked={chosen.has(c.char)} onChange={(e) => {
                  const next = e.target.checked ? [...chosen, c.char] : [...chosen].filter((x) => x !== c.char)
                  update((d) => setChars(d, next))
                }} /><span>{c.char}{side && <> (<Fac s={side} />)</>}</span>
              </label>
            )
          })}
          {chosen.size > 0 && <button className="t-link t-inline" onClick={() => setEditChars(false)}>Done</button>}
        </div>
      ) : (
        <p className="t-muted t-small">Trading characters: {[...chosen].join(', ')} · <button className="t-link t-inline" onClick={() => setEditChars(true)}>change</button></p>
      )}

      {s.visits.length > 0 && <div className="t-visits">{s.visits.map((v) => <VisitLine key={v.id} v={v} onDismiss={() => update((d) => dismiss(d, [v.id]))} />)}</div>}

      {chosen.size > 0 && (s.tracked.length ? table(s.tracked) : <p className="t-muted">No new sales of items in your tracker.</p>)}
      {s.other.length > 0 && (
        <>
          <p><button className="t-link" onClick={() => setShowOther(!showOther)}>{showOther ? '▾' : '▸'} Not in your tracker ({s.other.length})</button></p>
          {showOther && table(s.other)}
        </>
      )}
      {chosen.size > 0 && groups.length > 0 && (
        <div className="t-bar">
          <button className="t-primary" disabled={!nAdd} onClick={() => update((d) => addSales(d, groups, ticked, newId))}>
            Add {nAdd ? plural(nAdd, 'sale') : 'sales'}
          </button>
          <span className="t-muted t-small">Ticked sales are added as one sale per item and faction. Unticked ones stay here for later; Dismiss hides them for good.</span>
        </div>
      )}
    </section>
  )
}
