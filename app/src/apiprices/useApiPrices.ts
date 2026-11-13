import { useEffect, useRef, useState } from 'react'
import type { ApiPrices } from '../model'
import { canRead, folderSupported, forgetFolder, loadFolder, newestPrices, pickFolder, saveFolder, type ReadDir } from './folder'

/** While the app is open, the folder is looked at this often (the PC sync adds a snapshot about hourly). */
const POLL_MS = 10 * 60 * 1000

/**
 * The newest API auction data for `house`, read from the auction data folder (F:\ForeverAuctionData). Read when the
 * app opens, every 10 minutes while it is open, on Refresh, and when the house changes. Never stored in the edits.
 */
export function useApiPrices(house: number, onMessage: (m: string) => void) {
  const [folder, setFolderState] = useState<ReadDir | null>(null)
  const [needsPermission, setNeedsPermission] = useState(false)
  const [data, setData] = useState<ApiPrices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const folderRef = useRef<ReadDir | null>(null)
  const dataRef = useRef<ApiPrices | null>(null)
  const houseRef = useRef(house)
  houseRef.current = house

  const setFolder = (h: ReadDir | null) => {
    folderRef.current = h
    setFolderState(h)
  }
  const setPrices = (p: ApiPrices | null) => {
    dataRef.current = p
    setData(p)
  }

  /** Reads the newest data. `ask` (from a click) lets the browser prompt for access. */
  async function read(ask: boolean) {
    const h = folderRef.current
    setNow(Date.now())
    if (!h) return
    try {
      if (!(await canRead(h, ask))) {
        setNeedsPermission(true)
        return
      }
      setNeedsPermission(false)
      const have = dataRef.current?.house === houseRef.current ? dataRef.current.snapshot : null
      const p = await newestPrices(h, houseRef.current, have)
      if (p === 'unchanged') return
      setPrices(p)
      setError(p ? null : `No data for house ${houseRef.current} in ${h.name} yet`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    loadFolder().then((h) => {
      if (!h || folderRef.current) return
      setFolder(h)
      read(false)
    })
    const t = setInterval(() => read(false), POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000)
    return () => {
      clearInterval(t)
      clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    if (folderRef.current && dataRef.current && dataRef.current.house !== house) {
      setPrices(null)
      read(false)
    }
  }, [house])

  async function choose() {
    let h: ReadDir
    try {
      h = await pickFolder()
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) onMessage(`Could not use that folder: ${(e as Error).message}`)
      return
    }
    setFolder(h)
    setPrices(null)
    await saveFolder(h)
    await read(true)
    if (dataRef.current) onMessage(`Auction data folder: ${h.name}. API prices for house ${houseRef.current} are read from it when the app opens and every 10 minutes.`)
  }

  async function stop() {
    const name = folderRef.current?.name
    setFolder(null)
    setPrices(null)
    setNeedsPermission(false)
    setError(null)
    await forgetFolder()
    if (name) onMessage(`Stopped using API prices from ${name}. The folder itself is unchanged.`)
  }

  return {
    supported: folderSupported(),
    folder: folder?.name ?? null,
    needsPermission,
    data,
    error,
    now,
    choose, stop,
    refresh: () => read(true),
  }
}
