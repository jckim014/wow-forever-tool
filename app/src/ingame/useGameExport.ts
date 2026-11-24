// File > Link game addon folder: the BavvbScan folder in WoW's Interface\AddOns, picked once (handle in IndexedDB).
// While linked, Favorites.lua is rewritten whenever what it holds changes (favorites, recipes' settings, custom and
// vendor prices); never for price imports, which it doesn't contain. WoW reads it at login or /reload.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DeBand, Edits, GameData, ModelResult } from '../model'
import { idbDelete, idbGet, idbSet } from '../storage/idb'
import { buildExport, exportLua } from './export'

interface Dir {
  readonly name: string
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    getFile(): Promise<File>
    createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
  }>
  queryPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>
}

const KEY = 'addonDir'
const FILE = 'Favorites.lua'
export const gameFolderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

export type GameExportStatus = 'none' | 'needs-permission' | 'sent' | 'error'

export function useGameExport(game: GameData | null, result: ModelResult | null, edits: Edits, deTable: DeBand[], onMessage: (m: string) => void) {
  const [dir, setDir] = useState<Dir | null>(null)
  const [status, setStatus] = useState<GameExportStatus>('none')
  const [sentAt, setSentAt] = useState<number | null>(null)
  const lastBody = useRef<string | null>(null)

  // The file's content without the send time; settings and favorites only, so price imports don't change it.
  const body = useMemo(() => {
    if (!game || !result) return null
    return JSON.stringify(buildExport(game, result, edits, deTable))
  }, [game, edits.favorites, edits.typedPrices, edits.vendorBuyOverrides, edits.allowCrafting, edits.useChainsNo, edits.settings, deTable, result !== null])

  const write = async (d: Dir, ask: boolean) => {
    if (!body || !game || !result) return
    try {
      const opts = { mode: 'readwrite' } as const
      if ((await d.queryPermission(opts)) !== 'granted' && !(ask && (await d.requestPermission(opts)) === 'granted')) {
        setStatus('needs-permission')
        return
      }
      const at = Math.floor(Date.now() / 1000)
      const text = exportLua(buildExport(game, result, edits, deTable), at)
      const w = await (await d.getFileHandle(FILE, { create: true })).createWritable()
      await w.write(text)
      await w.close()
      lastBody.current = body
      setSentAt(at * 1000)
      setStatus('sent')
    } catch (e) {
      setStatus('error')
      onMessage(`Could not write ${FILE} to ${d.name}: ${(e as Error).message}`)
    }
  }

  useEffect(() => {
    idbGet<Dir>(KEY).then((d) => d && setDir((cur) => cur ?? d), () => {})
  }, [])

  useEffect(() => {
    if (dir && body && body !== lastBody.current && status !== 'needs-permission') write(dir, false)
  }, [dir, body])

  async function link() {
    let d: Dir
    try {
      d = await (window as unknown as { showDirectoryPicker(o: object): Promise<Dir> }).showDirectoryPicker({ id: 'bavvbscan-addon', mode: 'readwrite' })
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) onMessage(`Could not use that folder: ${(e as Error).message}`)
      return
    }
    try {
      await d.getFileHandle('BavvbScan.toc')
    } catch {
      onMessage(`${d.name} has no BavvbScan.toc. Pick the BavvbScan folder inside World of Warcraft\\_forever_\\Interface\\AddOns.`)
      return
    }
    await idbSet(KEY, d).catch(() => {})
    setDir(d)
    lastBody.current = null
    await write(d, true)
    onMessage(`Favorites go to the game now (${d.name}\\${FILE}); /reload in game to load them. They are sent again whenever they change.`)
  }

  async function unlink() {
    setDir(null)
    setStatus('none')
    lastBody.current = null
    await idbDelete(KEY).catch(() => {})
    onMessage(`Stopped sending favorites to the game. ${FILE} stays in the addon folder.`)
  }

  return {
    supported: gameFolderSupported(),
    folder: dir?.name ?? null,
    status, sentAt,
    link, unlink,
    /** From a click: lets Chrome ask for write access again, then sends. */
    allow: () => dir && write(dir, true),
  }
}
