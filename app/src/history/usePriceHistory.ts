import { useEffect, useRef, useState } from 'react'
import { canWrite, folderSupported, forgetFolder, loadFolder, pickFolder, saveFolder, storedScans, writeScans, type DirHandle, type PendingScan } from './folder'

const scans = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'scan' : 'scans'}`

/**
 * Keeps every full scan (BavvbScan or Auctioneer) that is imported (dropped, picked or the linked file) in the price history folder.
 * Scans imported while the folder can't be written (none chosen yet, or Chrome needs an OK) wait in memory for this
 * visit and are written once it can.
 */
export function usePriceHistory(onMessage: (m: string) => void) {
  const [folder, setFolderState] = useState<DirHandle | null>(null)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const [waiting, setWaiting] = useState(0)
  const folderRef = useRef<DirHandle | null>(null)
  const pending = useRef<PendingScan[]>([])
  const busy = useRef<Promise<void>>(Promise.resolve())

  const setFolder = (h: DirHandle | null) => {
    folderRef.current = h
    setFolderState(h)
  }

  /** Writes what is waiting, one run at a time. `ask` (from a click) lets the browser prompt for access. */
  const flush = (h: DirHandle, ask: boolean) => {
    busy.current = busy.current.then(async () => {
      try {
        if (!(await canWrite(h, ask))) {
          setNeedsPermission(true)
          if (ask) onMessage(`Writing to ${h.name} was not allowed, so the scan was not added to the price history.`)
          return
        }
        setNeedsPermission(false)
        const batch = [...pending.current]
        if (batch.length) {
          const written = await writeScans(h, batch)
          pending.current = pending.current.filter((s) => !batch.includes(s))
          setWaiting(pending.current.length)
          if (written.length) onMessage(`Scan saved to price history (${h.name}): ${written.join(', ')}.`)
          else onMessage(`This scan is already in the price history (${h.name}).`)
        }
        setCount((await storedScans(h)).size)
      } catch (e) {
        onMessage(`Could not save to the price history folder ${h.name}: ${(e as Error).message}`)
      }
    })
    return busy.current
  }

  useEffect(() => {
    loadFolder().then(async (h) => {
      if (!h || folderRef.current) return
      setFolder(h)
      await flush(h, false)
    })
  }, [])

  function keep(scansToKeep: PendingScan[]) {
    pending.current.push(...scansToKeep)
    setWaiting(pending.current.length)
    if (folderRef.current) flush(folderRef.current, false)
  }

  async function choose() {
    let h: DirHandle
    try {
      h = await pickFolder()
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) onMessage(`Could not use that folder: ${(e as Error).message}`)
      return
    }
    setFolder(h)
    await saveFolder(h)
    if (!pending.current.length) onMessage(`Price history folder: ${h.name}. Each scan you import from now on is saved there.`)
    await flush(h, true)
  }

  async function stop() {
    const name = folderRef.current?.name
    setFolder(null)
    setNeedsPermission(false)
    setCount(null)
    await forgetFolder()
    if (name) onMessage(`Stopped keeping price history. The files already in ${name} stay.`)
  }

  return {
    supported: folderSupported(),
    folder: folder?.name ?? null,
    needsPermission,
    /** Scans stored in the folder (null until it could be read). */
    count,
    countText: count === null ? null : scans(count),
    /** Scans imported this visit and not written yet. */
    waiting,
    keep, choose, stop,
    approve: () => folderRef.current && flush(folderRef.current, true),
  }
}
