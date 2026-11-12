import type { FavoritesEdits } from '../model'
import { addGroup, groupOf, moveRecipe, UNSORTED_ID, UNSORTED_NAME } from './fav'

const NONE = ''
const NEW = '__new'

/** In the recipe card: which Favorites group the recipe is in, or none. */
export function FavPicker({ recipeId, favorites, updateFav }: {
  recipeId: number
  favorites: FavoritesEdits
  updateFav: (fn: (f: FavoritesEdits) => FavoritesEdits) => void
}) {
  const current = groupOf(favorites).get(recipeId) ?? NONE
  const groups = favorites.groups.some((g) => g.id === UNSORTED_ID)
    ? favorites.groups
    : [...favorites.groups, { id: UNSORTED_ID, name: UNSORTED_NAME, recipes: [] }]
  const choose = (v: string) => {
    if (v === NEW) {
      const name = window.prompt('Name of the new Favorites group')
      if (!name?.trim()) return
      updateFav((f) => {
        const made = addGroup(f, name)
        return moveRecipe(made.fav, recipeId, made.id)
      })
    } else {
      updateFav((f) => moveRecipe(f, recipeId, v === NONE ? null : v))
    }
  }
  return (
    <label className="fav-pick">
      {current ? '★' : '☆'} Favorites
      <select value={current} onChange={(e) => choose(e.target.value)}>
        <option value={NONE}>Not in Favorites</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        <option value={NEW}>New group…</option>
      </select>
    </label>
  )
}
