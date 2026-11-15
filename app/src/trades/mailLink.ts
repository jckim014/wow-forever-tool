// The linked BavvbScan.lua files the mailbox sales are read from (one per WoW account that trades). Read-only handles
// kept in IndexedDB (per browser), read when the page opens and on Refresh; WoW writes the file on /reload or logout.
import { useCallback, useEffect, useRef, useState } from 'react'
import { canRead, type ReadHandle } from '../prices/linked'
import { idbGet, idbSet } from '../storage/idb'
import { isAbort } from '../storage/fileStore'
import { mergeLogs, readMailLog, type MailLog } from './mailSales'

const KEY = 'tradesSalesFiles'

export type MailLinkState =
  | { kind: 'none' }
  | { kind: 'needs-permission'; files: number }
  | { kind: 'ok'; log: MailLog; files: number; readAt: Date; errors: string[] }

export function useMailLink() {
  const [state, setState] = useState<MailLinkState>({ kind: 'none' })
  const handles = useRef<ReadHandle[]>([])

  const read = useCallback(async (ask: boolean) => {
    const hs = handles.current
    if (!hs.length) return setState({ kind: 'none' })
    for (const h of hs) {
      if (!(await canRead(h, ask).catch(() => false))) return setState({ kind: 'needs-permission', files: hs.length })
    }
    const logs: MailLog[] = []
    const errors: string[] = []
    for (const h of hs) {
      try {
        logs.push(readMailLog(new Uint8Array(await (await h.getFile()).arrayBuffer())))
      } catch (e) {
        errors.push(`${h.name}: ${(e as Error).message}`)
      }
    }
    setState({ kind: 'ok', log: mergeLogs(logs), files: hs.length, readAt: new Date(), errors })
  }, [])

  useEffect(() => {
    ;(async () => {
      try { handles.current = (await idbGet<ReadHandle[]>(KEY)) ?? [] } catch { handles.current = [] }
      await read(false)
    })()
  }, [read])

  /** Adds a BavvbScan.lua (another account's, or the first). */
  const link = useCallback(async () => {
    try {
      const w = window as unknown as { showOpenFilePicker(o: object): Promise<ReadHandle[]> }
      const [h] = await w.showOpenFilePicker({
        id: 'bavvbscan-sales', multiple: false,
        types: [{ description: 'BavvbScan.lua (SavedVariables)', accept: { 'application/octet-stream': ['.lua'] } }],
      })
      for (const old of handles.current) {
        if (await (old as unknown as { isSameEntry(o: unknown): Promise<boolean> }).isSameEntry(h).catch(() => false)) return read(true)
      }
      handles.current = [...handles.current, h]
      await idbSet(KEY, handles.current).catch(() => {})
      await read(true)
    } catch (e) {
      if (!isAbort(e)) alert((e as Error).message)
    }
  }, [read])

  const unlinkAll = useCallback(async () => {
    handles.current = []
    await idbSet(KEY, []).catch(() => {})
    setState({ kind: 'none' })
  }, [])

  return { state, link, unlinkAll, refresh: () => read(true) }
}
