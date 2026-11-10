// The price history folder: picked once (Chrome/Edge), its handle kept in IndexedDB like the save file's.
import { zip } from 'fflate'
import { idbDelete, idbGet, idbSet } from '../storage/idb'
import { summaryText, type ScanSummary } from './archive'

/** The parts of FileSystemDirectoryHandle used here (declared locally: not in every DOM typing). */
export interface DirHandle {
  readonly name: string
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{
    createWritable(): Promise<{ write(data: string | Uint8Array): Promise<void>; close(): Promise<void> }>
  }>
  keys(): AsyncIterable<string>
  queryPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>
}

const KEY = 'priceHistoryDir'

export const folderSupported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

export async function loadFolder(): Promise<DirHandle | null> {
  try {
    return (await idbGet<DirHandle>(KEY)) ?? null
  } catch {
    return null
  }
}
export const saveFolder = (h: DirHandle) => idbSet(KEY, h).catch(() => {})
export const forgetFolder = () => idbDelete(KEY).catch(() => {})

/** Throws AbortError if the user cancels. */
export function pickFolder(): Promise<DirHandle> {
  const w = window as unknown as { showDirectoryPicker(opts: object): Promise<DirHandle> }
  return w.showDirectoryPicker({ id: 'price-history', mode: 'readwrite' })
}

/** With `ask`, prompts the user (needs a click to have just happened). */
export async function canWrite(h: DirHandle, ask: boolean): Promise<boolean> {
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true
  return ask && (await h.requestPermission({ mode: 'readwrite' })) === 'granted'
}

/** Base names of the scans fully stored in the folder (those with a summary .json). */
export async function storedScans(h: DirHandle): Promise<Set<string>> {
  const out = new Set<string>()
  for await (const name of h.keys()) if (name.endsWith('.json')) out.add(name.slice(0, -5))
  return out
}

const zipAsync = (files: Record<string, Uint8Array>) =>
  new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 9 }, (err, data) => (err ? reject(err) : resolve(data))))

async function writeFile(h: DirHandle, name: string, data: string | Uint8Array) {
  const w = await (await h.getFileHandle(name, { create: true })).createWritable()
  await w.write(data)
  await w.close()
}

export interface PendingScan {
  base: string
  summary: ScanSummary
  /** The whole SavedVariables file (BavvbScan.lua or Auc-ScanData.lua), and its name inside the zip. */
  raw: Uint8Array
  rawName: string
}

/** Writes the scans not stored yet (zip first, then the summary). Returns the base names written. */
export async function writeScans(h: DirHandle, scans: PendingScan[]): Promise<string[]> {
  const have = await storedScans(h)
  const written: string[] = []
  const zips = new Map<Uint8Array, Uint8Array>() // one zip per file, even when it holds several realms' scans
  for (const s of scans) {
    if (have.has(s.base)) continue
    let data = zips.get(s.raw)
    if (!data) zips.set(s.raw, (data = await zipAsync({ [s.rawName]: s.raw })))
    await writeFile(h, `${s.base}.zip`, data)
    await writeFile(h, `${s.base}.json`, summaryText(s.summary))
    written.push(s.base)
  }
  return written
}
