// Browser copy of the edits: a cache of the save file, and the only store where the File System Access API is missing.
const KEY = 'wow-forever-shuffle:edits:v1'

export function readLocal(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Returns false if the browser refused (private window, storage full, blocked site data). */
export function writeLocal(text: string): boolean {
  try {
    localStorage.setItem(KEY, text)
    return true
  } catch {
    return false
  }
}
