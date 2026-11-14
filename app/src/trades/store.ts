// Saving for the trade tracker, the same way as the shuffle app's edits: a file on Josh's disk (File System Access
// API, handle kept in IndexedDB) is the primary store, auto-saved on every change; the browser copy (localStorage)
// is the cache and fallback. On start the newer savedAt wins. A file that isn't a trades file is never overwritten.
// Separate keys from the shuffle app, so the two never touch each other's data.
import { useCallback, useEffect, useRef, useState } from 'react'
import { idbDelete, idbGet, idbSet } from '../storage/idb'
import { fileApiSupported, hasPermission, isAbort, readHandle, writeHandle, type FileHandle } from '../storage/fileStore'
import { emptyDoc, parseTradesDoc, type TradesDoc } from './model'

const LOCAL_KEY = 'wow-forever-shuffle:trades:v1'
const HANDLE_KEY = 'tradesFile'
const TYPES = [{ description: 'Trades', accept: { 'application/json': ['.json'] } }]

export type TradesStatus =
  | { kind: 'loading' }
  | { kind: 'browser-only'; fileApi: boolean }
  | { kind: 'needs-permission'; file: string }
  | { kind: 'saving'; file: string }
  | { kind: 'saved'; file: string }
  | { kind: 'error'; message: string }

const text = (d: TradesDoc) => JSON.stringify(d, null, 1) + '\n'
function readLocal(): TradesDoc | null {
  try {
    const t = localStorage.getItem(LOCAL_KEY)
    return t ? parseTradesDoc(t) : null
  } catch {
    return null
  }
}
function writeLocal(d: TradesDoc) {
  try { localStorage.setItem(LOCAL_KEY, text(d)) } catch { /* the file is still written */ }
}
interface Picker { showOpenFilePicker(o: object): Promise<FileHandle[]>; showSaveFilePicker(o: object): Promise<FileHandle> }
const picker = () => window as unknown as Picker

export function useTradesStore() {
  const [doc, setDoc] = useState<TradesDoc>(() => readLocal() ?? emptyDoc())
  const [status, setStatus] = useState<TradesStatus>({ kind: 'loading' })
  const current = useRef(doc)
  const handle = useRef<FileHandle | null>(null)
  const connected = useRef(false)
  const started = useRef(false)

  const writeFile = useCallback(async (h: FileHandle) => {
    setStatus({ kind: 'saving', file: h.name })
    try {
      await writeHandle(h, text(current.current))
      setStatus({ kind: 'saved', file: h.name })
    } catch (e) {
      setStatus({ kind: 'error', message: `Could not save to ${h.name}: ${(e as Error).message}. Your trades are kept in this browser.` })
    }
  }, [])

  const adopt = (d: TradesDoc) => { current.current = d; setDoc(d); writeLocal(d) }

  /** Reconcile with the file (permission granted): the newer one wins. */
  const sync = useCallback(async (h: FileHandle) => {
    let t: string
    try { t = await readHandle(h) } catch (e) {
      setStatus({ kind: 'error', message: `Could not read ${h.name}: ${(e as Error).message}` }); return
    }
    connected.current = true
    if (!t.trim()) return writeFile(h)
    let d: TradesDoc
    try { d = parseTradesDoc(t) } catch {
      connected.current = false
      setStatus({ kind: 'error', message: `${h.name} is not a trades file. It was not changed; choose another file.` }); return
    }
    const mine = current.current.savedAt
    if (!d.savedAt || !mine || d.savedAt >= mine) { adopt(d); setStatus({ kind: 'saved', file: h.name }) }
    else await writeFile(h)
  }, [writeFile])

  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      if (!fileApiSupported()) return setStatus({ kind: 'browser-only', fileApi: false })
      let h: FileHandle | undefined
      try { h = await idbGet<FileHandle>(HANDLE_KEY) } catch { /* none */ }
      if (!h) return setStatus({ kind: 'browser-only', fileApi: true })
      handle.current = h
      if (await hasPermission(h, false)) await sync(h)
      else setStatus({ kind: 'needs-permission', file: h.name })
    })()
  }, [sync])

  const update = useCallback((fn: (d: TradesDoc) => TradesDoc) => {
    const next = { ...fn(current.current), savedAt: new Date().toISOString() }
    adopt(next)
    const h = handle.current
    if (h && connected.current) void writeFile(h)
  }, [writeFile])

  const reconnect = useCallback(async () => {
    const h = handle.current
    if (h && (await hasPermission(h, true))) await sync(h)
  }, [sync])

  const use = async (h: FileHandle) => {
    handle.current = h
    await idbSet(HANDLE_KEY, h).catch(() => {})
  }

  /** Start a new trades file holding what is on the page now. */
  const createFile = useCallback(async () => {
    try {
      const h = await picker().showSaveFilePicker({ id: 'forever-trades', suggestedName: 'trades.json', types: TYPES })
      await use(h)
      connected.current = true
      if (!current.current.savedAt) current.current = { ...current.current, savedAt: new Date().toISOString() }
      await writeFile(h)
    } catch (e) { if (!isAbort(e)) setStatus({ kind: 'error', message: (e as Error).message }) }
  }, [writeFile])

  /** Use an existing trades file (the newer of it and the page wins). */
  const openFile = useCallback(async () => {
    try {
      const [h] = await picker().showOpenFilePicker({ id: 'forever-trades', types: TYPES, multiple: false })
      if (!(await hasPermission(h, true))) return setStatus({ kind: 'error', message: `Access to ${h.name} was not allowed.` })
      await use(h)
      await sync(h)
    } catch (e) { if (!isAbort(e)) setStatus({ kind: 'error', message: (e as Error).message }) }
  }, [sync])

  const disconnect = useCallback(async () => {
    handle.current = null
    connected.current = false
    await idbDelete(HANDLE_KEY).catch(() => {})
    setStatus({ kind: 'browser-only', fileApi: fileApiSupported() })
  }, [])

  const exportFile = useCallback(() => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text(current.current)], { type: 'application/json' }))
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [])

  return { doc, status, update, reconnect, createFile, openFile, disconnect, exportFile }
}
