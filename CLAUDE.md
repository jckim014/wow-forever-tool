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
addon/BavvbScan/                Josh's own WoW addon: /bscan full AH scan -> SavedVariables\BavvbScan.lua (the price source)
collector/                      auction collector: cloud fetch (GitHub Actions) + PC sync to F:\ForeverAuctionData (see Collector)
.github/workflows/collect.yml   runs collector/collect.mjs, uploads snapshots as artifacts
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
  `--selftest` with real tooltip excerpts. First run 2026-11-05: 2,024 products, 0 unknown; Josh spot-checked
  10 items (BoP, BoE, no bind) against the game/Wowhead and confirmed them.
  Everything is keyed by **item ID** (the workbook keyed by name).
- **Economics run in the browser** in one pure TypeScript module (`app/src/model/`): inputs are game data, config
  and the user's edits; output is one row per recipe plus the intermediates. No UI code in the model. It should
  recalculate everything in well under a second on edit.
- **Prices (BavvbScan, the main source since 2026-11-10)**: Josh's own addon (`addon/BavvbScan/`, copied into
  `F:\World of Warcraft\_forever_\Interface\AddOns\`), built after an Auctioneer update (4.0.3, 2026-11-10) stopped
  it loading and Josh dropped Auctioneer. At the AH, `/bscan` sends one full-scan request (`C_AuctionHouse.ReplicateItems`),
  counts the server as answered on REPLICATE_ITEM_LIST_UPDATE or when the replicate count changes from its size at the
  request, then waits until the count has stopped growing for 15 s (60 s while under 80% of the previous scan's count:
  on this server auctions arrive in waves and the event can fire on the first); the waiting line shows the live count, reads every listing (GetReplicateItemInfo:
  count 3, stack buyout 10, item ID 17; listings whose data isn't loaded are retried 5 times, then counted as skipped)
  and saves `BavvbScanDB.scan = { format "bavvbscan", version 1, realm, faction, time, auctions, listings, bidOnly,
  skipped, items = { [id] = "count:buyout,..." } }`. Only complete scans are saved (Josh: no partial scans; AH closed
  or server silent for 5 min (Josh's choice; scans arrive in ~2 min) = an error and the previous scan stays). `lastRequest` in the saved file enforces the
  15-minute limit across /reload. `/bscan status` shows the last scan and the next allowed time; `/bavvbscan` is an
  alias. While a scan runs a large panel covers the middle of the screen (75% x 70%; Josh, 2026-11-11: he alt-tabs
  between accounts and moves by muscle memory on return): amber "AH SCAN RUNNING / Don't move or close the auction
  house" with the live count, then green "SCAN SAVED" with a Reload button and the ready-check sound, or red "SCAN
  FAILED" with the reason and the raid-warning sound. Clicks pass through it. `/bscan demo` (`demo fail`) plays it
  through a fake 12 s scan without contacting the server. A movement-key lock was built and dropped at Josh's request:
  visual only. 182k auctions = 1.26 MB file (0.23 MB zipped in history). The app reads it with `app/src/prices/bavvbscan.ts` and the
  same p1/p2/p3 as Auctioneer (`pricesFromUnits` in `auctioneer.ts`); recognised by content, works with Import, Link
  and price history (summary `source: "BavvbScan"`). Tested against a simulated AH (fengari, scripts outside the
  repo), then for real 2026-11-10 14:55: 182,071 auctions, 4,870 items, 0 skipped, data in ~2 min, file 1.26 MB,
  server key "CAMWOW US1 Realm 3 PvE_Alliance". The first /bscan that day got no answer at all (replicate count stayed
  0 for 10 min; nothing else had requested a scan: Auctionator autoscan and full scan are off, TSM's full scan is
  Mists-only); the next one 15 min later worked. Likely cause, not proven: the price history shows Auctioneer completed
  a full scan at 14:10 that day (after the TOC fix, before Josh removed it), possibly < 15 min before that /bscan. If it happens again, the control is Auctionator's Full Scan button
  (the same request).
- **Prices (Auctioneer, the main source 2026-11-06 to 11-10, now uninstalled; the reader stays)**: Auctioneer's `Auc-ScanData.lua` holds every listing of
  the last full scan per realm/faction (`app/src/prices/auctioneer.ts`; listing fields from Auc-Advanced
  `CoreConst.lua`: COUNT 11, BUYOUT 17 = whole stack, ITEMID 23). Per item ID, over listings with a buyout, per unit:
  p1 = lowest buyout, p2 = median weighted by units, p3 = average of the cheapest 15% of units (at least one unit).
  Bid-only listings are left out. Only the latest scan is kept (no history yet; Auctioneer's Stat modules were empty
  after the first scan). Josh's file: `F:\World of Warcraft\_forever_\WTF\Account\1120039#2\SavedVariables\Auc-ScanData.lua`
  (account folder 1120039#2, not THOROCKTHEBOLD); first scan copied to `data/private/auctioneer-2026-11-06/`, which
  `auctioneer.test.ts` checks against the figures shown to Josh. Import and Link accept either addon's file (or a zip
  of one), recognised by content; Settings labels the three columns for the source of the current prices.
  Local addon patch (2026-11-06, outside the repo): the Forever build of Auctioneer gave up on its GetAll scan after
  30 s (`Auc-Advanced/CoreScan.lua` line 470, `retailScanTimeout`) while the server took longer (confirmed: 110,860
  replicate items arrived after the timeout). Raised to 120. Second patch (same evening): the scan frame registered for REPLICATE_ITEM_LIST_UPDATE only when created and unregistered after the first reply, so every scan after the first in a session (login or /reload) timed out at 0; it now registers on every scan, and at the 120 s timeout, if auctions are still arriving it keeps waiting in 15 s steps (up to 10 min) and processes them only once the count stops growing (a 16:54 scan was saved with 51,159 of ~130,000 when it processed at 120 s); "server sent 0 auctions" if none came. Original kept as `CoreScan.lua.orig`. An addon update
  undoes it: if scans "time out at 0 auctions" again, check that line first.
  **Price history** (Josh, 2026-11-06; storage only, prices still come from the latest import): File > Keep price
  history in a folder (Chrome/Edge directory handle in IndexedDB, `app/src/history/`). Every imported Auctioneer scan
  is saved there as two files named by the scan's own time (local) and server key, e.g.
  `2026-11-06_0025_CAMWOWUS1Realm3PvE_Alliance.zip` (the whole Auc-ScanData.lua, ~2.3 MB) and `.json` (per item ID:
  lowest, median, cheapest15, units, listings; ~65 KB; written last, so it marks a complete scan; one item per line).
  A scan already stored is skipped. Scans imported while the folder can't be written wait in memory for that visit
  ("Allow saving" in the toolbar). Josh's folder: `data/private/price-history/` (git-ignored). Auctioneer overwrites
  its file on each scan, so a scan is only kept if the app reads it before the next one. Auctionator imports are not
  archived.
- **Prices (Auctionator)**: Josh drops `Auctionator.zip` (his SavedVariables, zipped) onto the page. Port
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
- **Edits** (typed prices, vendor-buy curation, settings, Allow crafting, Use chains, DE table, imported prices, shopping list, favorites) are
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

## Collector (Blizzard API auction history; started 2026-11-12)

A separate backend tool: collect every WoW Forever US auction house's full listings over time for Josh's own trend
analysis, stored on his F: drive. Later (agreed, not started): the app uses these as a baseline price source
alongside BavvbScan/imports, which stay for up-to-the-minute prices.
- **API facts (probed 2026-11-12, from https://blizzard.pinta.land/forever/, not documented by Blizzard)**: OAuth
  client credentials (`oauth.battle.net/token`, token 24 h). Namespace `dynamic-forever-us`. No realms; rulesets
  1 PvP, 2 Normal, 3 RP, 15 RP-PvP all list the same 15 houses with the same data (ruleset doesn't filter):
  110-121, 123-125. `/data/wow/ruleset/2/auctions/{house}` (auctions: buyout/bid per auction) and `.../commodities`
  (unit_price). 112/115/118 are empty (no `auctions` field). Data refreshes hourly at about :22 (all houses within
  seconds); `If-Modified-Since` is honoured (304). Snapshot of all houses ~7.7 MB gzipped (~67 GB/year hourly).
- **Houses**: 111 = Josh's own (Alliance, "CAMWOW US1 Realm 3 PvE"; 91.6% of listings identical to a BavvbScan
  34 min later, other houses <= 22%). Guess from the ID pattern, unconfirmed: groups of Alliance/Horde/Blackwater
  110/113/116, 111/114/117 (Josh's realm), 112/115/118 (empty), 119/120/121, 123/124/125; the two big groups are
  probably PvE and PvP. Confirm with an in-game scan on another house. Josh wants all 15 collected.
- **Cloud side** (`collector/collect.mjs`, pure checks in `lib.mjs` with `node --test collector/*.test.mjs`):
  runs at :06/:26/:46 (was :05/:25/:45; GitHub had not started one scheduled run 1.5 h after the first push, so the
  line was changed on 2026-11-12 to make GitHub register the schedule again). Token reused from the Actions cache, encrypted (AES-GCM, secret `TOKEN_CACHE_KEY`) because
  pull-request workflows in a public repo can read caches. Conditional GETs, 1 s apart, one retry on 5xx/network,
  never on 429. Fails the run (GitHub emails Josh) on: house list change, malformed listings, a house >= 5000
  listings halving, newest data > 3 h old, HTTP errors. New API fields are notes (warnings), not failures. Raw
  responses saved unchanged (gzipped) with `manifest.json` (format `forever-auction-snapshot` v1: per file house,
  kind, lastModified, listings, items, sizes, sha256) as artifact `snapshot-<YYYYMMDDTHHMMSSZ>`, kept 90 days.
  Run workflow has a "test_failure" box: collects normally, then fails on purpose (checks the email and PC alert).
  In the API every regular auction has quantity 1; stacks are commodities (unit_price).
- **PC side** (`collector/sync.mjs`, pure parts in `syncLib.mjs`): Windows task "Forever auction sync"
  (`collector/install-task.ps1`; 2 min after logon and hourly at :40, priority 7, run via `sync-hidden.vbs` so no
  window; node from `C:\nvm4w\nodejs\node.exe`, re-run the installer if that changes). Downloads every `snapshot-*`
  artifact (GitHub token `data/private/github-token.txt`: fine-grained, this repo only, Actions read/write, made
  2026-11-12, ~1 year), checks sha256 against the manifest, writes `F:\ForeverAuctionData\raw\YYYY\MM\DD\<id>\`
  (UTC date of the data; API responses unchanged) and `summary\YYYY\MM\DD\<id>.json.gz` (format
  `forever-auction-summary` v1: per house, per item [lowest, median, cheapest15, units, listings], auctions and
  commodities merged; identical to the app's pricesFromUnits, checked by `app/src/history/collectorSummary.test.ts`),
  then deletes the artifact. Log `F:\ForeverAuctionData\sync.log`; state, lock (and the log if F: is missing) in
  `%LOCALAPPDATA%\ForeverAuctionSync\`. Windows toasts (click opens GitHub): F: not writable, GitHub unreachable twice
  in a row or token rejected, schedule not active, newest data > 3 h old, token expiring within 14 days (lasting
  problems: on start, every 6 h, and "fixed"); failed collector runs, a snapshot that can't be stored (kept on GitHub,
  retried), new collector notes/problems (once each). **Backup for GitHub's scheduler**: if no collector run has
  started for 70 min, the sync starts one (workflow_dispatch); alert if no *scheduled* run for 3 h (a new or edited
  workflow gets 3 h from its update time). `--dry-run` and `--test-notification` flags. First real sync
  2026-11-12: 8.2 MB snapshot in 8.6 s, peak 336 MB; nothing new: 1 s, 56 MB. Summary of 111 vs a BavvbScan 25 min
  earlier: 80% same lowest, 90% cheapest-15% within 5%. No healthchecks.io (Josh: no new accounts), so nothing watches
  while the PC is off.
- Secrets/keys: Blizzard client in `data/private/blizzard-api.json`, cache key in `data/private/token-cache-key.txt`;
  the same values are GitHub secrets `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `TOKEN_CACHE_KEY`.
  GitHub repo settings: fork PR workflows need approval for all external contributors.
- Rate: an idle run is 1 request (sentinel: house 111 auctions unchanged = all unchanged, since all houses refresh within seconds; a run where 111 changed but others did not fails, as the sentinel would then miss data); a full run ~31. About 800 requests/day; Blizzard allows 36,000/hour. Josh: stay well clear of Blizzard limits; chose token reuse per their advice.

## Model (must match the workbook)

All money is in copper (1g = 10000). "Blank" means unknown/unpriced, never zero.

**Quantity made**: `(qtyMin + qtyMax) / 2` (the parser already maps Wowhead's 0 to 1).

**Price used for reagent cost** (per item): typed price, else vendor buy price if *Use vendor buy price* is on and the
item has a curated vendor buy price, else imported price if *Use imported prices* is on, else blank.
- Vendor buy price = Wowhead `buy`, unless the user's `vendorBuyOverrides` has the item (`null` = no vendor sells it).
  Wowhead lists nominal buy prices for many items nobody sells, so this is curated by hand.
**Price used for selling** (DE materials and crafted products): typed price, else imported price. Never a vendor price.
**Imported price**: the chosen column (1, 2 or 3; default 3, Josh 2026-11-06, meant for Auctioneer's average of the
cheapest 15%) for the item ID; 0 or blank counts as no price.

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
- **Shopping** (Josh, 2026-11-10; `app/src/shopping/`, classes `shop-*`): "Add to shopping list" in the recipe card
  brings a recipe into the Shopping view with a number of crafts. Reagents of all chosen recipes are merged by item;
  each craftable reagent (an intermediate) is followed by its maker's ingredients as indented "or" lines, scaled to
  make the whole amount (crafts rounded up), both at full quantity. Ticked lines become an Auctionator shopping-list
  import string (`List^"Name";;;;;;;;;;;#;;qty^...`: 14 `;` fields, tier `#`, quantity last; format from Auctionator
  v345 `Source/Search/Advanced.lua`; importing an existing list name replaces that list), with Copy. Default ticks
  follow the cheapest path (Josh, 2026-11-10): where the model crafts the reagent (intermediate source Craft, and some
  chosen recipe has Use chains on) its ingredients are ticked and it is not; otherwise the reagent is ticked and its
  ingredients not. Items a vendor sells (curated vendor buy price) always start off. Ticks are local to the list and
  deliberately do not write back to Allow crafting (that switch only permits crafting; it can't force it, so a
  two-way link would disagree with the model). An item on several ticked lines is listed once with the total. Stored in `edits.shopping` (recipes + counts,
  ticks that differ from the default, list name); no effect on any calculation.
- **Favorites** (Josh, 2026-11-12; `app/src/favorites/`, classes `fav-*`): a ☆ at the left of every List row stars a
  recipe into the group "Unsorted" (made at the top if missing); a second click unstars it. The recipe card has a
  Favorites picker (Not in Favorites / a group / New group…). The Favorites tab (between List and Table) shows named
  groups as collapsible sections with the List's own rows and cards. One group per recipe (Josh's choice). Groups and
  recipes are in Josh's own order, arranged by dragging the ⠿ grips (a recipe onto a row or another group's header; a
  group onto another group's header). Clicking a column sorts every group by that column and turns recipe dragging off
  until "Your order". Only the search box and the Exit switch apply there (a single exit shows blank figures rather
  than hiding a favorite); Min profit, Hide unpriced, Hide BoP and the profession chips don't, so a favorite never
  disappears because its price moved. Deleting a non-empty group asks first and unstars its recipes. Stored in
  `edits.favorites` (groups: id, name, recipe IDs); collapsed groups are per browser (localStorage). No effect on any
  calculation.
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

2026-11-05: new Wowhead pages parsed (First Aid page left at 2026-10-22 on purpose), exit switch and BoP shipped and
live (2e081d8).
2026-11-06: Auctioneer import with default column 3 (122f61b) and price history (4768e3a), live.
2026-11-11: BavvbScan scan panel + `/bscan demo` (8e94b11); Tailoring page re-saved ("Tailoring - Skill - WoW
  Forever.html"): 13 recipes changed (lower skill, bags need one more bolt), 36 items' vendor sell price about halved
  (Filigreed set, Slippers/Cord/Gloves sets), 12eae5d, live.
2026-11-12: Favorites view (see UI), 571aae3, live. Josh checked screenshots and the design ("looks good") before
  the commit; not yet used on the live site with his own save file.

2026-11-10: Auctioneer 4.0.3 stopped loading (new hard dependency on LoadOnDemand Enchantrix); Josh uninstalled it
and BavvbScan replaced it (see Prices; 40e29a5, c1323de, live). "Sign off" phrase and checklist added.
Same evening: Shopping view (Auctionator shopping-list import for chosen recipes; see UI), f82eec8, live; Josh
checked it on the live site ("looks good").

Where we left off (2026-11-12): Favorites shipped and live (star recipes into named groups, drag to arrange). Next:
Josh uses it with real scans and comes back with iterations. BavvbScan is the price source; its scan panel is in use
("looks good for now"; size/colours may be revisited). The in-game companion is parked (Open items). Still not
reported back: a paste of the Shopping view's string into Auctionator's in-game Import. If the list misbehaves in
game, check the term format in `app/src/shopping/list.ts` against `Auctionator/Source/Search/Advanced.lua` first.
- The app is used on desktop only (Josh, 2026-11-10): phone layout is not a concern (the view-switcher row is wider
  than a phone screen; leave it).
- Josh's setup (Chrome, live site): save file `data/private/shuffle-edits.json`; history folder
  `data/private/price-history/` (Auctioneer scans 2026-11-06 00:25 to 18:27 and 11-10 14:10, BavvbScan 11-10 14:55);
  linked file `F:\World of Warcraft\_forever_\WTF\Account\1120039#2\SavedVariables\BavvbScan.lua`.
- Scan routine (in game, on Xria, account 1120039#2): open the AH, `/bscan`, wait for the green "SCAN SAVED" panel and the ready-check
  sound (~2 min), click its Reload button (= `/reload`), then Refresh now in the app. Refresh is always safe (unchanged file = no-op; WoW rewrites the file on
  every /reload, which re-imports the same scan and history skips it). "Allow saving" in the toolbar = Chrome wants
  the history folder's OK again. At most one full-scan request per 15 minutes, from any addon, failed ones included;
  a request inside the window gets no answer. Diagnose with `/run print(C_AuctionHouse.GetNumReplicateItems())`
  (0 = the server sent nothing; Josh's `/dump` attempt gave a parse error, `/run print(...)` worked).
- Addon upkeep: the copy in `F:\World of Warcraft\_forever_\Interface\AddOns\BavvbScan\` is refreshed by hand after
  any change to `addon/BavvbScan/` (a changed .lua loads on `/reload`; a new file or .toc change needs a WoW restart).
  Copied 2026-11-11 with the scan panel. `.gitignore` ignores `*.lua` (SavedVariables copies) with an
  exception `!addon/**/*.lua`. Addon logic tests: a fengari harness with a simulated AH (11 scenarios: scans, failures, combat, the panel's states,
  the demo) lived in the session scratchpad and is gone; rebuild it (npm fengari, mock C_AuctionHouse/C_Timer/frames) if the addon changes.
- History file names: Auctioneer scans use the server key `CAMWOWUS1Realm3PvE_Alliance`, BavvbScan uses the game's
  realm name `CAMWOW US1 Realm 3 PvE` (-> `CAMWOW_US1_Realm_3_PvE_Alliance`). Same realm; a future per-item price
  history view must treat them as one series. Not changed.
- Settings caveat from 2026-11-06: Josh's save file had import column 1 (stored before the default became 3) and
  Mining chains off; he was asked to pick column 3 and check Mining. If prices look like lowest buyouts, check this.
- Josh wants exact recent-scan prices, robust beyond the minimum: column 3 (average of the cheapest 15%). On his first
  scan, TSM's per-scan method was within a few % of it, so not worth switching. Offered, not taken: show units listed
  next to a price as a thin-market marker (27 of 490 app items on the AH had 1-3 units).
- TSM (explored 2026-11-06, parked for the long term; Josh: "this will work well in the long term"): the TSM
  desktop app writes `F:\World of Warcraft\_forever_\Interface\AddOns\TradeSkillMaster_AppHelper\AppData.lua`
  about hourly. Blocks `LoadData("<kind>","<realm>",[[return {downloadTime=..., fields={...}, data={{id,v,...}}}]])`,
  numbers in base 32 (0-9A-V). Josh's realm is "Normal-Alliance" (its min buyouts match his scans); region
  "Forever-US". Kinds: NON_COMMODITY_DATA (minBuyout, numAuctions, marketValueRecent), NON_COMMODITY_SCAN_STAT
  (marketValue = DBMarket), NON_COMMODITY_HISTORICAL (historical), REGION_STAT (regionMarketValue), REGION_HISTORICAL,
  REGION_SALE (regionSale, regionSoldPerDay, regionSalePercent: the last two look scaled, probably x1000; check
  against a TSM tooltip before use). A trial CSV is `data/private/tsm-prices-2026-11-06.csv` (p1 minBuyout,
  p2 marketValueRecent, p3 marketValue). Next step when Josh wants it: a TSM reader (link AppData.lua like the
  scan file) and his choice of which figures fill the three columns; needs his yes. TSM's full scan only runs on the
  Mists client and only uploads listings; it is not a price source by itself. TSM on that account also records his
  real AH sales (TradeSkillMaster.lua `csvSales`).
- Auctioneer history (removed 2026-11-10; its reader stays for old scans): its Forever build needed local patches to
  CoreScan.lua for the scan timeout (gone with the uninstall); scans took ~4 min because of Auctioneer's own storing;
  `/reload` cleared its 15-minute guard; tooltip errors in `!Swatter.lua` were harmless noise.

Open items to raise when relevant:
- Parked 2026-11-11 (Josh: not now): in-game companion in BavvbScan. The app would write
  `Interface\AddOns\BavvbScan\AppData.lua` (TSM-style; the AddOns folder is shared by all accounts) with per-recipe
  cost, exits, profit and the Shopping list; the addon would show a panel beside the profession window and create
  the Auctionator list on /reload via `Auctionator.API.v1.CreateShoppingList(callerID, name, searchStrings)` (exists
  in v345, replaces a same-name list). Costs a second /reload after Refresh. Open questions were: auto-create vs
  button, list name, Enchanting (CraftFrame) left out, which characters. Josh wanted ToS-clean: paste or
  file-write only, no automation.
- Wowhead vendor buy prices removed by hand from `game-data.json` (2026-11-11; Josh: incorrect, ignore for now):
  Black Lotus 13468 (40s), Pyrite 249391 (4s), Pristine Leather 249427 (5s), Pristine Hide 249428 (10s), Pristine
  Scale 249429 (15s). The new Tailoring page lists them; `parse_pages.py` puts them back on every run. Remove them
  again after a parse (or have Josh mark them "No vendor sells it" in the Prices view, which survives re-parses).
- Auctionator is no longer the main source. Old notes: Desktop WTF backups (Benediction, 2023) use price database
  v6, which the reader rejects; the readers handle v8 only. The beta file
  `F:\World of Warcraft\_classic_beta_\WTF\Account\1120039#1\SavedVariables\Auctionator.lua` was the 2026-10-22 import.
  Parked ideas: an item check panel (per-item price history: now possible from the price history summaries).
- Not exercised for real yet: Chrome's file-picker and permission prompts for the save file (Josh has since created
  his save file, so they work at least for creation).
- Revisit whether to keep the Table view (and AG Grid) once the List has been used for a while.
- Offered, not taken: size the List's name column to the longest visible name (Skill would sit closer to the names);
  in the Prices view, show the g/s/c boxes only on the clicked row if the ~1 s open time bothers him; a vendor-flip
  analysis (only the "Vendor ≠ AH" filter exists; flips are outside the app's job).
- Shopping view limits, by design for now: "or" lines go one level deep (an ingredient that is itself craftable is
  not expanded); vendor-sold ingredients of a crafted reagent (e.g. vials for dyes) start unticked, so the list doesn't
  remind him to buy them from a vendor. Raise if he asks for a vendor shopping note or deeper chains.
- Favorites, offered, not taken (2026-11-12): an "add this group to the shopping list" button on each group header.
  Not built: a move dropdown on the row itself (the card's Favorites picker and dragging onto a header cover it).
  Group open/closed state is per browser, not in the save file.
- Possibly stale Wowhead vendor prices seen in the Vendor ≠ AH filter (Major Mana Potion 60s, Tinkerbox 1g, Lesser
  Mana Potion, Mote of Magic): Josh may want to check them in game and curate.
- Test data caveat: `data/private/edits-v2.5.json` (the workbook export) has "Chains: craft with Mining" = No, so
  headless checks seeded from it show Mining off. His save file is the truth (Mining was off there too on
  2026-11-06; asked him to check whether that is intended).

## Sign off

When Josh says **"sign off"** (older wording: "save everything"), the session is ending. Run all of this:
1. `git status`: commit finished, approved work; name anything unfinished or unapproved to Josh instead of committing it.
2. This file: rewrite "Where we left off" and "Open items" for the current state (drop stale lines, fold dated notes),
   and update Architecture / Model / UI for anything that changed.
3. Record what lives outside the repo: changes in the WoW folder (addon copies, patches), paths, in-game routines, findings.
4. Memory: save new preferences or corrections Josh gave this session.
5. Stop background processes (dev servers).
6. Commit. Push only if Josh says so, but say whether unpushed commits remain.
7. Reply with a short summary: what was recorded, the commit hash, push status.

Working notes:
- `app/src/App.css` is one global stylesheet. Two bugs came from generic class names colliding across views (`.num`,
  `.sub`). Give new view-specific classes a prefix (the views use `s*`, `p*`, `i*`, `d*`, `r*`) and grep before adding.
- Views: List · Favorites (`favorites/`) · Table · Prices (`itemprices/`) · Intermediates (`intermediates/`) · DE table (`detable/`) · Settings
  (`settings/`) · Shopping (`shopping/`). Pure logic sits next to each view with a `.test.ts`; the model stays in `model/`.
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
