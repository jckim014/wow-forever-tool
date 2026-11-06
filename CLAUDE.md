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
tools/fetch_binding.py          products' bind type from Forever item tooltips -> game-data.json (cache in data/private/)
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
  qtyMax, reagents[{item, qty}]) and items (id, name, sell, buy, and for crafted items quality, class, ilvl, and for products bind).
  `bind` ("pickup" / "equip" / "use" / "none") comes from `fetch_binding.py`: it reads only the bind line (after the
  `<!--bo-->` marker) of `nether.wowhead.com/forever/tooltip/item/<id>`, caches results in `data/private/binding.json`
  (which `parse_pages.py` also applies), and reports anything it can't read as unknown rather than guessing. Has
  `--selftest` with real tooltip excerpts. First run 2026-11-05: 2,024 products, 0 unknown; Josh was given a
  10-item spot-check list (not yet reported back).
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
  typed prices and other edits are untouched. **Linked file** (Josh, 2026-11-02): File > Link Auctionator.lua keeps
  the file handle in IndexedDB (`app/src/prices/linked.ts`, per browser, read-only access). When the app opens (after
  the edits have loaded) it re-imports the file if its lastModified changed since the last linked import; the toolbar's
  Refresh now also re-imports when the current prices came from elsewhere. No polling (WoW only writes SavedVariables on
  /reload, logout or exit). A realm chosen for a multi-realm file is remembered with the link. The Vitest suite runs the Python reference on the same synthetic zip when
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
- **Updates**: new Wowhead pages -> run `parse_pages.py`, then `fetch_binding.py` (fetches only new products), review the
  printed changes, commit `game-data.json`. Saved page filenames only need to start with the profession name.
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
applies to DE materials and crafted items. Deposits and liquidity are not modeled. The AH exit does not apply to a
product that binds when picked up (Josh, 2026-11-05): AH value, AH profit and AH beats reagents are blank, it is never
the best exit and never labelled unpriced (like Disenchant for an item with no band). The AH price itself still shows.

**Profits**: profit for an exit = exit value - cheapest path; blank if either is blank.
**Best exit**: among the exits that apply (Vendor if the product has a sell price; Disenchant if it has a band; AH
unless the product is BoP), the priced one with the highest value; ties go Vendor, then Disenchant, then AH. If none is priced:
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
  unpriced reagents; every craftable reagent always shows both Craft and Buy, with the ✓ on the one used, and a craft
  that is switched off still shows what it would cost, marked "off": Josh, 2026-10-23, reversing an earlier choice). This is the recipe drill-down that replaces the Chain view tab; its totals reconcile to the
  cheapest path (`app/src/model/detail.ts`, tested in `detail.test.ts`).
- **Exit switch** (toolbar: All · Vendor · Disenchant · AH, Josh, 2026-11-05; replaced the Vendor only checkbox of
  2026-11-01, `exitFigures` in `recipes/filter.ts`). All = best exit. Each single exit lists only recipes where that
  exit applies (Vendor: product has a vendor price; Disenchant: product has a DE band; AH: product isn't BoP) and judges
  them on that exit alone, as Vendor only did: Vendor lists only recipes whose product has a vendor price and judges
  them on the vendor exit alone. The Best exit column goes; Profit = vendor profit, Return = vendor value per craft;
  Min profit and Hide unpriced use vendor profit. Display and filtering only, no new calculation. Cost is deliberately
  still the cheapest path, so it can include AH-priced reagents (Josh chose this over a vendor-bought-only cost). The
  recipe card still shows all exits, and the Table keeps all its columns (the same row filter applies). Sorting by
  Return in this mode is how Josh browses by raw vendor sell value before he has real prices. Disenchant and AH work
  the same way with DE / AH profit and value.
- **Hide BoP** (toolbar checkbox, Josh, 2026-11-05): hides recipes whose product binds when picked up, in any view
  (the AH view leaves them out anyway). The recipe card's Item line shows the bind type.
- Recipes **Table** (secondary, toolbar toggle): the full-column AG Grid view with collapsible groups, for sorting or
  filtering on any column. Loaded on demand. Revisit whether to keep it once the List has been used for a while.
- Prices, Intermediates, DE table and Settings views (details in Build plan steps 7-10); Auctionator drop zone;
  Export/Import of edits.
- Money displayed as `1g 23s 45c`.
- User-entered prices are called **custom** in the UI (the model and the edits file keep the name `typed`/`typedPrices`).
  Cost lines in the detail card use dot leaders from the reagent name to its price; amounts in the card's columns are
  padded (`2s 04c`) so they line up; only top-level reagents have amounts in the price columns (they sum to the
  cheapest path), and each craftable reagent's ingredients are indented text with Craft/Buy badges (totals for the
  quantity needed; the Intermediates view also shows a switched-off craft cost, in grey; `potentialCraft` in `detail.ts`). The List has a sortable Skill column (hidden on phones); its columns form two groups, name + skill on the
  left and best exit + money on the right, with the spare width between them.

## Parity

`app` tests (Vitest) load `data/private/game-data-v2.5.json` (a frozen copy of the game data as of 9e862ab, so new
Wowhead pages don't break the test: it guards the calculations, not the data), `data/config/*`,
`data/private/edits-v2.5.json` and compare
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
7. Settings view: **done**. Toolbar List · Table · Settings; `app/src/settings/`. Groups: Prices (vendor buy, imports,
   import column), Selling (AH cut), Arcane Salvager (with the live multiplier), Crafting chains per profession.
   `edits.settings` keeps only values that differ from the defaults; each changed value shows its default and a reset.
   The cooldown-craft rule stays in `defaults.json`, not the UI.
8. Prices view: **done**. `app/src/itemprices/` (named so it isn't confused with the importer in `app/src/prices/`).
   One row per reagent, product and DE material (~2,400), all shown at first; usage tags; custom price in three
   g/s/c boxes; vendor-buy curation per reagent (Wowhead price / No vendor sells it / Other price); imported price;
   one "Price used" column (cost for a reagent, sale price otherwise, with a "sells for" line and a "Vendor ≠ AH" filter
   for the rare items where the two differ, i.e. vendor flips). Filters: search, usage chips, custom only, vendor buy
   edited, unpriced (for the item's use). Opening the view takes about a second (all rows have inputs).
9. Intermediates view: **done**. `app/src/intermediates/`. One row per intermediate (163): maker recipe (cooldown tag),
   level (crafting depth), Allow crafting switch (greyed when the profession's chain is off in Settings; an edit equal
   to the default is not marked, and switching back to the default removes the edit), buy / craft / best; click a row for its ingredients, loop and also-made-by
   notes. Filters: search, profession, Craft / Buy / Unpriced, crafting off. The per-recipe Use chains switch is in the
   recipe card's Cost section ("Craft reagents for this recipe when cheaper").
10. DE table editor: **done**. `app/src/detable/`. Bands grouped by item-level range; per band: results (material from
   the 24 known materials, chance %, min-max quantity, add/remove up to 3), note, value per disenchant at current sale
   prices (before Salvager and AH cut), recipes in the band; warnings when chances don't add to 100% or min > max.
   No structure editing (ranges, adding/removing bands), by Josh's choice. `edits.deTable` is the whole table while
   any band differs from the default, else null; a band shows "changed" by comparison, so the workbook's identical copy
   counts as unedited. Filters: only bands with recipes, changed only. Reset per band and for the table.

All ten steps are done and live (last: 7b3bbc4, 2026-10-23). Next phase: Josh uses the app and comes back with bugs
and iterations. Same way of working: show what will change (screenshots for UI), one change set, his check, one
commit; push only when he says.

Where we left off (2026-11-02): the linked Auctionator.lua shipped and is live (aa16929). Josh tested it on localhost
with the real Chrome picker on his F: drive (works; not under Program Files, so Chrome's system-folder block doesn't
apply). He links it once on the live site. Forever does not have Auctionator data yet: next time, after his first
Forever scan and /reload, he switches the link (File > Link a different Auctionator.lua) to
`F:\World of Warcraft\_forever_\WTF\Account\THOROCKTHEBOLD\SavedVariables\Auctionator.lua`, and the import checks in
the Auctionator item below apply. Interim prices come from the beta file
`F:\World of Warcraft\_classic_beta_\WTF\Account\1120039#1\SavedVariables\Auctionator.lua` (v8, realm "PvE", 3,247
items, 7 scan days; the source of the 2026-10-22 import). Advised Josh not to copy it into `_forever_` (Auctionator
would load the beta realm's data there).

Open items to raise when relevant:
- Current imported prices (2026-10-22, "Auctionator (PvE)") include an outlier: many recipes show a best-exit return of
  exactly 24,938g 53s, probably one DE material. Josh knows and said to ignore it; don't raise it again for this data.
- Auctionator: no real Auctionator file from Josh's Forever install has been imported yet. Old Desktop backups
  (Benediction, 2023) use price database v6 (a plain Lua table), which both readers reject as "price database is
  empty"; the readers only handle v8 (CBOR string). If Josh's file hits that, add a v6 reader (unlikely: his beta and
  retail installs write v8; Josh has had v6 vs v8 explained). Desktop WTF copies at
  `C:\Users\bavvb\Desktop\WTF` are old backups, not the Forever install.
  Josh will provide a real file later and check the imported columns himself (decided 2026-10-23). Ideas discussed and
  parked until then: an item check panel (the dated daily lows behind p1/p2/p3, to compare with Auctionator's in-game
  price history; needs the import to keep 7 dated lows per item), column names that travel with the import (so a CSV
  or TSM source isn't labelled "median of 7"), and a TSM reader if he uses TSM (needs a real TSM file first).
- Not exercised for real yet: Chrome's file-picker and permission prompts for the save file (Josh has since created
  his save file, so they work at least for creation).
- Revisit whether to keep the Table view (and AG Grid) once the List has been used for a while.
- Offered, not taken: size the List's name column to the longest visible name (Skill would sit closer to the names);
  in the Prices view, show the g/s/c boxes only on the clicked row if the ~1 s open time bothers him; a vendor-flip
  analysis (only the "Vendor ≠ AH" filter exists; flips are outside the app's job).
- Possibly stale Wowhead vendor prices seen in the Vendor ≠ AH filter (Major Mana Potion 60s, Tinkerbox 1g, Lesser
  Mana Potion, Mote of Magic): Josh may want to check them in game and curate.
- Test data caveat: `data/private/edits-v2.5.json` (the workbook export) has "Chains: craft with Mining" = No, so
  headless checks seeded from it show Mining off; Josh's own save file has Mining on. His save file is the truth.

Working notes:
- `app/src/App.css` is one global stylesheet. Two bugs came from generic class names colliding across views (`.num`,
  `.sub`). Give new view-specific classes a prefix (the views use `s*`, `p*`, `i*`, `d*`, `r*`) and grep before adding.
- Views: List · Table · Prices (`itemprices/`) · Intermediates (`intermediates/`) · DE table (`detable/`) · Settings
  (`settings/`). Pure logic sits next to each view with a `.test.ts`; the model stays in `model/`.
- Verification setup: headless Chrome via playwright-core (installed in the session scratchpad, which is temporary;
  reinstall with `npm install playwright-core` in a scratch folder and launch with `channel: 'chrome'`). Seed it by
  writing a shuffle-edits doc to localStorage key `wow-forever-shuffle:edits:v1` before load; the dev server runs
  with `npx vite --port 5199` in `app/` (URL http://localhost:5199/wow-forever-tool/).
- Deploy status without `gh` (not installed): `curl https://api.github.com/repos/jckim014/wow-forever-tool/actions/runs?per_page=1`.

## Deploy

GitHub Pages via GitHub Actions on push to `main` (`.github/workflows/deploy.yml`: `npm ci`, tests, build `app/`,
upload `app/dist`). Vite `base` must be `/<repo-name>/`: the repo is `jckim014/wow-forever-tool`, so the base is
`/wow-forever-tool/` and the site is https://jckim014.github.io/wow-forever-tool/ (local folder name differs).
The site is public; it contains only game data and code.
