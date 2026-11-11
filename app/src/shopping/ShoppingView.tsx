import { useMemo, useState } from 'react'
import { formatMoney, sourceLabel } from '../format'
import type { Edits, GameData, ModelResult } from '../model'
import { NumberField } from '../NumberField'
import { auctionatorImport, defaultListName, removeRecipe, setCount, setListName, setTick, shopLines } from './list'

export function ShoppingView({ game, result, edits, update }: {
  game: GameData
  result: ModelResult
  edits: Edits
  update: (fn: (cur: Edits) => Edits) => void
}) {
  const shopping = edits.shopping
  const lines = useMemo(() => shopLines(game, result, shopping), [game, result, shopping])
  const recipes = useMemo(() => new Map(game.recipes.map((r) => [r.id, r])), [game])
  const autoName = defaultListName(game, shopping)
  const listName = shopping.listName ?? autoName
  const text = auctionatorImport(listName, lines)
  const [copied, setCopied] = useState<string | null>(null)

  if (!shopping.recipes.length) {
    return (
      <div className="shop">
        <div className="sgroup">
          <h2>Shopping list</h2>
          <p className="hint">Nothing chosen yet. In the List, open a recipe and press <b>Add to shopping list</b>; it comes here with a
            number of crafts, and this page turns the reagents into a list you can import into Auctionator.</p>
        </div>
      </div>
    )
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied('Copied. In game: Auctionator > Shopping > Import, paste, OK.')
    } catch {
      setCopied('Could not copy here: select the text below and press Ctrl+C.')
    }
  }

  return (
    <div className="shop">
      <div className="sgroup">
        <h2>Recipes</h2>
        {shopping.recipes.map(({ id, count }) => {
          const r = recipes.get(id)
          const made = r ? (r.qtyMin + r.qtyMax) / 2 : 1
          return (
            <div key={id} className="srow shop-recipe">
              <span className="shop-rname">{r ? r.name : `Recipe ${id} (not in the game data)`}{r && <span className="muted"> · {r.profession}</span>}</span>
              <label>crafts <NumberField value={count} min={0} integer onCommit={(n) => update((cur) => setCount(cur, id, n))} /></label>
              {made !== 1 && <span className="muted">makes {made} each</span>}
              <button className="link" onClick={() => update((cur) => removeRecipe(cur, id))}>remove</button>
            </div>
          )
        })}
      </div>

      <div className="sgroup">
        <h2>To buy</h2>
        <table className="shop-lines">
          <thead>
            <tr><th /><th>Item</th><th className="num">Qty</th><th className="num">Price used</th><th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key} className={`${l.parent !== null ? 'shop-alt' : ''}${l.ticked ? '' : ' shop-off'}`}>
                <td><input type="checkbox" checked={l.ticked} onChange={(e) => update((cur) => setTick(cur, l, e.target.checked))} /></td>
                <td>
                  {l.parent !== null && <span className="muted">or </span>}{l.name}
                  {l.maker && <span className="muted shop-note"> · or craft it ({l.maker})</span>}
                </td>
                <td className="num">{l.qty.toLocaleString()}</td>
                <td className="num">{l.unit === null ? <span className="miss">unpriced</span> : <>{formatMoney(l.unit)} <span className="muted">{sourceLabel(l.source)}</span></>}</td>
                <td className="shop-note">
                  {l.vendor && <span className="muted">vendor sells it</span>}
                  {l.edited && <span className="dflt">changed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">Indented "or" lines are the ingredients of the reagent above, enough to craft all of it. Ticks start on the app's
          cheapest path: the ingredients where it crafts the reagent, the reagent itself where it buys (Intermediates and Settings decide which).
          Items a vendor sells start unticked. Changing a tick here affects only this list. An item on two ticked lines is listed once with the total.</p>
      </div>

      <div className="sgroup">
        <h2>Auctionator import</h2>
        <div className="srow">
          <label>List name <input className="shop-name" value={listName} onChange={(e) => update((cur) => setListName(cur, e.target.value === autoName ? null : e.target.value))} /></label>
          {shopping.listName !== null && <button className="link dflt" onClick={() => update((cur) => setListName(cur, null))}>use {autoName}</button>}
        </div>
        <textarea className="shop-text" readOnly value={text} rows={4} onFocus={(e) => e.target.select()} />
        <div className="srow">
          <button className="button primary" onClick={copy}>Copy</button>
          {copied && <span className="muted">{copied}</span>}
        </div>
        <p className="hint">Importing a list whose name already exists in Auctionator replaces it, so re-importing after a change updates it in place.</p>
      </div>
    </div>
  )
}
