import { useEffect, useRef, useState } from 'react'
import type { ImportRow } from './model'
import { auctionatorBytes, HISTORY_DAYS, priceDatabaseRealms, pricesFromRealm } from './prices/auctionator'
import { parsePriceTable } from './prices/csv'
import type { useEditsStore } from './storage/useEditsStore'

type Store = ReturnType<typeof useEditsStore>

const isPriceTable = (name: string) => /\.(csv|tsv|txt)$/i.test(name)
const isAuctionator = (name: string) => /\.(zip|lua)$/i.test(name)
const n = (x: number) => x.toLocaleString()
export const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`

/** Auctionator zip / price CSV imports: they replace the imported prices and leave every other edit alone. */
export function usePriceImport(store: Store, onMessage: (m: string) => void) {
  const [realmChoice, setRealmChoice] = useState<{ file: string; realms: Map<string, Uint8Array> } | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)

  function apply(rows: ImportRow[], source: string, detail: string) {
    if (!rows.length) {
      onMessage(`${source}: no prices found; nothing was changed.`)
      return
    }
    const before = store.edits.imports.length
    store.update((cur) => ({ ...cur, imports: rows, importsInfo: { source, at: new Date().toISOString(), count: rows.length } }))
    onMessage(`Imported ${plural(rows.length, 'price')} from ${source}${detail}.` + (before ? ` They replace the previous ${plural(before, 'imported price')}.` : ''))
  }

  function applyRealm(file: string, realm: string, data: Uint8Array) {
    setRealmChoice(null)
    try {
      const r = pricesFromRealm(data)
      apply(r.rows, `Auctionator (${realm})`,
        `: ${plural(r.scanDays, 'scan day')} of history (prices 2 and 3 use the last ${HISTORY_DAYS}), ${plural(r.skipped, 'non-item entry', 'non-item entries')} skipped`)
    } catch (e) {
      onMessage(`Could not read ${file}: ${(e as Error).message}`)
    }
  }

  async function importFile(file: File) {
    try {
      if (isPriceTable(file.name)) {
        const r = parsePriceTable(await file.text())
        apply(r.rows, file.name, r.warnings.length ? `; ${plural(r.warnings.length, 'line')} skipped or blanked: ${r.warnings.slice(0, 2).join('; ')}` : '')
        return
      }
      if (!isAuctionator(file.name)) {
        onMessage(`${file.name}: expected Auctionator.zip (or Auctionator.lua), or a .csv of prices.`)
        return
      }
      const realms = priceDatabaseRealms(auctionatorBytes(file.name, new Uint8Array(await file.arrayBuffer())))
      if (realms.size === 1) {
        const [[realm, data]] = [...realms]
        applyRealm(file.name, realm, data)
      } else setRealmChoice({ file: file.name, realms })
    } catch (e) {
      onMessage(`Could not read ${file.name}: ${(e as Error).message}`)
    }
  }

  const dialogs = (
    <>
      {realmChoice && (
        <Modal title="Which realm's prices?" onClose={() => setRealmChoice(null)}>
          <p>{realmChoice.file} has prices for several realms. Pick one:</p>
          <div className="choices">
            {[...realmChoice.realms].map(([realm, data]) => (
              <button key={realm} className="button" onClick={() => applyRealm(realmChoice.file, realm, data)}>{realm}</button>
            ))}
          </div>
        </Modal>
      )}
      {pasteOpen && (
        <PasteDialog
          onClose={() => setPasteOpen(false)}
          onImport={(rows, warnings) => {
            setPasteOpen(false)
            apply(rows, 'a paste', warnings.length ? `; ${plural(warnings.length, 'line')} skipped or blanked` : '')
          }}
        />
      )}
    </>
  )

  return { importFile, openPaste: () => setPasteOpen(true), dialogs }
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

function PasteDialog({ onClose, onImport }: { onClose: () => void; onImport: (rows: ImportRow[], warnings: string[]) => void }) {
  const [text, setText] = useState('')
  const parsed = parsePriceTable(text)
  return (
    <Modal title="Paste prices" onClose={onClose}>
      <p>
        One item per line: <b>item ID, name (optional), price 1, price 2, price 3</b>, in copper. Paste from a spreadsheet
        or a CSV; a header row is fine. This replaces all imported prices.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder={'2589\tLinen Cloth\t120\t110\t100'} autoFocus />
      <p className="muted">
        {plural(parsed.rows.length, 'item')} read
        {parsed.warnings.length > 0 && `; ${plural(parsed.warnings.length, 'problem')}: ${parsed.warnings.slice(0, 3).join('; ')}`}
      </p>
      <div className="choices">
        <button className="button primary" disabled={!parsed.rows.length} onClick={() => onImport(parsed.rows, parsed.warnings)}>Import</button>
        <button className="button" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  )
}

/** Shows an overlay while files are dragged over the page, and hands dropped files over. */
export function usePageDrop(onFile: (f: File) => void) {
  const [dragging, setDragging] = useState(false)
  const handler = useRef(onFile)
  handler.current = onFile
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true) } }
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false) } }
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      const f = e.dataTransfer?.files[0]
      if (f) handler.current(f)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return dragging
}
