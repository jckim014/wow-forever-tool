// Minimal IndexedDB key-value store: file handles can be kept here (not in localStorage).
const DB = 'wow-forever-shuffle', STORE = 'kv'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

export const idbGet = <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key))
export const idbSet = (key: string, value: unknown) => run<void>('readwrite', (s) => s.put(value, key))
export const idbDelete = (key: string) => run<void>('readwrite', (s) => s.delete(key))
