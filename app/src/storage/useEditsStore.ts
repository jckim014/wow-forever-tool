// The one place edits are loaded and saved. The save file is the primary store; the browser copy (localStorage) is a
// cache and the fallback. Every save stamps savedAt; when the two disagree on startup, the newer one wins.
// A save file that cannot be read as an edits file is never overwritten.
import { useCallback, useEffect, useRef, useState } from 'react'
import { emptyEdits, type Edits } from '../model'
import { docText, isEmptyEdits, parseDoc, type ParsedDoc } from './doc'
import {
  fileApiSupported, forgetHandle, hasPermission, isAbort, pickExisting, pickNew, readHandle, rememberHandle, savedHandle,
  writeHandle, type FileHandle,
} from './fileStore'
import { readLocal, writeLocal } from './local'

export type SaveStatus =
  | { kind: 'loading' }
  | { kind: 'browser-only'; fileApi: boolean }
  | { kind: 'needs-permission'; file: string }
  | { kind: 'saving'; file: string }
  | { kind: 'saved'; file: string; at: string }
  | { kind: 'error'; file: string | null; message: string }

const FILE_WRITE_DELAY = 400

export function useEditsStore() {
  const [edits, setEdits] = useState<Edits>(emptyEdits)
  const [status, setStatus] = useState<SaveStatus>({ kind: 'loading' })
  const [localOk, setLocalOk] = useState(true)
  const savedAt = useRef<string | null>(null)
  const current = useRef<Edits>(edits)
  const handle = useRef<FileHandle | null>(null)
  const connected = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const started = useRef(false)

  const adopt = (doc: ParsedDoc, text: string) => {
    current.current = doc.edits
    savedAt.current = doc.savedAt
    setEdits(doc.edits)
    setLocalOk(writeLocal(text))
  }

  const writeFile = useCallback(async (h: FileHandle) => {
    setStatus({ kind: 'saving', file: h.name })
    try {
      await writeHandle(h, docText(current.current, savedAt.current ?? undefined))
      setStatus({ kind: 'saved', file: h.name, at: savedAt.current ?? new Date().toISOString() })
    } catch (e) {
      setStatus({ kind: 'error', file: h.name, message: `Could not save to ${h.name}: ${(e as Error).message}. Your edits are kept in this browser.` })
    }
  }, [])

  /** Reconcile the browser copy with the file (permission already granted). */
  const sync = useCallback(async (h: FileHandle) => {
    let text: string
    try {
      text = await readHandle(h)
    } catch (e) {
      connected.current = false
      setStatus({ kind: 'error', file: h.name, message: `Could not read ${h.name}: ${(e as Error).message}` })
      return
    }
    if (text.trim() === '') {
      connected.current = true
      await writeFile(h)
      return
    }
    let doc: ParsedDoc
    try {
      doc = parseDoc(text)
    } catch (e) {
      connected.current = false
      setStatus({ kind: 'error', file: h.name, message: `${h.name} is not an edits file (${(e as Error).message}). It was not changed; choose another save file.` })
      return
    }
    connected.current = true
    const fileNewer = !doc.savedAt || !savedAt.current || doc.savedAt >= savedAt.current
    if (fileNewer) {
      adopt(doc, text)
      setStatus({ kind: 'saved', file: h.name, at: doc.savedAt ?? '' })
    } else {
      await writeFile(h) // this browser has newer edits (made while the file was not connected)
    }
  }, [writeFile])

  useEffect(() => {
    if (started.current) return // StrictMode runs effects twice in development
    started.current = true
    ;(async () => {
      const text = readLocal()
      if (text) {
        try {
          const doc = parseDoc(text)
          current.current = doc.edits
          savedAt.current = doc.savedAt
          setEdits(doc.edits)
        } catch {
          // an unreadable browser copy is ignored; the save file (if any) is still loaded below
        }
      }
      if (!fileApiSupported()) return setStatus({ kind: 'browser-only', fileApi: false })
      const h = await savedHandle()
      if (!h) return setStatus({ kind: 'browser-only', fileApi: true })
      handle.current = h
      if (await hasPermission(h, false)) await sync(h)
      else setStatus({ kind: 'needs-permission', file: h.name })
    })()
  }, [sync])

  /** Replace the edits (or derive them from the current ones) and save them everywhere. */
  const update = useCallback((nextOrFn: Edits | ((cur: Edits) => Edits)) => {
    const next = typeof nextOrFn === 'function' ? nextOrFn(current.current) : nextOrFn
    current.current = next
    savedAt.current = new Date().toISOString()
    setEdits(next)
    setLocalOk(writeLocal(docText(next, savedAt.current)))
    const h = handle.current
    if (h && connected.current) {
      if (timer.current) clearTimeout(timer.current)
      setStatus({ kind: 'saving', file: h.name })
      timer.current = setTimeout(() => writeFile(h), FILE_WRITE_DELAY)
    }
  }, [writeFile])

  const confirmReplace = (what: string) =>
    isEmptyEdits(current.current) || window.confirm(`${what} replaces all the edits currently in the app (typed prices, settings, imported prices and the rest). Continue?`)

  /** Ask again for access to the remembered save file (must run from a click). */
  const reconnect = useCallback(async () => {
    const h = handle.current
    if (!h) return
    if (await hasPermission(h, true)) await sync(h)
    else setStatus({ kind: 'needs-permission', file: h.name })
  }, [sync])

  /** Use an existing save file: its edits replace the ones in the app. */
  const openSaveFile = useCallback(async () => {
    let h: FileHandle
    try {
      h = await pickExisting()
    } catch (e) {
      if (!isAbort(e)) setStatus({ kind: 'error', file: null, message: (e as Error).message })
      return
    }
    // ask for write access straight away, while the click still counts as a user action
    if (!(await hasPermission(h, true))) {
      setStatus({ kind: 'error', file: h.name, message: `Access to ${h.name} was not allowed. Nothing was changed.` })
      return
    }
    let text: string, doc: ParsedDoc
    try {
      text = await readHandle(h)
      doc = parseDoc(text)
    } catch (e) {
      setStatus({ kind: 'error', file: h.name, message: `${h.name} is not an edits file (${(e as Error).message}). Nothing was changed.` })
      return
    }
    if (!confirmReplace(`Opening ${h.name}`)) return
    if (timer.current) clearTimeout(timer.current)
    handle.current = h
    connected.current = true
    await rememberHandle(h).catch(() => {})
    adopt(doc, text)
    if (!doc.savedAt) {
      savedAt.current = new Date().toISOString()
      await writeFile(h) // stamp it so later startups can tell which copy is newer
    } else setStatus({ kind: 'saved', file: h.name, at: doc.savedAt })
  }, [writeFile])

  /** Start a new save file holding the current edits. */
  const createSaveFile = useCallback(async () => {
    let h: FileHandle
    try {
      h = await pickNew()
    } catch (e) {
      if (!isAbort(e)) setStatus({ kind: 'error', file: null, message: (e as Error).message })
      return
    }
    handle.current = h
    connected.current = true
    await rememberHandle(h).catch(() => {})
    if (!savedAt.current) savedAt.current = new Date().toISOString()
    await writeFile(h)
  }, [writeFile])

  /** Stop saving to the file (the file itself is left as it is). */
  const disconnect = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    handle.current = null
    connected.current = false
    await forgetHandle().catch(() => {})
    setStatus({ kind: 'browser-only', fileApi: fileApiSupported() })
  }, [])

  /** Import an edits file (e.g. edits-v2.5.json); returns its warnings, or null if cancelled. */
  const importFile = useCallback(async (file: File): Promise<string[] | null> => {
    const doc = parseDoc(await file.text()) // throws a readable error
    if (!confirmReplace(`Importing ${file.name}`)) return null
    update(doc.edits)
    return doc.warnings
  }, [update])

  const exportFile = useCallback(() => {
    const blob = new Blob([docText(current.current, savedAt.current ?? undefined)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `shuffle-edits-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [])

  return { edits, status, localOk, update, reconnect, openSaveFile, createSaveFile, disconnect, importFile, exportFile }
}
