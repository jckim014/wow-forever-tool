// Pure helpers for the Favorites view: named groups of recipes in the user's own order. No UI code; no prices.
// Every function returns a new FavoritesEdits (or the same one when nothing changes).
import type { FavGroup, FavoritesEdits } from '../model'

export const UNSORTED_ID = 'unsorted'
export const UNSORTED_NAME = 'Unsorted'

/** Where a dragged recipe or group lands: next to `id`, before it or after it; null = at the end. */
export type Anchor = { id: number | string; after: boolean } | null

/** recipe ID -> group ID */
export function groupOf(fav: FavoritesEdits): Map<number, string> {
  const m = new Map<number, string>()
  for (const g of fav.groups) for (const id of g.recipes) m.set(id, g.id)
  return m
}

export const favoriteCount = (fav: FavoritesEdits) => fav.groups.reduce((n, g) => n + g.recipes.length, 0)

function newId(fav: FavoritesEdits): string {
  let n = 1
  for (const g of fav.groups) {
    const m = /^g(\d+)$/.exec(g.id)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  return `g${n}`
}

const without = (groups: FavGroup[], recipeId: number) =>
  groups.map((g) => (g.recipes.includes(recipeId) ? { ...g, recipes: g.recipes.filter((r) => r !== recipeId) } : g))

function insert<T>(list: T[], item: T, at: number) {
  const out = [...list]
  out.splice(at < 0 ? out.length : at, 0, item)
  return out
}

/** Adds a group at the end and returns its ID with the new state. */
export function addGroup(fav: FavoritesEdits, name: string): { fav: FavoritesEdits; id: string } {
  const id = newId(fav)
  return { fav: { groups: [...fav.groups, { id, name: name.trim() || 'New group', recipes: [] }] }, id }
}

export function renameGroup(fav: FavoritesEdits, groupId: string, name: string): FavoritesEdits {
  const n = name.trim()
  if (!n) return fav
  return { groups: fav.groups.map((g) => (g.id === groupId ? { ...g, name: n } : g)) }
}

/** Removes the group; its recipes are no longer favorites. */
export function deleteGroup(fav: FavoritesEdits, groupId: string): FavoritesEdits {
  return { groups: fav.groups.filter((g) => g.id !== groupId) }
}

/**
 * Puts the recipe in the group (taking it out of any other), next to the anchor recipe or at the end.
 * groupId null removes it from Favorites. A star with no group chosen goes to Unsorted, which is made at the top if missing.
 */
export function moveRecipe(fav: FavoritesEdits, recipeId: number, groupId: string | null, anchor: Anchor = null): FavoritesEdits {
  if (anchor && anchor.id === recipeId) return fav
  let groups = without(fav.groups, recipeId)
  if (groupId === null) return { groups }
  if (groupId === UNSORTED_ID && !groups.some((g) => g.id === UNSORTED_ID)) {
    groups = [{ id: UNSORTED_ID, name: UNSORTED_NAME, recipes: [] }, ...groups]
  }
  if (!groups.some((g) => g.id === groupId)) return fav
  return {
    groups: groups.map((g) => {
      if (g.id !== groupId) return g
      const i = anchor ? g.recipes.indexOf(anchor.id as number) : -1
      return { ...g, recipes: insert(g.recipes, recipeId, i < 0 ? -1 : i + (anchor!.after ? 1 : 0)) }
    }),
  }
}

/** Star in the List: adds to Unsorted, or removes a favorite. */
export const toggleStar = (fav: FavoritesEdits, recipeId: number): FavoritesEdits =>
  groupOf(fav).has(recipeId) ? moveRecipe(fav, recipeId, null) : moveRecipe(fav, recipeId, UNSORTED_ID)

export function moveGroup(fav: FavoritesEdits, groupId: string, anchor: Anchor): FavoritesEdits {
  if (anchor && anchor.id === groupId) return fav
  const g = fav.groups.find((x) => x.id === groupId)
  if (!g) return fav
  const rest = fav.groups.filter((x) => x.id !== groupId)
  const i = anchor ? rest.findIndex((x) => x.id === anchor.id) : -1
  return { groups: insert(rest, g, i < 0 ? -1 : i + (anchor!.after ? 1 : 0)) }
}
