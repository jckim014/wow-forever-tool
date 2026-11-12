import { describe, expect, it } from 'vitest'
import { normalizeEdits } from '../model/edits'
import { parseDoc, docText } from '../storage/doc'
import { addGroup, deleteGroup, favoriteCount, groupOf, moveGroup, moveRecipe, renameGroup, toggleStar, UNSORTED_ID } from './fav'
import type { FavoritesEdits } from '../model'

const base = (): FavoritesEdits => ({
  groups: [
    { id: 'g1', name: 'Bags', recipes: [1, 2, 3] },
    { id: 'g2', name: 'DE', recipes: [4] },
  ],
})
const ids = (f: FavoritesEdits) => f.groups.map((g) => `${g.id}:${g.recipes.join(',')}`).join(' ')

describe('favorites', () => {
  it('a star with no group goes to Unsorted, made at the top; a second star removes it', () => {
    const f = toggleStar(base(), 9)
    expect(ids(f)).toBe('unsorted:9 g1:1,2,3 g2:4')
    expect(f.groups[0].name).toBe('Unsorted')
    expect(ids(toggleStar(f, 9))).toBe('unsorted: g1:1,2,3 g2:4')
    expect(ids(toggleStar(f, 2))).toBe('unsorted:9 g1:1,3 g2:4')
  })

  it('moves a recipe within a group and between groups, before or after an anchor', () => {
    expect(ids(moveRecipe(base(), 3, 'g1', { id: 1, after: false }))).toBe('g1:3,1,2 g2:4')
    expect(ids(moveRecipe(base(), 1, 'g1', { id: 3, after: true }))).toBe('g1:2,3,1 g2:4')
    expect(ids(moveRecipe(base(), 1, 'g1', { id: 2, after: true }))).toBe('g1:2,1,3 g2:4')
    expect(ids(moveRecipe(base(), 2, 'g2', { id: 4, after: false }))).toBe('g1:1,3 g2:2,4')
    expect(ids(moveRecipe(base(), 2, 'g2'))).toBe('g1:1,3 g2:4,2')
    expect(ids(moveRecipe(base(), 2, 'g2', { id: 2, after: false }))).toBe('g1:1,2,3 g2:4')
    expect(ids(moveRecipe(base(), 2, null))).toBe('g1:1,3 g2:4')
    expect(moveRecipe(base(), 2, 'nope')).toEqual(base())
  })

  it('keeps one group per recipe', () => {
    const f = moveRecipe(moveRecipe(base(), 4, 'g1'), 4, UNSORTED_ID)
    expect(ids(f)).toBe('unsorted:4 g1:1,2,3 g2:')
    expect(groupOf(f).get(4)).toBe(UNSORTED_ID)
    expect(favoriteCount(f)).toBe(4)
  })

  it('adds, renames, deletes and reorders groups', () => {
    const { fav, id } = addGroup(base(), '  Tonight ')
    expect(id).toBe('g3')
    expect(fav.groups[2]).toEqual({ id: 'g3', name: 'Tonight', recipes: [] })
    expect(renameGroup(fav, 'g3', ' ').groups[2].name).toBe('Tonight')
    expect(renameGroup(fav, 'g3', 'Later').groups[2].name).toBe('Later')
    expect(ids(deleteGroup(fav, 'g1'))).toBe('g2:4 g3:')
    expect(ids(moveGroup(fav, 'g3', { id: 'g1', after: false }))).toBe('g3: g1:1,2,3 g2:4')
    expect(ids(moveGroup(fav, 'g1', { id: 'g2', after: true }))).toBe('g2:4 g1:1,2,3 g3:')
    expect(ids(moveGroup(fav, 'g1', null))).toBe('g2:4 g3: g1:1,2,3')
  })

  it('survives a save and load, dropping duplicates and bad groups', () => {
    const { edits } = normalizeEdits({ format: 'shuffle-edits', version: 1 })
    edits.favorites = base()
    expect(parseDoc(docText(edits)).edits.favorites).toEqual(base())
    const { edits: e, warnings } = normalizeEdits({
      format: 'shuffle-edits', version: 1,
      favorites: { groups: [{ id: 'a', name: 'A', recipes: [1, 2, 'x', 1] }, { id: 'b', name: 'B', recipes: [2, 3] }, { name: 'no id' }] },
    })
    expect(ids(e.favorites)).toBe('a:1,2 b:3')
    expect(warnings).toHaveLength(1)
  })
})
