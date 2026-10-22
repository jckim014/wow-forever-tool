// The save file on Josh's disk, through the File System Access API (Chrome/Edge). The handle is kept in IndexedDB so
// the same file is used on the next visit; the browser may ask once per visit to allow access again.
import { idbDelete, idbGet, idbSet } from './idb'

/** The parts of FileSystemFileHandle used here (declared locally: the picker API is not in every DOM typing). */
export interface FileHandle {
  readonly name: string
  getFile(): Promise<File>
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>
  queryPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission(opts: { mode: 'readwrite' }): Promise<PermissionState>
}

interface PickerWindow {
  showOpenFilePicker(opts: object): Promise<FileHandle[]>
  showSaveFilePicker(opts: object): Promise<FileHandle>
}

const HANDLE_KEY = 'saveFile'
const TYPES = [{ description: 'Shuffle edits', accept: { 'application/json': ['.json'] } }]
const picker = () => window as unknown as PickerWindow

export const fileApiSupported = () => typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showSaveFilePicker' in window

export async function savedHandle(): Promise<FileHandle | null> {
  try {
    return (await idbGet<FileHandle>(HANDLE_KEY)) ?? null
  } catch {
    return null
  }
}

/** Pick an existing save file. Throws AbortError if the user cancels. */
export async function pickExisting(): Promise<FileHandle> {
  const [h] = await picker().showOpenFilePicker({ id: 'shuffle-edits', types: TYPES, multiple: false })
  return h
}

/** Pick where to create a new save file. Throws AbortError if the user cancels. */
export async function pickNew(): Promise<FileHandle> {
  return picker().showSaveFilePicker({ id: 'shuffle-edits', suggestedName: 'shuffle-edits.json', types: TYPES })
}

export const rememberHandle = (h: FileHandle) => idbSet(HANDLE_KEY, h)
export const forgetHandle = () => idbDelete(HANDLE_KEY)

/** With `ask`, prompts the user (needs a click or key press to have just happened). */
export async function hasPermission(h: FileHandle, ask: boolean): Promise<boolean> {
  const opts = { mode: 'readwrite' } as const
  if ((await h.queryPermission(opts)) === 'granted') return true
  return ask && (await h.requestPermission(opts)) === 'granted'
}

export async function readHandle(h: FileHandle): Promise<string> {
  return (await h.getFile()).text()
}

/** The browser writes to a temporary file and swaps it in on close, so a failed write leaves the old file intact. */
export async function writeHandle(h: FileHandle, text: string): Promise<void> {
  const w = await h.createWritable()
  await w.write(text)
  await w.close()
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
