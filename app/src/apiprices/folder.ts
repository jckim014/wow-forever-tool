// The auction data folder (F:\ForeverAuctionData, filled by the collector's PC sync): picked once (Chrome/Edge),
// read-only, its handle kept in IndexedDB like the price history folder's.
import type { ApiPrices } from '../model'
import { idbDelete, idbGet, idbSet } from '../storage/idb'
import { datedFolders, pricesFromSummary, snapshotFiles } from './read'

/** The parts of FileSystemDirectoryHandle used here (declared locally: not in every DOM typing). */
export interface ReadDir {
  readonly name: string
  getDirectoryHandle(name: string): Promise<ReadDir>
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>
  keys(): AsyncIterable<string>
  queryPermission(opts: { mode: 'read' }): Promise<PermissionState>
  requestPermission(opts: { mode: 'read' }): Promise<PermissionState>
}

const KEY = 'auctionDataDir'
/** How many of the newest summaries to look through for the house (a house missing from one didn't change). */
const MAX_FILES = 72

export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

export async function loadFolder(): Promise<ReadDir | null> {
  try {
    return (await idbGet<ReadDir>(KEY)) ?? null
  } catch {
    return null
  }
}
export const saveFolder = (h: ReadDir) => idbSet(KEY, h).catch(() => {})
export const forgetFolder = () => idbDelete(KEY).catch(() => {})

/** Throws AbortError if the user cancels. */
export function pickFolder(): Promise<ReadDir> {
  const w = window as unknown as { showDirectoryPicker(opts: object): Promise<ReadDir> }
  return w.showDirectoryPicker({ id: 'auction-data', mode: 'read' })
}

/** With `ask`, prompts the user (needs a click to have just happened). */
export async function canRead(h: ReadDir, ask: boolean): Promise<boolean> {
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
  return ask && (await h.requestPermission({ mode: 'read' })) === 'granted'
}

async function names(dir: ReadDir): Promise<string[]> {
  const out: string[] = []
  for await (const n of dir.keys()) out.push(n)
  return out
}

async function gunzipText(file: File): Promise<string> {
  const stream = file.stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

/**
 * The newest summary in the folder that has `house`, or null if there is none.
 * Returns "unchanged" when the newest summary with the house is `have` (the snapshot the caller already has).
 * Throws if the folder isn't the auction data folder (no "summary" folder inside).
 */
export async function newestPrices(root: ReadDir, house: number, have: string | null): Promise<ApiPrices | 'unchanged' | null> {
  let summary: ReadDir
  try {
    summary = await root.getDirectoryHandle('summary')
  } catch {
    throw new Error(`${root.name} has no "summary" folder: pick the auction data folder itself (F:\\ForeverAuctionData)`)
  }
  let seen = 0
  for (const y of datedFolders(await names(summary), 4)) {
    const yd = await summary.getDirectoryHandle(y)
    for (const m of datedFolders(await names(yd), 2)) {
      const md = await yd.getDirectoryHandle(m)
      for (const d of datedFolders(await names(md), 2)) {
        const dd = await md.getDirectoryHandle(d)
        for (const f of snapshotFiles(await names(dd))) {
          if (seen === 0 && f.slice(0, -8) === have) return 'unchanged'
          if (++seen > MAX_FILES) return null
          const p = pricesFromSummary(await gunzipText(await (await dd.getFileHandle(f)).getFile()), house)
          if (p) return p.snapshot === have ? 'unchanged' : p
        }
      }
    }
  }
  return null
}
