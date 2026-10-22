# WoW Forever shuffle app

A web app for finding profitable crafting shuffles in WoW Forever (a Classic-era realm type). For every recipe it
compares the cost of the reagents with three exits for the crafted item: **vendor it**, **disenchant it**, or
**sell it on the auction house**. It replaces a Google Sheets workbook built by `tools/build_forever_shuffle_sheet.py`
(v2.5). The workbook's numbers are the reference: the app must reproduce them (see Parity).

The user is Josh. He uses this for discovery in analysis sessions with freshly pulled prices, not moment-to-moment
trading. He prefers direct, precise communication and honest assessment over validation.

## Hard rules

- **Never use Wowhead auction-house data** (`avgbuyout` or any market field on Wowhead pages). Josh considers it
  unreliable. Wowhead *game* data (names, vendor sell/buy prices, recipes, item level/quality) is fine.
  `tools/parse_pages.py` reads item fields from a whitelist; keep it that way.
- **`data/private/` is never committed.** The repo is public (GitHub Pages). It holds the raw Wowhead pages, the
  workbooks, Josh's exported edits and the parity reference. `.gitignore` covers it; check `git status` before commits.
- **Before changing the economic model or the design, show what will change and get a yes.** Routine UI and bug fixes
  don't need sign-off; changes to how a number is calculated do. When a rule changes, update the Model section here
  in the same commit.
- Josh handles some things manually on purpose. Don't add them unless asked: recipe source (trainer/vendor/drop),
  throughput and liquidity, disenchant edge cases, buy-side vs sell-side price spreads, deposits.

## Layout

```
tools/parse_pages.py            saved Wowhead pages -> app/public/game-data.json (committed)
tools/export_workbook_edits.py  one-time: workbook edits -> data/private/edits-v2.5.json (import in the app)
tools/export_parity.py          calculated workbook -> data/private/parity-v2.5.json (test reference)
tools/auctionator_to_imports.py reference implementation of the Auctionator reader, to port to TypeScript
tools/build_forever_shuffle_sheet.py  the spreadsheet builder (v2.5), kept until the app reaches parity
data/config/de-table.json       default disenchant table (Classic item-level bands), with material item IDs
data/config/defaults.json       default settings and the cooldown-craft rule
data/private/                   git-ignored: pages/, workbooks, edits-v2.5.json, parity-v2.5.json
app/                            the web app (to be built: Vite + React + TypeScript + AG Grid Community)
```

## Architecture

- **Game facts** come from `parse_pages.py` as one JSON: recipes (id, name, profession, skill, product, qtyMin,
  qtyMax, reagents[{item, qty}]) and items (id, name, sell, buy, and for crafted items quality, class, ilvl).
  Everything is keyed by **item ID** (the workbook keyed by name).
- **Economics run in the browser** in one pure TypeScript module (`app/src/model/`): inputs are game data, config
  and the user's edits; output is one row per recipe plus the intermediates. No UI code in the model. It should
  recalculate everything in well under a second on edit.
- **Prices**: Josh drops `Auctionator.zip` (his SavedVariables, zipped) onto the page. Port
  `tools/auctionator_to_imports.py` to TypeScript (unzip with a small library such as fflate; Lua string unescape;
  minimal CBOR decoder). It yields per item ID: p1 = latest lowest buyout, p2 = median of the last 7 daily lows,
  p3 = lowest of those. Also keep a paste/CSV import with the same columns (item ID, name, p1, p2, p3) for other sources.
  Done in `app/src/prices/` (a bare Auctionator.lua is accepted too: the browser reads it as bytes, so it cannot be
  text-mangled). A price import replaces only `imports` (and `importsInfo`: source, time, count, shown in the toolbar);
  typed prices and other edits are untouched. The Vitest suite runs the Python reference on the same synthetic zip when
  Python is available and requires identical rows.
- **Edits** (typed prices, vendor-buy curation, settings, Allow crafting, Use chains, DE table, imported prices) are
  one JSON document in the `shuffle-edits` format (`format: "shuffle-edits", version: 1`, what
  `export_workbook_edits.py` writes), with Export/Import of a JSON file.
  Storage (decided with Josh, 2026-10-22): the primary store is a file on Josh's disk that he picks once (e.g.
  `data/private/shuffle-edits.json` or a OneDrive folder), auto-saved on every edit via the File System Access API
  (Chrome/Edge), with a visible save status. `localStorage` (one versioned key) is the fallback and cache, and the
  only store in browsers without that API. All storage goes through one module (load / save / status / choose
  location), so the backend can be swapped later (e.g. a cloud database) without touching the model or UI. Wrap
  storage access in try/catch.
- **Updates**: new Wowhead pages -> run `parse_pages.py`, review the printed changes, commit `game-data.json`.
  New prices -> drop the Auctionator zip in the app (no commit). Rule or UI changes -> code.

## Model (must match the workbook)

All money is in copper (1g = 10000). "Blank" means unknown/unpriced, never zero.

**Quantity made**: `(qtyMin + qtyMax) / 2` (the parser already maps Wowhead's 0 to 1).

**Price used for reagent cost** (per item): typed price, else vendor buy price if *Use vendor buy price* is on and the
item has a curated vendor buy price, else imported price if *Use imported prices* is on, else blank.
- Vendor buy price = Wowhead `buy`, unless the user's `vendorBuyOverrides` has the item (`null` = no vendor sells it).
  Wowhead lists nominal buy prices for many items nobody sells, so this is curated by hand.
**Price used for selling** (DE materials and crafted products): typed price, else imported price. Never a vendor price.
**Imported price**: the chosen column (1, 2 or 3) for the item ID; 0 or blank counts as no price.

**Vendor side** (from game data): vendor value per craft = `round(sell x qtyMade)`; blank if the product has no sell
price. Reagents vendor value = sum of `sell x qty` over reagents with a sell price (count the ones without).

**Intermediates** (upstream make-vs-buy): every reagent that some recipe creates.
- Maker: the first recipe (profession order Tailoring, Leatherworking, Blacksmithing, Engineering, Enchanting, Alchemy,
  First Aid, Cooking, Mining; then page order) that is not a cooldown craft; if all makers are cooldown crafts, the
  first one, with Allow crafting defaulting to No. Cooldown crafts: name starts with "Transmute", or "Mooncloth".
- Craft cost (each) = sum of `qty x best cost of the sub-reagent` / qtyMade of the maker. Blank if Allow crafting is
  No, the maker's profession toggle is off, or any sub-reagent is unpriced.
- Buy price = the item's price used for reagent cost. Best cost = lower of buy and craft (ties: Buy).
  Source = Craft if craft < buy (or buy blank), else Buy.
- Loops: depth-first over intermediates in case-insensitive name order; a back edge prices that sub-reagent at its
  buy price (the workbook lists where). Chains of any depth otherwise resolve.

**Recipe costs**: buy all = sum of `qty x price used for reagent cost`; cheapest path = sum of `qty x best price`, where
best price is the intermediate's best cost for craftable reagents unless the recipe's *Use chains?* is No (then the
plain reagent price). Each is blank if any reagent is unpriced. Crafted inputs = the top-level reagents whose source is Craft.

**Disenchant**: a product is disenchantable if quality is 2/3/4 (Uncommon/Rare/Epic) and class is 2 (Weapon) or
4 (Armor). Its band is the first DE-table row with that quality, type (Weapon/Armor, or Any) and ilvl in range.
- Value per disenchant = sum over results of `chance x avg qty x selling price`, where avg qty = (min+max)/2; blank
  unless every result with chance x avg qty > 0 is priced.
- Multiplier = `(1 + flat bonus) x (1 + proc chance x extra per proc)` if the Arcane Salvager is on, else 1.
- Expected DE value = value per disenchant x qtyMade x multiplier x (1 - AH cut).

**AH exit**: AH value per craft = selling price of the product x qtyMade x (1 - AH cut). One AH cut (default 5%)
applies to DE materials and crafted items. Deposits and liquidity are not modeled.

**Profits**: profit for an exit = exit value - cheapest path; blank if either is blank.
**Best exit**: among the exits that apply (Vendor if the product has a sell price; Disenchant if it has a band; AH
always), the priced one with the highest value; ties go Vendor, then Disenchant, then AH. If none is priced:
"No priced exit". Label any applicable exit that is unpriced: e.g. "Vendor (DE, AH unpriced)".
**Profit at best exit** = highest priced exit value - cheapest path.
**Beats reagents?** per exit: exit value > reagents vendor value. "Any exit" = Yes if any is Yes, else "No", or
"No (DE, AH unpriced)" when exits are unpriced.

Known workbook quirks to preserve or consciously change (ask): six same-name recipe pairs exist and are told apart
by recipe ID. Decided: the workbook matched items by name, so two items sharing a name shared one price row; the app
prices every item by its own ID (Josh, 2026-10-22). Parity differences this causes are listed in `parity.test.ts`.

## UI (what Josh wants)

The core is a clean, fast way to view and filter everything the Recipes tab shows.
- Recipes **List** (the main view; redesigned with Josh on 2026-10-22 after the workbook-style grid proved too
  wide to scan): one compact row per recipe (name with profession · skill · product underneath, best-exit badge,
  amber marker for unpriced exits, profit green/red, cost, return), sortable, with quick filters for search,
  profession, minimum profit at best exit and hiding unpriced rows. Clicking a row expands it in place into a
  two-column card: left = each exit's value and profit with a plain-language line on how it is worked out (best
  starred), plus item info; right = cost breakdown (each reagent's price and source, crafted reagents with one level
  of sub-reagents scaled to the quantity needed and the buy-instead comparison, cheapest path and buy-all totals,
  unpriced reagents). This is the recipe drill-down that replaces the Chain view tab; its totals reconcile to the
  cheapest path (`app/src/model/detail.ts`, tested in `detail.test.ts`).
- Recipes **Table** (secondary, toolbar toggle): the full-column AG Grid view with collapsible groups, for sorting or
  filtering on any column. Loaded on demand. Revisit whether to keep it once the List has been used for a while.
- Intermediates view with the Allow crafting toggle; Prices view (typed price entry in g/s/c, vendor-buy curation,
  which source each price came from, item usage: reagent / DE material / craftable / product); DE table editor;
  Settings; Auctionator drop zone; Export/Import of edits.
- Money displayed as `1g 23s 45c`.

## Parity

`app` tests (Vitest) load `app/public/game-data.json`, `data/config/*`, `data/private/edits-v2.5.json` and compare
against `data/private/parity-v2.5.json` (per recipe: buyAll, cheapest, vendorValue, deValue, ahPrice, ahValue,
profits, bestExit, craftedInputs; per intermediate: buy, craft, best, source). Tolerance 0.5 copper. Skip with a clear
message when the private files are missing. Every difference must be explained (e.g. name vs ID matching) before the
app is called done; report them to Josh rather than adjusting the reference.

## Build plan and status

Josh's way of working: one step at a time, stop after each for him to check, one commit per approved step.
He will view and test the app himself after the first pass (step 5); until then Claude verifies each step in a
headless Chrome (playwright-core with the installed Chrome, scripts kept out of the repo).
1. Model + Vitest parity tests: **done** (293337f). Known differences are listed in `parity.test.ts`.
2. Recipes grid: **done**. Result group (best exit, profit) sits right after Skill; money filters are in gold; groups start collapsed.
3. Edits storage: **done**. `app/src/storage/`: File menu (Import, Export, Create/Open save file, Stop saving), save
   status in the toolbar, newest `savedAt` wins between file and browser, an unreadable save file is never overwritten.
4. Auctionator import: **done**. Drop a file anywhere on the page (.zip/.lua prices, .csv prices, .json edits), or use
   File > Import Auctionator.zip / Paste prices; a realm picker appears when the file has several realms.
5. GitHub Pages workflow: **done** (`.github/workflows/deploy.yml`). First pass complete once pushed and live.
Next phase, in this order (same way of working: one step, stop, one commit):
6. Recipes List redesign with expanding detail cards (includes the drill-down): **done**, see UI section.
7. Settings view. 8. Prices view. 9. Intermediates view (+ Use chains toggle). 10. DE table editor.

## Deploy

GitHub Pages via GitHub Actions on push to `main` (`.github/workflows/deploy.yml`: `npm ci`, tests, build `app/`,
upload `app/dist`). Vite `base` must be `/<repo-name>/`: the repo is `jckim014/wow-forever-tool`, so the base is
`/wow-forever-tool/` and the site is https://jckim014.github.io/wow-forever-tool/ (local folder name differs).
The site is public; it contains only game data and code.
