import { describe, expect, it } from 'vitest'
import { shouldImport, type LinkRecord } from './linked'

const link = (importedModified: number | null, importedAt: string | null): LinkRecord =>
  ({ handle: {} as LinkRecord['handle'], realm: null, importedModified, importedAt })

describe('shouldImport', () => {
  it('imports a newly linked file', () => {
    expect(shouldImport(link(null, null), 100, null, 'open')).toBe(true)
    expect(shouldImport(link(null, null), 100, 'x', 'refresh')).toBe(true)
  })
  it('on open, imports only when the file changed', () => {
    expect(shouldImport(link(100, 'a'), 100, 'a', 'open')).toBe(false)
    expect(shouldImport(link(100, 'a'), 200, 'a', 'open')).toBe(true)
    // a manual import since the last linked import is kept while the file is unchanged
    expect(shouldImport(link(100, 'a'), 100, 'manual', 'open')).toBe(false)
  })
  it('Refresh now also replaces prices that came from elsewhere', () => {
    expect(shouldImport(link(100, 'a'), 100, 'a', 'refresh')).toBe(false)
    expect(shouldImport(link(100, 'a'), 100, 'manual', 'refresh')).toBe(true)
    expect(shouldImport(link(100, 'a'), 100, null, 'refresh')).toBe(true)
    expect(shouldImport(link(100, 'a'), 200, 'a', 'refresh')).toBe(true)
  })
})
