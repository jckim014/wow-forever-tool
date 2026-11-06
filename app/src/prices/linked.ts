// A linked price file (Auctioneer's Auc-ScanData.lua or Auctionator.lua): the file handle is kept in IndexedDB (per browser) so the app can re-read the same file
// on the next visit without the user finding it again. The browser may ask once per visit to allow reading it.
import { idbDelete, idbGet, idbSet } from '../storage/idb'

/** The parts of FileSystemFileHandle used here (declared locally: the picker API is not in every DOM typing). */
export interface ReadHandle {
  readonly name: string
  getFile(): Promise<File>
  queryPermission(opts: { mode: 'read' }): Promise<PermissionState>
  requestPermission(opts: { mode: 'read' }): Promise<PermissionState>
}

export interface LinkRecord {
  handle: ReadHandle
  /** Realm chosen when the file holds several (remembered so later imports don't ask again). */
  realm: string | null
  /** The file's lastModified (ms) at the last import from the link, and that import's importsInfo.at. */
  importedModified: number | null
  importedAt: string | null
}

const KEY = 'auctionatorLink'

export const linkSupported = () => typeof window !== 'undefined' && 'showOpenFilePicker' in window

export async function loadLink(): Promise<LinkRecord | null> {
  try {
    return (await idbGet<LinkRecord>(KEY)) ?? null
  } catch {
    return null
  }
}

export const saveLink = (r: LinkRecord) => idbSet(KEY, r).catch(() => {})
export const forgetLink = () => idbDelete(KEY).catch(() => {})

/** Pick Auc-ScanData.lua or Auctionator.lua (or a .zip of one). Throws AbortError if the user cancels. */
export async function pickAuctionator(): Promise<ReadHandle> {
  const w = window as unknown as { showOpenFilePicker(opts: object): Promise<ReadHandle[]> }
  const [h] = await w.showOpenFilePicker({
    id: 'auctionator', multiple: false,
    types: [{ description: 'Auctioneer or Auctionator SavedVariables', accept: { 'application/octet-stream': ['.lua', '.zip'] } }],
  })
  return h
}

/** With `ask`, prompts the user (needs a click to have just happened). */
export async function canRead(h: ReadHandle, ask: boolean): Promise<boolean> {
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true
  return ask && (await h.requestPermission({ mode: 'read' })) === 'granted'
}

/**
 * Whether to import the linked file.
 * - On open: only when the file changed since the last import from it (so a manual import made since is kept).
 * - Refresh now: also when the prices in the app did not come from this file's last import (e.g. a manual import since).
 */
export function shouldImport(link: LinkRecord, fileModified: number, currentImportAt: string | null, mode: 'open' | 'refresh'): boolean {
  const changed = link.importedModified === null || fileModified !== link.importedModified
  if (mode === 'open') return changed
  return changed || link.importedAt === null || currentImportAt !== link.importedAt
}
