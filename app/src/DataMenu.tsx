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

/** A menu entry; `pick` says what to choose in the picker, `now` what is linked at the moment. */
function Item({ label, pick, now, title, disabled, onClick }: {
  label: string; pick?: string; now?: string | null; title?: string; disabled?: boolean; onClick: () => void
}) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick} title={title}>
      {label}
      {pick && <span className="mi-sub">Pick: {pick}</span>}
      {pick && <span className="mi-sub">{now ? <>Now: <b>{now}</b></> : 'Not linked'}</span>}
    </button>
  )
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

export function DataMenu({ store, onMessage, onImportPrices, onPastePrices, link, history, auctionData, gameFolder }: {
  store: Store
  onMessage: (m: string) => void
  onImportPrices: (f: File) => void
  onPastePrices: () => void
  link: { supported: boolean; file: string | null; onLink: () => void; onUnlink: () => void }
  history: { supported: boolean; folder: string | null; onChoose: () => void; onStop: () => void }
  auctionData: { supported: boolean; folder: string | null; onChoose: () => void; onStop: () => void }
  gameFolder: { supported: boolean; folder: string | null; onLink: () => void; onUnlink: () => void }
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
            <div className="menu-head">Prices</div>
            <Item disabled={!link.supported} onClick={act(link.onLink)}
              label={link.file ? 'Link a different scan file…' : 'Link scan file…'}
              pick="WTF\Account\<account>\SavedVariables\BavvbScan.lua"
              now={link.file} title="BavvbScan.lua of the account you last scanned on (your /bscan scans). Re-read when the app opens and on Refresh now." />
            {link.file && <Item onClick={act(link.onUnlink)} label="Stop using the scan file" />}
            <Item disabled={!auctionData.supported} onClick={act(auctionData.onChoose)}
              label={auctionData.folder ? 'Change auction data folder…' : 'Link auction data folder…'}
              pick="F:\ForeverAuctionData" now={auctionData.folder}
              title="Hourly API prices from the collector. Per item, the newer of these and your scan is used." />
            {auctionData.folder && <Item onClick={act(auctionData.onStop)} label="Stop using API prices" />}
            <Item onClick={act(() => priceInput.current?.click())} label="Import a scan file once…"
              title="Reads BavvbScan.lua (or a .zip of it) once, without linking it. Dropping it on the page does the same." />
            <Item onClick={act(onPastePrices)} label="Paste prices…" title="Item ID, name and three price columns, from any other source" />
            {!link.supported && <p className="menu-note">Linking files and folders needs Chrome or Edge.</p>}
            <hr />
            <div className="menu-head">Archive and game</div>
            <Item disabled={!history.supported} onClick={act(history.onChoose)}
              label={history.folder ? 'Change price history folder…' : 'Keep price history in a folder…'}
              pick="wow-forever-shuffle\data\private\price-history" now={history.folder}
              title="Every scan you import is saved here: the whole scan, zipped, and a per-item summary" />
            {history.folder && <Item onClick={act(history.onStop)} label="Stop keeping price history" />}
            <Item disabled={!gameFolder.supported} onClick={act(gameFolder.onLink)}
              label={gameFolder.folder ? 'Change game addon folder…' : 'Link game addon folder…'}
              pick="_forever_\Interface\AddOns\BavvbScan" now={gameFolder.folder}
              title="Your favorites go there as Favorites.lua for the in-game panel, again whenever they change" />
            {gameFolder.folder && <Item onClick={act(gameFolder.onUnlink)} label="Stop sending favorites to the game" />}
            <hr />
            <div className="menu-head">Your edits</div>
            <Item disabled={!fileApi} onClick={act(store.openSaveFile)} label="Open save file…"
              pick="wow-forever-shuffle\data\private\shuffle-edits.json"
              now={connected && 'file' in store.status ? store.status.file : null}
              title="Custom prices, settings, favorites and the rest, saved on every change" />
            <Item disabled={!fileApi} onClick={act(store.createSaveFile)} label="Create save file…" />
            <Item disabled={!connected} onClick={act(store.disconnect)} label="Stop saving to file" />
            <Item onClick={act(() => fileInput.current?.click())} label="Import edits file…" />
            <Item onClick={act(store.exportFile)} label="Export edits (backup)" />
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
