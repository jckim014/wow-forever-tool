import { useEffect, useRef, useState } from 'react'
import type { ImportRow } from './model'
import { auctionatorBytes, HISTORY_DAYS, priceDatabaseRealms, pricesFromRealm } from './prices/auctionator'
import { bavvbScanBytes, isBavvbScan, readBavvbScan } from './prices/bavvbscan'
import { auctioneerBytes, isAuctioneerScan, pricesFromScan, scanServers, type AuctioneerResult } from './prices/auctioneer'
import { scanSummary } from './history/archive'
import type { PendingScan } from './history/folder'
import { parsePriceTable } from './prices/csv'
import {
  canRead, forgetLink, linkSupported, loadLink, pickAuctionator, saveLink, shouldImport, type LinkRecord, type ReadHandle,
} from './prices/linked'
import type { useEditsStore } from './storage/useEditsStore'

type Store = ReturnType<typeof useEditsStore>

const isPriceTable = (name: string) => /\.(csv|tsv|txt)$/i.test(name)
const isSavedVariables = (name: string) => /\.(zip|lua)$/i.test(name)
const n = (x: number) => x.toLocaleString()
export const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`

type Origin = { link: LinkRecord; modified: number } | null
type RealmChoice = { file: string; realms: string[]; pick: (realm: string) => void; remembered: boolean }

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * BavvbScan / Auctioneer / Auctionator SavedVariables and price CSV imports: they replace the imported prices and leave every
 * other edit alone. Also the linked file (BavvbScan.lua, Auc-ScanData.lua or Auctionator.lua): checked when the app opens (imported if WoW has written it since) and on Refresh now.
 */
export function usePriceImport(store: Store, onMessage: (m: string) => void, onScan: (scans: PendingScan[]) => void) {
  const [realmChoice, setRealmChoice] = useState<RealmChoice | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [link, setLinkState] = useState<LinkRecord | null>(null)
  const [needsPermission, setNeedsPermission] = useState(false)
  const linkRef = useRef<LinkRecord | null>(null)
  const editsRef = useRef(store.edits)
  editsRef.current = store.edits
  const checkedOnOpen = useRef(false)

  const setLink = (r: LinkRecord | null) => {
    linkRef.current = r
    setLinkState(r)
  }

  /** Returns the new importsInfo.at, or null if nothing was imported. */
  function apply(rows: ImportRow[], source: string, detail: string): string | null {
    if (!rows.length) {
      onMessage(`${source}: no prices found; nothing was changed.`)
      return null
    }
    const before = editsRef.current.imports.length
    const at = new Date().toISOString()
    store.update((cur) => ({ ...cur, imports: rows, importsInfo: { source, at, count: rows.length } }))
    onMessage(`Imported ${plural(rows.length, 'price')} from ${source}${detail}.` + (before ? ` They replace the previous ${plural(before, 'imported price')}.` : ''))
    return at
  }

  /** Imports one realm's prices (`read` does the work) and, for the linked file, remembers what was imported. */
  function applyRealm(file: string, realm: string, origin: Origin, read: () => { rows: ImportRow[]; source: string; detail: string }) {
    setRealmChoice(null)
    try {
      const r = read()
      const from = origin ? ` (linked ${file}, written by WoW ${when(origin.modified)})` : ''
      const at = apply(r.rows, r.source, `${from}: ${r.detail}`)
      if (origin && at) {
        const rec = { ...origin.link, realm, importedModified: origin.modified, importedAt: at }
        if (linkRef.current?.handle === origin.link.handle) setLink(rec)
        saveLink(rec)
      }
    } catch (e) {
      onMessage(`Could not read ${file}: ${(e as Error).message}`)
    }
  }

  /** Imports straight away when there is one realm (or the linked file's remembered one), else asks which. */
  function chooseRealm<T>(file: string, realms: Map<string, T>, origin: Origin, read: (data: T, realm: string) => { rows: ImportRow[]; source: string; detail: string }) {
    const go = (realm: string) => applyRealm(file, realm, origin, () => read(realms.get(realm)!, realm))
    const remembered = origin?.link.realm
    if (remembered && realms.has(remembered)) go(remembered)
    else if (realms.size === 1) go([...realms.keys()][0])
    else setRealmChoice({ file, realms: [...realms.keys()], pick: go, remembered: !!origin })
  }

  /** BavvbScan.lua, Auc-ScanData.lua, Auctionator.lua, or a .zip of one: recognised by what is inside. */
  function importSavedVariables(name: string, bytes: Uint8Array, origin: Origin) {
    const zipped = bytes[0] === 0x50 && bytes[1] === 0x4b
    const raw = zipped
      ? (() => {
        try { return bavvbScanBytes(name, bytes) } catch { /* not a BavvbScan zip */ }
        try { return auctioneerBytes(name, bytes) } catch { /* not an Auctioneer zip */ }
        try { return auctionatorBytes(name, bytes) } catch { throw new Error(`No BavvbScan.lua, Auc-ScanData.lua or Auctionator.lua inside ${name}.`) }
      })()
      : bytes
    if (isBavvbScan(raw)) {
      const s = readBavvbScan(raw)
      const r = s.result
      chooseRealm(name, new Map([[s.server, s]]), origin, () => ({
        rows: r.rows, source: `BavvbScan (${s.server})`,
        detail: `${plural(r.listings, 'auction')} from the scan of ${when(s.scanTime * 1000)}`
          + (r.noBuyout ? `, ${plural(r.noBuyout, 'bid-only listing')} left out` : '')
          + (s.skipped ? `, ${plural(s.skipped, 'unreadable listing')} skipped by the addon` : ''),
      }))
      onScan([{ ...scanSummary(s.server, s.scanTime, r, new Date(), 'BavvbScan'), raw, rawName: 'BavvbScan.lua' }])
      return
    }
    if (isAuctioneerScan(raw)) {
      const servers = scanServers(raw)
      const results = new Map<string, AuctioneerResult>()
      const resultOf = (key: string) => {
        if (!results.has(key)) results.set(key, pricesFromScan(servers.get(key)!.ropes))
        return results.get(key)!
      }
      chooseRealm(name, servers, origin, (_scan, realm) => {
        const r = resultOf(realm)
        return {
          rows: r.rows, source: `Auctioneer (${realm})`,
          detail: `${plural(r.listings, 'listing')} from the last scan` + (r.noBuyout ? `, ${plural(r.noBuyout, 'bid-only listing')} left out` : ''),
        }
      })
      // Every realm's scan in the file goes to the price history, whichever realm's prices are used.
      const now = new Date()
      onScan([...servers].map(([key, scan]) => ({ ...scanSummary(key, scan.scanTime, resultOf(key), now, 'Auctioneer'), raw, rawName: 'Auc-ScanData.lua' })))
      return
    }
    chooseRealm(name, priceDatabaseRealms(auctionatorBytes(name, raw)), origin, (data, realm) => {
      const r = pricesFromRealm(data)
      return {
        rows: r.rows, source: `Auctionator (${realm})`,
        detail: `${plural(r.scanDays, 'scan day')} of history (prices 2 and 3 use the last ${HISTORY_DAYS}), ${plural(r.skipped, 'non-item entry', 'non-item entries')} skipped`,
      }
    })
  }

  /** Read the linked file and import it if needed. `ask` (from a click) lets the browser prompt for access. */
  const check = async (mode: 'open' | 'refresh', ask: boolean) => {
    const l = linkRef.current
    if (!l) return
    const name = l.handle.name
    try {
      if (!(await canRead(l.handle, ask))) {
        setNeedsPermission(true)
        if (ask) onMessage(`Reading ${name} was not allowed, so prices were not refreshed.`)
        return
      }
      setNeedsPermission(false)
      const f = await l.handle.getFile()
      if (!shouldImport(l, f.lastModified, editsRef.current.importsInfo?.at ?? null, mode)) {
        if (mode === 'refresh') {
          onMessage(`${name} has not changed since it was imported (last written by WoW ${when(f.lastModified)}). WoW writes it on /reload, logout or exit.`)
        }
        return
      }
      importSavedVariables(f.name, new Uint8Array(await f.arrayBuffer()), { link: l, modified: f.lastModified })
    } catch (e) {
      const notFound = e instanceof DOMException && e.name === 'NotFoundError'
      onMessage(notFound
        ? `The linked ${name} was not found (moved or deleted?). Link it again from the File menu.`
        : `Could not read the linked ${name}: ${(e as Error).message}`)
    }
  }
  const checkRef = useRef(check)
  checkRef.current = check

  // On open: once the edits have loaded (so an import isn't overwritten by them), check the linked file.
  const loaded = store.status.kind !== 'loading'
  useEffect(() => {
    if (!loaded || checkedOnOpen.current) return
    checkedOnOpen.current = true
    loadLink().then((l) => {
      if (!l) return
      setLink(l)
      return checkRef.current('open', false)
    })
  }, [loaded])

  /** File menu: pick the Auctionator.lua to link, and import it straight away. */
  async function linkFile() {
    let h: ReadHandle
    try {
      h = await pickAuctionator()
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) onMessage(`Could not link the file: ${(e as Error).message}`)
      return
    }
    const rec: LinkRecord = { handle: h, realm: null, importedModified: null, importedAt: null }
    setLink(rec)
    await saveLink(rec)
    await check('refresh', true)
  }

  async function unlinkFile() {
    const name = linkRef.current?.handle.name
    setLink(null)
    setNeedsPermission(false)
    await forgetLink()
    if (name) onMessage(`Unlinked ${name}. The imported prices stay; the file itself is not changed.`)
  }

  const linked = link && { file: link.handle.name, needsPermission, refresh: () => check('refresh', true) }

  async function importFile(file: File) {
    try {
      if (isPriceTable(file.name)) {
        const r = parsePriceTable(await file.text())
        apply(r.rows, file.name, r.warnings.length ? `; ${plural(r.warnings.length, 'line')} skipped or blanked: ${r.warnings.slice(0, 2).join('; ')}` : '')
        return
      }
      if (!isSavedVariables(file.name)) {
        onMessage(`${file.name}: expected BavvbScan.lua, Auc-ScanData.lua or Auctionator.lua (or a .zip of one), or a .csv of prices.`)
        return
      }
      importSavedVariables(file.name, new Uint8Array(await file.arrayBuffer()), null)
    } catch (e) {
      onMessage(`Could not read ${file.name}: ${(e as Error).message}`)
    }
  }

  const dialogs = (
    <>
      {realmChoice && (
        <Modal title="Which realm's prices?" onClose={() => setRealmChoice(null)}>
          <p>
            {realmChoice.file} has prices for several realms. Pick one{realmChoice.remembered ? ' (remembered for this linked file)' : ''}:
          </p>
          <div className="choices">
            {realmChoice.realms.map((realm) => (
              <button key={realm} className="button" onClick={() => realmChoice.pick(realm)}>{realm}</button>
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

  return {
    importFile, openPaste: () => setPasteOpen(true), dialogs,
    linked, linkFile, unlinkFile, linkSupported: linkSupported(),
  }
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
