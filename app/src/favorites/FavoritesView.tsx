import { useState, type DragEvent } from 'react'
import type { FavGroup, RecipeRow } from '../model'
import type { ExitView } from '../recipes/filter'
import { Card, effectiveSort, ListHead, nextSort, Row, sortRows, useOpenSet, useStable, type CardProps, type Sort } from '../recipes/RecipeList'
import { addGroup, deleteGroup, moveGroup, moveRecipe, renameGroup } from './fav'

const COLLAPSED_KEY = 'wow-forever-shuffle:fav-collapsed'
const loadCollapsed = (): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

type Drag = { kind: 'recipe'; id: number } | { kind: 'group'; id: string }
/** where the drop would land: next to a recipe or group header, or at the end of a group */
type Drop = { kind: 'recipe'; id: number; after: boolean } | { kind: 'group'; id: string; after: boolean } | { kind: 'into'; id: string }

const lowerHalf = (e: DragEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientY > r.top + r.height / 2
}

/**
 * Favorite recipes in named groups, in the user's own order (drag to arrange) or sorted by a column.
 * The same rows and cards as the List. Only the search box and the Exit switch apply here.
 */
export function FavoritesView({ rowsById, searching, exit, ...p }: CardProps & {
  /** every recipe that matches the search box */
  rowsById: Map<number, RecipeRow>
  searching: boolean
  exit: ExitView
}) {
  const { favorites, updateFav } = p
  const [chosenSort, setSort] = useState<Sort | null>(null)
  const sort = effectiveSort(chosenSort, exit)
  const { open, setOpen, toggle } = useOpenSet()
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)

  const toggleCollapsed = (id: string) => setCollapsed((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
    } catch {
      // a per-browser convenience only
    }
    return next
  })

  const startDrag = (d: Drag, e: DragEvent<HTMLElement>, image: Element | null) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(d.id))
    if (image) e.dataTransfer.setDragImage(image, 16, 16)
    setDrag(d)
  }
  const onGrip = useStable((id: number, e: DragEvent<HTMLElement>) => {
    startDrag({ kind: 'recipe', id }, e, e.currentTarget.closest('.rrow'))
    setOpen((s) => {
      if (!s.has(id)) return s
      const next = new Set(s)
      next.delete(id)
      return next
    })
  })
  const onStar = useStable((id: number) => updateFav((f) => moveRecipe(f, id, null)))
  const endDrag = () => {
    setDrag(null)
    setDrop(null)
  }
  const over = (e: DragEvent<HTMLElement>, d: Drop) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (JSON.stringify(d) !== JSON.stringify(drop)) setDrop(d)
  }
  const finish = (e: DragEvent<HTMLElement>, apply: () => void) => {
    e.preventDefault()
    e.stopPropagation()
    apply()
    endDrag()
  }

  const addNew = () => {
    if (!newName.trim()) return
    updateFav((f) => addGroup(f, newName).fav)
    setNewName('')
  }
  const commitRename = () => {
    if (renaming) updateFav((f) => renameGroup(f, renaming.id, renaming.text))
    setRenaming(null)
  }
  const remove = (g: FavGroup) => {
    if (g.recipes.length && !window.confirm(`Delete the group "${g.name}"? Its ${g.recipes.length} recipe${g.recipes.length === 1 ? '' : 's'} will no longer be favorites.`)) return
    updateFav((f) => deleteGroup(f, g.id))
  }

  const canDragRows = sort === null

  return (
    <div className="fav-view">
      <div className="fav-bar">
        <input
          className="fav-new" placeholder="New group name" value={newName}
          onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addNew()}
        />
        <button className="button" onClick={addNew} disabled={!newName.trim()}>Add group</button>
        {sort
          ? <span className="muted">Sorted by a column in every group; dragging recipes is off. <button className="button" onClick={() => setSort(null)}>Your order</button></span>
          : <span className="muted">Your order: drag ⠿ to rearrange recipes, or a group's ⠿ to move the group. Click a column to sort instead.</span>}
        {searching && <span className="muted">Search applies: only matching favorites are shown.</span>}
      </div>
      <div className={exit !== 'all' ? 'rlist r-fav r-single' : 'rlist r-fav'}>
        <ListHead sort={sort} exit={exit} onSort={(key) => setSort((s) => nextSort(s, key))} />
        {favorites.groups.length === 0 && (
          <div className="rempty">
            No favorites yet. Click ☆ on a recipe in the List (it goes to Unsorted), or open a recipe and pick a group under Favorites.
          </div>
        )}
        {favorites.groups.map((g) => {
          const rows = g.recipes.map((id) => rowsById.get(id)).filter((r): r is RecipeRow => !!r)
          const shown = sort ? sortRows(rows, sort, exit) : rows
          const isCollapsed = collapsed.has(g.id)
          const dropCls = drop?.kind === 'group' && drop.id === g.id ? (drop.after ? ' fav-drop-after' : ' fav-drop-before')
            : drop?.kind === 'into' && drop.id === g.id ? ' fav-drop-into' : ''
          return (
            <section key={g.id} className="fav-group">
              <div
                className={`fav-ghead${dropCls}`}
                onDragOver={(e) => {
                  if (drag?.kind === 'recipe') over(e, { kind: 'into', id: g.id })
                  else if (drag?.kind === 'group') over(e, { kind: 'group', id: g.id, after: lowerHalf(e) })
                }}
                onDrop={(e) => finish(e, () => {
                  if (drag?.kind === 'recipe') updateFav((f) => moveRecipe(f, drag.id, g.id))
                  else if (drag?.kind === 'group' && drop?.kind === 'group') updateFav((f) => moveGroup(f, drag.id, { id: g.id, after: drop.after }))
                })}
              >
                <span
                  className="fav-grip" draggable title="Drag to move this group"
                  onDragStart={(e) => startDrag({ kind: 'group', id: g.id }, e, e.currentTarget.parentElement)} onDragEnd={endDrag}
                >⠿</span>
                {renaming?.id === g.id ? (
                  <input
                    className="fav-rename" autoFocus value={renaming.text}
                    onChange={(e) => setRenaming({ id: g.id, text: e.target.value })}
                    onKeyDown={(e) => (e.key === 'Enter' ? commitRename() : e.key === 'Escape' && setRenaming(null))}
                    onBlur={commitRename}
                  />
                ) : (
                  <button className="fav-gname" onClick={() => toggleCollapsed(g.id)} aria-expanded={!isCollapsed}>
                    <span className="fav-caret">{isCollapsed ? '▸' : '▾'}</span> {g.name}
                    <span className="fav-gcount">{searching ? `${rows.length} of ${g.recipes.length}` : g.recipes.length}</span>
                  </button>
                )}
                <span className="fav-gactions">
                  <button className="link" onClick={() => setRenaming({ id: g.id, text: g.name })}>rename</button>
                  <button className="link" onClick={() => remove(g)}>delete</button>
                </span>
              </div>
              {!isCollapsed && shown.map((r) => {
                const id = r.recipe.id
                const cls = drop?.kind === 'recipe' && drop.id === id ? (drop.after ? ' fav-drop-after' : ' fav-drop-before') : ''
                return (
                  <div
                    key={id} className={`fav-item${cls}${drag?.kind === 'recipe' && drag.id === id ? ' fav-dragging' : ''}`}
                    onDragOver={(e) => drag?.kind === 'recipe' && canDragRows && over(e, { kind: 'recipe', id, after: lowerHalf(e) })}
                    onDrop={(e) => finish(e, () => {
                      if (drag?.kind === 'recipe' && drop?.kind === 'recipe') updateFav((f) => moveRecipe(f, drag.id, g.id, { id, after: drop.after }))
                    })}
                    onDragEnd={endDrag}
                  >
                    <Row r={r} open={open.has(id)} exit={exit} onToggle={toggle} fav onStar={onStar} onGrip={canDragRows ? onGrip : undefined} />
                    {open.has(id) && <Card r={r} p={p} />}
                  </div>
                )
              })}
              {!isCollapsed && !searching && g.recipes.length === 0 && (
                <div
                  className={`fav-empty${drop?.kind === 'into' && drop.id === g.id ? ' fav-drop-into' : ''}`}
                  onDragOver={(e) => drag?.kind === 'recipe' && over(e, { kind: 'into', id: g.id })}
                  onDrop={(e) => finish(e, () => drag?.kind === 'recipe' && updateFav((f) => moveRecipe(f, drag.id, g.id)))}
                >
                  Empty: drag a recipe here, or pick this group under Favorites in a recipe's card.
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
