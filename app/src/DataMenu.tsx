import { useEffect, useRef, useState } from 'react'
import type { SaveStatus, useEditsStore } from './storage/useEditsStore'

type Store = ReturnType<typeof useEditsStore>

const time = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function StatusLine({ status, localOk, onReconnect }: { status: SaveStatus; localOk: boolean; onReconnect: () => void }) {
  const browserWarning = !localOk && <span className="status bad">This browser refused to keep a copy.</span>
  switch (status.kind) {
    case 'loading':
      return <span className="status">Loading your edits…</span>
    case 'browser-only':
      return (
        <>
          <span className="status warn" title={status.fileApi ? 'Use File > Create save file or Open save file.' : 'Use Export now and then to keep a backup.'}>
            {status.fileApi ? 'Saved in this browser only: choose a save file' : 'Saved in this browser only (no file saving in this browser)'}
          </span>
          {browserWarning}
        </>
      )
    case 'needs-permission':
      return (
        <button className="status warn link" onClick={onReconnect} title="The browser asks again for access to the save file on each visit unless you choose Allow on every visit.">
          Reconnect to {status.file}
        </button>
      )
    case 'saving':
      return <span className="status">Saving to {status.file}…</span>
    case 'saved':
      return (
        <>
          <span className="status ok" title={status.at ? `Last change saved ${time(status.at)}` : undefined}>Saved to {status.file}</span>
          {browserWarning}
        </>
      )
    case 'error':
      return <span className="status bad">{status.message}</span>
  }
}

/** Edits files (.json), from the menu or dropped on the page. */
export async function importEditsFile(store: Store, file: File, onMessage: (m: string) => void) {
  try {
    const warnings = await store.importFile(file)
    if (warnings === null) return
    onMessage(`Imported ${file.name}` + (warnings.length ? ` with ${warnings.length} warning(s): ${warnings.slice(0, 3).join('; ')}` : ''))
  } catch (e) {
    onMessage(`Could not import ${file.name}: ${(e as Error).message}`)
  }
}

export function DataMenu({ store, onMessage, onImportPrices, onPastePrices, link, history }: {
  store: Store
  onMessage: (m: string) => void
  onImportPrices: (f: File) => void
  onPastePrices: () => void
  link: { supported: boolean; file: string | null; onLink: () => void; onUnlink: () => void }
  history: { supported: boolean; folder: string | null; onChoose: () => void; onStop: () => void }
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const priceInput = useRef<HTMLInputElement>(null)
  const connected = store.status.kind === 'saved' || store.status.kind === 'saving' || store.status.kind === 'needs-permission' ||
    (store.status.kind === 'error' && store.status.file !== null)
  const fileApi = !(store.status.kind === 'browser-only' && !store.status.fileApi)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const act = (fn: () => unknown) => () => {
    setOpen(false)
    fn()
  }

  const onImport = (file: File) => importEditsFile(store, file, onMessage)

  return (
    <div className="data">
      <StatusLine status={store.status} localOk={store.localOk} onReconnect={store.reconnect} />
      <div className="menu" ref={ref}>
        <button className="button" onClick={() => setOpen(!open)} aria-expanded={open}>File ▾</button>
        {open && (
          <div className="menu-panel" role="menu">
            <button role="menuitem" onClick={act(() => priceInput.current?.click())}>Import price file…</button>
            <button role="menuitem" onClick={act(onPastePrices)}>Paste prices…</button>
            <button role="menuitem" disabled={!link.supported} onClick={act(link.onLink)}
              title="Pick Auc-ScanData.lua (Auctioneer) or Auctionator.lua once; the app re-reads it when it opens and on Refresh now">
              {link.file ? 'Link a different price file…' : 'Link price file…'}
            </button>
            {link.file && <button role="menuitem" onClick={act(link.onUnlink)}>Unlink {link.file}</button>}
            {!link.supported && <p className="menu-note">Linking a file needs Chrome or Edge.</p>}
            <button role="menuitem" disabled={!history.supported} onClick={act(history.onChoose)}
              title="Every Auctioneer scan you import is saved in this folder: the whole scan, zipped, and a per-item summary">
              {history.folder ? 'Change price history folder…' : 'Keep price history in a folder…'}
            </button>
            {history.folder && <button role="menuitem" onClick={act(history.onStop)}>Stop keeping price history</button>}
            <hr />
            <button role="menuitem" onClick={act(() => fileInput.current?.click())}>Import edits file…</button>
            <button role="menuitem" onClick={act(store.exportFile)}>Export edits (backup)</button>
            <hr />
            <button role="menuitem" disabled={!fileApi} onClick={act(store.createSaveFile)}>Create save file…</button>
            <button role="menuitem" disabled={!fileApi} onClick={act(store.openSaveFile)}>Open save file…</button>
            <button role="menuitem" disabled={!connected} onClick={act(store.disconnect)}>Stop saving to file</button>
            {!fileApi && <p className="menu-note">Saving to a file needs Chrome or Edge.</p>}
          </div>
        )}
      </div>
      <input
        ref={fileInput} type="file" accept=".json,application/json" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onImport(f)
        }}
      />
      <input
        ref={priceInput} type="file" accept=".zip,.lua,.csv,.tsv,.txt" hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onImportPrices(f)
        }}
      />
    </div>
  )
}
