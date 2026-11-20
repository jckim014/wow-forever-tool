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
tools/parse_pages.py            saved Wowhead pages -> app/public/game-data.json + leveling-data.json (committed)
tools/fetch_binding.py          products' bind type from Forever item tooltips -> game-data.json (cache in data/private/)
tools/export_workbook_edits.py  one-time: workbook edits -> data/private/edits-v2.5.json (import in the app)
tools/export_parity.py          calculated workbook -> data/private/parity-v2.5.json (test reference)
tools/auctionator_to_imports.py reference implementation of the Auctionator reader, to port to TypeScript
tools/build_forever_shuffle_sheet.py  the spreadsheet builder (v2.5), kept until the app reaches parity
addon/BavvbScan/                Josh's own WoW addon: /bscan full AH scan -> SavedVariables\BavvbScan.lua (the price source)
collector/                      auction collector: cloud fetch (GitHub Actions) + PC sync to F:\ForeverAuctionData (see Collector)
.github/workflows/collect.yml   runs collector/collect.mjs, uploads snapshots as artifacts
market/                         Forever Market: local app for price trends and faction arbitrage (see Forever Market)
data/config/de-table.json       default disenchant table (Classic item-level bands), with material item IDs
data/config/defaults.json       default settings and the cooldown-craft rule
data/config/leveling.json       leveling planner: starter recipes per profession, recipe-item name aliases
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
  **Wall cutoff for p3** (Josh, 2026-11-14, chose 5x after seeing 3x / 5x / 10x on live data): units priced over 5x
  the *anchor* are left out first, and p3 is the cheapest 15% of the units kept. Anchor = the price reached by the
  cheapest 5% of all units (not the lowest listing: Stonescale Eel had 1 bait unit at 21c under ~1,900 at 1s 64c).
  Why: Raw Longjaw Mud Snapper on Horde had 8,616 of 10,280 units at 22s, so 15% of all units reached past the 555
  units at 10c and p3 read 2s 18c; with the cutoff 10c. Changes ~35-42 items per faction by >10%. p1, p2, units and
  listings are unchanged. Same code in `auctioneer.ts` (`ANCHOR_SHARE`, `WALL_CUTOFF`) and `collector/syncLib.mjs`
  (`collectorSummary.test.ts` keeps them equal), so it applies to every scan reader, API summaries and Forever Market.
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
analysis, stored on his F: drive. The app uses the newest summary as a baseline price source (see Model, "Imported
price"; `app/src/apiprices/`), alongside BavvbScan/imports, which stay for up-to-the-minute prices.
- **API facts (probed 2026-11-12, from https://blizzard.pinta.land/forever/, not documented by Blizzard)**: OAuth
  client credentials (`oauth.battle.net/token`, token 24 h). Namespace `dynamic-forever-us`. No realms; rulesets
  1 PvP, 2 Normal, 3 RP, 15 RP-PvP all list the same 15 houses with the same data (ruleset doesn't filter):
  110-121, 123-125. `/data/wow/ruleset/2/auctions/{house}` (auctions: buyout/bid per auction) and `.../commodities`
  (unit_price). 112/115/118 are empty (no `auctions` field). Data refreshes hourly at about :22 (all houses within
  seconds); `If-Modified-Since` is honoured (304). Snapshot of all houses ~7.7 MB gzipped (~67 GB/year hourly).
- **Houses**: Josh's realm ("CAMWOW US1 Realm 3 PvE") = **111 Alliance, 114 Horde, 117 Blackwater (neutral)**, each
  confirmed by matching an in-game BavvbScan listing by listing: 111 91.6% identical (2026-11-12, other houses
  <= 22%), 114 90.0% (Horde scan 2026-11-13 04:41 UTC, next best 18.5%), 117 87.9% (neutral scan 05:01 UTC, next best
  6.4%). Josh scanned Horde and Blackwater with a Horde character on account folder 1120039#2. The ID pattern holds:
  groups of Alliance/Horde/Blackwater 110/113/116, 111/114/117, 112/115/118 (empty), 119/120/121, 123/124/125.
  **NA PvP = 110 Alliance, 113 Horde** (2026-11-13: TSM realm data "PvP-Alliance"/"PvP-Horde" in AppData.lua, lowest
  buyouts 64% identical with those houses vs <= 7% with any other; "Normal-Horde" matched 114 at 66%, re-confirming it);
  116 is PvP Blackwater by the ID pattern only (TSM has no neutral data). 119-121 and 123-125 are unconfirmed (the
  same TSM match works if Josh adds those realms in the TSM app). Josh wants all 15 collected, but only as background
  data for questions or later looks: his apps stay on his PvE realm (Alliance default, Horde for faction arbitrage);
  no PvP views or labels wanted (2026-11-13).
- **Cloud side** (`collector/collect.mjs`, pure checks in `lib.mjs` with `node --test collector/*.test.mjs`):
  **started by a Google Apps Script timer every 30 min** (Josh chose 30 over 15: two chances per hourly refresh is enough) (`collector/apps-script-timer.gs`, project "Forever auction
  timer" in Josh's Google account, trigger "Minutes timer, every 30 minutes", failure email immediately; script
  property GITHUB_TOKEN = a second fine-grained token "forever-collector-timer", this repo, Actions read/write).
  Why: GitHub runs no scheduled workflows in this repo (2026-11-12: the cron never fired in 3.5 h, a resync commit,
  disable/enable and a minimal */5 probe workflow didn't help; matches the 2026 reports in
  github.com/orgs/community/discussions/185355, where an external timer calling workflow_dispatch is the only
  confirmed fix). The `schedule:` line (:06/:26/:46) stays in case GitHub starts honouring it; concurrency queues
  any overlap and idle runs cost 1 request. Token reused from the Actions cache, encrypted (AES-GCM, secret `TOKEN_CACHE_KEY`) because
  pull-request workflows in a public repo can read caches. Conditional GETs, 1 s apart, one retry on 5xx/network,
  never on 429. Fails the run (GitHub emails Josh) on: house list change, malformed listings, a house >= 5000
  listings halving, newest data > 3 h old, HTTP errors. New API fields are notes (warnings), not failures. Raw
  responses saved unchanged (gzipped) with `manifest.json` (format `forever-auction-snapshot` v1: per file house,
  kind, lastModified, listings, items, sizes, sha256) as artifact `snapshot-<YYYYMMDDTHHMMSSZ>`, kept 90 days.
  Run workflow has a "test_failure" box: collects normally, then fails on purpose (checks the email and PC alert).
  In the API every regular auction has quantity 1; stacks are commodities (unit_price).
  **Daily PC-sync check** (first run after 17:00 UTC = 9 am Pacific, day kept in the cached state): if any snapshot
  has waited on GitHub over 2 days, that run fails (one email a day) because the PC sync has stopped picking them up
  and they are lost after 90 days. Uses the workflow's GITHUB_TOKEN (actions: read). "sync_check_now" box on Run
  workflow forces it. Known unwatched: the Google timer stopping while the PC is off (noticed at next login), and
  disk space on F: (Josh declined a free-space alert, 2026-11-12).
- **PC side** (`collector/sync.mjs`, pure parts in `syncLib.mjs`): Windows task "Forever auction sync"
  (`collector/install-task.ps1`; node runs with --max-old-space-size=512 (set in sync-hidden.vbs: Node frees memory
  lazily, so one sync peaked at ~690 MB; with the ceiling the estimate rebuild used 199 MB instead of 380 MB); 2 min after logon and hourly at :55 (moved from :40 on 2026-11-12 so it falls after the timer-started runs), priority 7, run via `sync-hidden.vbs` so no
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
  retried next hour; a failed download first gets one more try 30 s after the rest of the run, and only a second
  failure alerts: 2026-11-18, the logon run hit "fetch failed" on two mornings before the network was up), new collector notes/problems (once each). **Backup for the timer**: if no collector run has started for
  70 min, the sync starts one (workflow_dispatch, `state.backupStartedAt`) and alerts until a run it didn't start
  appears (the timer is back). `--dry-run` and `--test-notification` flags. First real sync
  2026-11-12: 8.2 MB snapshot in 8.6 s, peak 336 MB; nothing new: 1 s, 56 MB. Summary of 111 vs a BavvbScan 25 min
  earlier: 80% same lowest, 90% cheapest-15% within 5%. No healthchecks.io (Josh: no new accounts), so nothing watches
  while the PC is off.
- **Item names** (for Forever Market, 2026-11-13): `collector/fetch_names.mjs` (logic in `namesLib.mjs`) names every
  item ID in the summaries from `nether.wowhead.com/forever/tooltip/item/<id>` (game data only: name, quality, icon;
  covers Forever-only items), 1/s, falling back to Blizzard's item API (static-forever-us, then static-us). Cache
  `F:\ForeverAuctionData\items.json` (`{id: {name, quality, icon, source, at} | {missing, at}}`, fetch order: new
  items, then misses (retried daily), then names older than 30 days (monthly re-check for renames; a failed re-check
  keeps the name)), saved every 50 items; restartable. First full run 2026-11-12/13: 7,026 items, all named (none
  missing); checked: 1,384/1,384 equal to the shuffle app's names, 193/195 of a random 200 equal to Blizzard's API
  (120/120 Forever data; the 2 differences are later Retail renames, e.g. 1934 Stonemason Trousers). Forever Market's plan
  (`~/.claude/plans/polymorphic-sleeping-lighthouse.md`, 2026-11-12) is superseded by the Forever Market section below,
  which keeps the current step list.
- **Price database** (Forever Market step 3, 2026-11-13): `F:\ForeverAuctionData\market.db`, SQLite via Node's
  built-in `node:sqlite` (`collector/marketDb.mjs`; "experimental" warning, silenced with
  `--disable-warning=ExperimentalWarning`). Tables: `snapshots(t, id, collected_at)` (t = data time, Unix s),
  `snapshot_houses(house, t, listings, bid_only, items)`, `prices(item, house, t, lowest, median, cheapest15, units,
  listings)` (PK item, house, t; WITHOUT ROWID), `item_ids(item, first_t)`; WAL mode. Filled by
  `collector/build_db.mjs` (backfill/catch-up from the summaries, skips stored snapshots), by
  `collector/rebuild_summaries.mjs` (after a change to the summary calculation: recomputes every summary from raw and
  rewrites market.db's rows; takes the sync's lock; 37 snapshots in 87 s on 2026-11-14) and by `sync.mjs` right after
  it stores each summary (a failure there notifies and is caught up by build_db). After storing snapshots the sync runs
  `fetch_names.mjs --limit 120` for new items (lock `items.json.lock`, one fetch at a time; it reads IDs from
  `item_ids`). Indexes `prices_by_time (house, t)` and `departures_by_time` (for the Faction tab);
  `journal_size_limit` 4 MB keeps the WAL file small. Size: prices ~1.3 MB per snapshot + index ~0.6 MB + estimate
  ~0.2 MB, about 19 GB/year. Names stay in items.json, not the DB.
- **sales.json** (2026-11-15, for the shuffle app's Leveling view): `F:\ForeverAuctionData\sales.json`, format
  `forever-sales` v1 `{at, days: 7, houses: {111|114: {hours, items: {id: units/day}}}}` = Forever Market's estimate
  (certain + probable over the last 7 days, scaled by the snapshot-pair hours). Written by the sync after each
  departures update (`collector/salesFile.mjs`; failure = toast) and by `node collector/write_sales.mjs`. The app reads
  it with the API prices (`readSales` in apiprices/folder.ts; only when its lastModified changes). First write: 6,550
  items Alliance, 6,450 Horde, 78 h of pairs, ~3 s. Cheap relisted items look high (Linen Bag ~425/day, Red Linen Bag
  ~900/day): the estimate counts some cancels/reposts as sales.
- **Mail ledger** (Josh, 2026-11-16: the trade tracker outlived its use; he wants a background record of all his
  auction trading for bookkeeping and looking back, e.g. a strategy at the next Classic launch or in 10 years):
  BavvbScan's mailbox log now records on **every character** (see Trade tracker > Sales from the mailbox), and the
  sync (`collector/ledger.mjs`, every run, tested) copies new records and visits from every account's BavvbScan.lua
  under `F:\World of Warcraft\_forever_\WTF\Account\*\` (env FOREVER_WTF_ACCOUNTS; read only) into
  `F:\ForeverAuctionData\ledger\YYYY-MM.jsonl` (local month; one JSON per line, lines only added; key account + id;
  kind sale / buy / visit; sales get itemID from items.json when the name is unique; README.txt there explains the
  fields). Own small SavedVariables parser (no TS import). Failure = lasting toast (`conditions.ledger`); the addon
  keeps 60 days, so nothing is lost meanwhile. Seeded 2026-11-16: 2,401 entries, 11 characters, ~0.9 MB for ~3 days
  (~100 MB/year at that pace); `ledger	rade-tracker-2026-11-16.json` = copy of the trades file then. F: only, no
  second copy (Josh: nice to have, he manages it). To answer questions about past trades, read these files.
- Secrets/keys: Blizzard client in `data/private/blizzard-api.json`, cache key in `data/private/token-cache-key.txt`;
  the same values are GitHub secrets `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`, `TOKEN_CACHE_KEY`.
  GitHub repo settings: fork PR workflows need approval for all external contributors.
- Rate: an idle run is 1 request (sentinel: house 111 auctions unchanged = all unchanged, since all houses refresh within seconds; a run where 111 changed but others did not fails, as the sentinel would then miss data); a full run ~31. With the 30-min timer about 24 idle + 24 full runs, ~770 requests/day; Blizzard allows 36,000/hour. Josh: stay well clear of Blizzard limits; chose token reuse per their advice.

## Forever Market (local app; plan approved 2026-11-12, steps 1-7 done)

A separate local app on Josh's PC for **price trends** (any AH item's history, charts, pattern finding) and **faction
arbitrage** (Alliance vs Horde gaps after moving goods through Blackwater). Reads the price database and item names
on F: (see Collector). Plan steps: 1 houses (done), 2 names (done), 3 database (done), 4 app shell + launcher (done),
5 Trends charts (done), 5a TSM region sale data (done), 5b our own sale-rate estimate + Method check page (done), 6 Faction
(filters on both sale figures) (done), 7 Cycles tab (time-of-day patterns; done 2026-11-13, results from ~2 days of data;
weekday patterns not built, need ~3 weeks of data). All revisable (Josh).
- **Tabs** (renamed by Josh 2026-11-13; on screen / code name): **Price history** / trends (step 5; older notes here say
  "Trends"), **Faction** / faction, **Cycles** / timing (step 7), **Method check** / check. The code keeps the old names.
- **No build step, no packages**: `market/server.mjs` (Node http + node:sqlite, read-only DB) serves
  `market/public/` (index.html, app.js, style.css, shared.js: plain ES modules) and a JSON API: `/api/status`,
  `/api/search?q=` (items.json in memory, re-read when it changes; ranking in `market/lib.mjs`), `/api/item?id=`
  (latest figures per house), `/api/heartbeat`. A typed item number always finds the item if it was ever on the AH
  (shown as "Item 12345" until named). Listens on 127.0.0.1:5310 only. Tests: `node --test market/*.test.mjs`.
- **Starts from Chrome, stops by itself**: Chrome bookmark `forever-market://open` -> per-user link registered by
  `market/install.ps1` (HKCU\Software\Classes\forever-market; re-run if the repo moves or Node's path changes) ->
  `launch-hidden.vbs` -> `launch.mjs`: starts the server hidden and detached if it isn't answering, then opens
  http://localhost:5310/. Open tabs check in every minute; the server exits 10 min after the last check-in
  (`FOREVER_MARKET_IDLE_MS` / `FOREVER_MARKET_PORT` override for tests). A tab whose server stopped shows a banner.
- Houses shown: Alliance 111 and Horde 114 only (`market/public/shared.js` HOUSES). Blackwater 117 is only the
  transfer route; its prices are never shown (Josh, 2026-11-13). Its cut is 15% (Josh confirmed), `BLACKWATER` in shared.js.
  Price shown by default: cheapest15 (average of the cheapest 15% of units), as in the shuffle app's column 3.
- **Trends** (step 5): picking an item shows latest figures per house, then charts from `/api/history?id=&days=`
  (per house [t, lowest, median, cheapest15, units, listings] + all snapshot times): price per unit (Cheapest 15% /
  Lowest / Median) and units listed as two separate line charts (one y-axis each), Show Both / Alliance / Horde,
  ranges 24 h / 7 d / 30 d / All / Custom (from-to date-times; also drives the heat maps and table);
  weekday x hour and per-day heat maps (median, local time, quantile colour bins) for a chosen house; table view.
  Plain SVG in `market/public/charts.js`, calculations in `stats.js` (tested). Per the dataviz guidance: lines are
  Alliance blue #3d8af0 / Horde red #e0533f (validated on white and dark: CVD ΔE 26, >= 3:1; lines carry direct end
  labels and a table view exists), crosshair readout lists every house, a line breaks where a snapshot passed without
  the item listed, money axes use whole-copper ticks and compact labels ("40g"); heat maps use a gold ramp.
- **TSM region sale data** (5a, 2026-11-13): `market/tsm.mjs` parses AUCTIONDB_REGION_SALE (Forever-US) from
  `F:\World of Warcraft\_forever_\Interface\AddOns\TradeSkillMaster_AppHelper\AppData.lua` (env FOREVER_TSM_FILE), re-read when it
  changes; base 32; regionSale copper; regionSoldPerDay and regionSalePercent x1000 (Josh confirmed against TSM's
  tooltip: Linen Cloth 15,998/day, 95.4%; Runecloth 1,846, 61.5%; Arcanite Bar 2.96, 22.8%). Shown on the item page as
  the third sales tile, "All realms sold / day (TSM) ⓘ" (~sold/day; sale rate and average sale price; download date;
  the explanation is the ⓘ hover tip): pooled TSM users' sales,
  region-wide, updated about daily. Josh's own TSM sale records are NOT a data source (too limited/biased); planned
  only as ground truth for checking our estimate (5b): TradeSkillMaster.lua csvSales/csvBuys/csvCancelled/csvExpired
  (account 1120039#2; 2026-11-13: 1,209 auction sales, 643 buys, 156 cancels, 432 expiries). Those rows hold other
  players' names: never store or show them.
- **Our sale-rate estimate** (5b, 2026-11-13; `collector/departures.mjs`, method version in `METHOD_VERSION`, history in
  `market/method-history.json`): per house (111, 114 only) and consecutive snapshot pair (<= 90 min apart), from the
  raw listings: certain = commodity listing still there with lower quantity; probable = vanished with LONG/VERY_LONG
  left (can't expire within the hour) and not a repost; reposted = a new cheaper listing of the same item and size
  appeared (v2: each new listing explains at most one vanished one); unclear = vanished with SHORT/MEDIUM left (may
  have expired). Stored in market.db `departures(item, house, t, certain, probable, reposted, unclear)` and
  `departure_pairs(house, t, prev_t, skipped, method)`; filled by `collector/build_departures.mjs` (after a method
  change: drop both tables and rerun, ~6 s per 10 h of data) and by the sync after each new snapshot
  (`departuresUpdate.mjs`). A snapshot stored late (download failed, retried after later ones; first seen 2026-11-17
  after the PC was off overnight) makes the next update delete and redo the pairs from the one spanning it
  (`lateRedoFrom`; sync log "N redone for a late snapshot"). Item page (Josh asked for plain sales wording, 2026-11-13; tiles,
  2026-11-13: the old text bands were "clunky"): three tiles under the price table (`salesTiles` in app.js), "Alliance
  sold / day ⓘ" and "Horde sold / day ⓘ" with ~N (= certain + probable over the last 7 days, scaled to 24 h by the
  hour pairs present), then "N confirmed sales · estimated" (certain; "none confirmed" when ~0) and "last 7 days". The
  hours-of-data count was dropped (Josh knows when collection started). The ⓘ hover tip holds the explanation
  (estimated from hourly listings, includes some cancellations, misses items bought within the hour). In code and the Method check the rule names stay certain/probable. First data: ranks items like TSM's region sold/day (Spearman 0.82 over 4,631
  items) at ~11x TSM's level (TSM only sees TSM users' sales).
- **Method check** tab (`market/validate.mjs` pure + `methodCheck.mjs`, `/api/method-check`, `public/check.js`): Josh's
  TSM records (`TradeSkillMaster.lua`, account 1120039#2, env FOREVER_TSM_ACCOUNT_FILE) as ground truth, never as a data
  source; names dropped on parsing. Only the "r@Normal@..." section is read (TSM keeps records per realm, Alliance
  and Horde together; Josh's account also has an empty "r@PvP@" section since 2026-11-13, which would be matched
  against the wrong houses; `TSM_REALM` in validate.mjs). Matching rules learned the hard way: TSM records a sale at the money received
  (listed price x 0.95); a commodity buy takes units from several stacks (any listing at or below the price);
  cancels/expiries have no price (narrowed to Josh's own listing prices from his sales within 2 days); sales are
  searched up to 2 h before the record (mail delay), other records only in the pair around their time (a missing
  snapshot = not checkable, never an earlier pair). v2 on 140 records: 88% of sales+buys detected (82/93), 0/15 cancels
  and 1/14 expiries counted as sales; the misses are mostly sales near the end of a listing (vanish with < 2 h left,
  indistinguishable from expiry: an hourly-snapshot limit). Tune only with ~100+ more records; record each version.
  Speed (2026-11-17): reading every raw snapshot took 82 s / 1.6 GB at 5 days of data and grew with it, so each
  snapshot pair is classified once into `F:\ForeverAuctionData\cache\method-check\<house>-<prevT>-<t>.json.gz` (only
  listings of items whose records fall in that pair; ~3 MB; redone for a new method version, a new item, or a late
  snapshot; unneeded files pruned). Warm check 0.5 s, first build 59 s; output identical to the old code on Josh's
  2,892 records. Deleting the folder is safe (rebuilt on the next check).
- **Faction tab** (step 6, 2026-11-13; calculation `market/faction.mjs`, tested; `/api/faction`; `public/faction.js`).
  Agreed with Josh: buy = cheap side's cheapest15; sell = dear side's lowest, unless it is under 80% of the dear side's
  cheapest15 (lone outlier / bait: then cheapest15, row flagged "outlier ignored"); transfer listed on Blackwater at
  the buy price (15% cut, Josh: just use the buy price, no Blackwater-price trick); final 5% AH cut; deposits left out.
  **Profit/unit = sell x 0.95 - buy / 0.85, both directions** (Josh, 2026-11-15; replaced buy x 1.15 and the two
  checkboxes "Send the gold back to Alliance" (2026-11-14) and "Horde's gold comes from Alliance"): each faction keeps a
  fixed pool of gold; the transfer listing returns 85% of the buy price to the buying side, and the 15% it loses is
  refilled from the selling side with a Skinning Knife (another 15%), so the buy costs 1 + 0.15 + 0.026 = 1 / 0.85.
  Break-even: sell ~24% above buy (Margin = profit / buy, so ~0% at break-even). Profit stays on the faction sold on;
  moving it elsewhere costs another 15% (not included; the trade tracker counts each real knife send). Josh was walked
  through it with "100g on Horde, buy 10g, sell 15g -> 2.49g" (in faction.test.mjs). **Protected** checkbox (Josh, 2026-11-16, remembered):
  snipe-proof transfer listed on Blackwater at sell x 0.95 (a sniper reselling it gets nothing), the selling side
  breaks even and the buying side's gain is knifed back: protected profit = 0.85 x (0.85 x 0.95 x sell - buy) =
  0.7225 x profit (example: buy 10g, sell 20g -> 7.24g, protected 5.23g). Ticked, Profit / unit, Margin, Min profit,
  Min margin and sorting use it; the rows listed don't change otherwise (same sign), nor does Steady. Blackwater deposits go by vendor price, not listing price (Josh, 2026-11-16), so the high
  listing adds no deposit. Rows: every item and direction with
  profit > 0 at the latest snapshot; thin = cheap side <= 2 units or dear side <= 2 listings (hidden by default);
  "Steady" = share of snapshots in the window where the trade was profitable (information + optional filter, it
  doesn't change the profit). Window switch 3 / 7 / 30 days / Custom (1-365; default 3, remembered; `/api/faction?days=`,
  cached per window); it also sets the period of "Sales / day*" (dear side = the faction sold on, our estimate) next to "TSM sales / day".
  That header names the faction from the Direction filter (Josh, 2026-11-14): "Horde sales / day*" for Alliance -> Horde,
  "Alliance sales / day*" for Horde -> Alliance, "Sales / day* (where sold)" for Both. Filters remembered per browser; a
  row opens the item in Trends (both factions). First run: 2,716 profitable rows, ~0.9 s, cached per snapshot.
- **Cycles tab** (step 7, 2026-11-13; code name "timing" in files, ids and API; calculation `market/timing.mjs`, tested on synthetic series; `/api/timing?days=&width=`;
  `public/timing.js`). Named "Cycles" (Josh, after "Patterns" (sounds like crafting recipes), "Timing" and "Flips"). Per item and faction (111, 114),
  cheapest15 over the window (7 / 14 / 30 / custom days, default 14): local calendar days with the item priced in 12+
  hours; each hourly price / that day's median (so a drift over the week isn't a time-of-day pattern); hour profile =
  median ratio per hour across days; cheap and expensive windows = the lowest / highest `width` consecutive hours
  (2 / 3 / 4 / 6, default 4, wrapping midnight, not overlapping). Swing = expensive / cheap - 1; buy around / sell
  around = median day price x window ratio; profit/unit = sell x 0.95 - buy (break-even swing 5.3%; deposits left out).
  "Held on N of M days" is leave-one-out: each day is checked against windows picked from the other days, and counts
  when buying in the cheap and selling in the expensive window made money that day after the cut. Rows: profit > 0.
  Columns (all sortable, Josh wants the raw numbers whatever the ranking): hours, prices, swing, profit, held, days
  (amber under 7: "rough"), median units listed, Sales/day* (ours, that faction), TSM, Max gold/day* = profit x our
  sales/day (a ceiling; default sort). Filters: search, faction, min swing / profit / sales/day, held share, hide thin
  (median units <= 2). Results show from 2 qualifying days (Josh: rough early results with a warning, not a 7-day wait).
  A row opens the item in Trends with that faction's heat map. Speed (synthetic 30-day DB, ~6,000 items): 7 d 2.6 s,
  14 d 3.6 s, 30 d 6.5 s, cached per snapshot; prices are read one item at a time (PK range) because the time index
  needs a table lookup per row (~7x slower). `FOREVER_TIMING_MIN_DAY_HOURS` lowers the 12-hour rule for trying it out.
  UI wording: "expensive", never "dear" (Josh didn't know the word; Faction tooltips and heat-map legends changed too).
- CSS classes for its own views start with `m` (as the shuffle app's prefixes).
- **Look** (Josh, 2026-11-13, "fine for now"): light theme with WoW touches. Money in coin colours (`moneyHtml` in
  shared.js: gold/silver/copper parts, padded `5g 04s 00c`), faction names in Alliance blue / Horde red (`factionHtml`),
  item names in quality colours, item icons from Wowhead's image server (`iconHtml`; icon names from items.json, carried
  in the search, item, Faction and Cycles responses), Open Sans from Google Fonts, a grey bar under the selected tab or
  toggle (red looked "Horde"; red stays on the selected search row and buttons). All colours are tokens in style.css.
  **Theme switch** (kept, Josh 2026-11-13): Light | Dark at the right of the toolbar, per browser
  (localStorage `forever-market:theme`, applied by a script in index.html's head before drawing; heat maps redraw).
  Light is the default; Dark = Wowhead's exact colours from its stylesheets (#101010 / #202020 / #303030, text #bbb,
  links #ffd100, red #a71a19), the `:root` tokens. New styles need values for both themes.
  Light coin colours #a87b00 / #6c7079 / #a8561e: Josh first found them hard to see, tried a darker set (#8a6200 /
  #5b5f68 / #93461a, semibold money), went back, and settled: "coin colors are fine now" (2026-11-13).

## Trade tracker (cross-faction trades; built 2026-11-14)

A small separate page on the same site: `app/trades.html` -> https://jckim014.github.io/wow-forever-tool/trades.html
(second Vite entry in `vite.config.ts`; code in `app/src/trades/`, classes `t-*`, own stylesheet; shares no data with
the shuffle app). Josh wanted it **extremely simple** ("you are overengineering this"): he types every figure; no
market prices, predictions or TSM links. Purpose: how much gold is in the arbitrage and whether it profits.
- Records (model.ts, tested with the agreed example): starting gold per faction (editable); three kinds of entry,
  each with faction, item (matched by name, ignoring case/extra spaces), qty, total gold and an editable time:
  purchase (gold spent), transfer (from a faction; price = the Blackwater listing; sending side gets price - 15%, the
  other pays price), sale (gold received in the mailbox; one entry can
  lump many AH sales). Adjustments (faction, +/- amount, required note; amber in the history, never trading profit).
  **No batches** (Josh, 2026-11-14: matching scattered sales to overlapping purchases was unwieldy; the batch version
  4a2c5ab is read as version 1 and converted). Inventory: one stock pool per item and faction with a running average
  cost, entries applied in time order: purchase adds units + gold; transfer moves units with their share of cost;
  sale takes units out at the average (its profit is shown). Taking more than a pool holds is allowed, flagged
  amber, extra units cost nothing. Purchase and transfer keep the original UI (Josh, 2026-11-14: they won't change and
  it's convenient): Purchase dialog has no time field; each purchase shows as a card under "Waiting for transfer" (total and price each) with
  "Transfer to Horde/Alliance" (quantity, defaulting to the units left, and price; the transfer stores `purchase` =
  its id. Josh, 2026-11-14: a smaller quantity keeps the rest on the card ("12 of 20 units left to transfer"), so a
  purchase can move in several parts; transfers follow the purchase's item and faction, and its quantity only when a
  single transfer moved all of it; Undo in the history puts its units back on the card). Transfer prices are typed
  per unit in both dialogs (stored as the total = per unit x qty; an untouched edit keeps the exact old total). A card also drops out
  once its faction holds none of the item. Sales (and a free Transfer from the item table) use the item dialog with
  the time field. Page: Items in stock table (holdings per faction with cost each, tied up, sold,
  received, profit; Buy / Transfer / Sell buttons prefill; Edit opens the item's panel for typos (Josh, 2026-11-14):
  rename on every entry (a name matching another item merges them), its entries with Edit/Delete, and Delete item
  with all its entries (the confirm shows each balance's change)), Sold out (collapsed), History (every entry editable).
  Both item tables show Avg buy (gold spent on all purchases / units bought, Blackwater's cut not included) and Avg sell
  (received as recorded, i.e. after the AH cut, / units sold; Josh, 2026-11-14: "show as is"), for restock prices.
- **Sales from the mailbox** (Josh, 2026-11-14: typing scattered small sales was tedious; he doesn't trust TSM's
  records for this). BavvbScan 1.1 `addon/BavvbScan/Sales.lua` records each auction sale when its gold reaches the
  character: it watches the inbox (any opener: by hand, Open All, TSM's mailbox), queues mails whose money leaves, and
  matches each gold rise (PLAYER_MONEY) to a set of queued mails summing to exactly that amount; a mail that comes back
  cancels its wait, so ghost mails / double clicks never count twice. Saved in `BavvbScanDB.sales` (format
  `bavvbsales` v1): records (item, count, price, deposit, cut, money, received = money - deposit = sale - AH cut (Josh
  chose this over the full mail gold; past typed entries used the full mail gold), status ok / nogold = mail left but no
  gold came, src invoice / subject) and one visit line per mailbox opening (goldIn, sales, deposits, other mail money,
  unexplained gold, missing). Mailbox open/close from PLAYER_INTERACTION_MANAGER_FRAME_SHOW/_HIDE (type MailInfo),
  as TSM reads them; MAIL_CLOSED only as a fallback (confirmed from the event log 2026-11-14: this client never sends
  MAIL_CLOSED, so the first version only saved visits on /reload). The chat report comes the moment the
  mailbox closes (Josh asked); the visit stays open 10 s more for late gold and the report is corrected only if that
  changes it. First real visits 2026-11-14: 4 sales on Xria (Horde), gold check OK.
  **Purchases** (Josh, 2026-11-14): "Auction won" mails (invoice "buyer": 4th value = total paid, 5th = quantity,
  checked by screenshot; 100 Pristine Leather came as one mail with 5 attachments of 20). Gold left at the AH, so the
  check is items: when a won mail leaves the inbox, that item's units that left the inbox and the bag rises
  (BAG_UPDATE_DELAYED, C_Item.GetItemCount) must cover its quantity; units from other mails of the same item count
  first. Records kind "buy" (price = total paid, itemID, status ok / noitem); visits buys / spent / buyMissing.
  **Won mails emptied over several visits** (Josh, 2026-11-14: he often has room for half a big purchase, mails it
  off, comes back for the rest): the check is per won mail (units taken out of it that reached the bags, other mails'
  units of the item first); each visit records the part that arrived at its share of the price (record count = units
  of the part, price = paid for them, plus mailCount / mailPrice), and `sales.wonCarry` remembers what is recorded of
  each mail still in the inbox ({sig, expiry, units, price, t}; expiry = now + daysLeft, fixed per mail; dropped after
  35 days). When the mail is gone the last part takes the rest of the price; units that never arrived are a noitem
  record. Matching a listing to a known mail: same sig, expiry within 300 s, units only go down, unchanged first, then
  closest expiry; a saved entry goes to the mail whose remaining + recorded = its quantity, and an untouched mail never
  takes one (identical mails bought seconds apart are interchangeable). A mail half-emptied before this version (no
  saved entry) ends with a noitem part for the earlier units (Add as purchase). Tracker: Purchases table under Sales; ticked when the
  tracker already knows the item, new items unticked; added as purchase entries (cards under Waiting for transfer).
  **Automatic chain with roles** (Josh, 2026-11-14; replaced the ticking): Josh's characters and strict roles:
  Alliance = Xfaction Bavvb (trader: buys/sells on the Alliance AH) + Jeder Hillmont (transfer: Blackwater), account
  THOROCKTHEBOLD; Horde = Xria Two (trader) + Horde Xria (transfer), account 1120039#2. Goods move between a faction's
  own characters by mail (ignored: same faction stock). **Short names collide**: UnitName is only the first word, and
  account 1120039#2 has Xria Two (Horde trader), Xria Forever (Alliance, not trading) and Xria Blacksmith, all "Xria"
  (character folders in WTF/Account/<acct>/91/ are "First-Last"). Since 2026-11-14 records and visits carry `guid`
  (UnitGUID) and `full` (UnitFullName's second word when it isn't the realm; unconfirmed what Forever returns).
  Roles (`doc.mail.roles`, trader / transfer / none) are keyed by GUID; older records without one count as the only
  GUID of that short name and faction, else as "name|faction" (`whoFinder`); a role set on "name|faction" carries over
  to that character's GUID while it's the only one. The old name-only roles / `chars` list count only for a name that
  is one character in the log (so "Xria" asked again; Xfaction stayed a trader). Checked on Josh's real files. `plan()` in mailSales.ts applies by itself (in
  MailPanel's effect, which saves whenever `plan().changed`): trader purchases -> one purchase card per item, faction
  and visit; **a transfer char's Blackwater won mail alone -> a transfer at once** (Josh, 2026-11-14: the seller's
  Blackwater gold arrives an hour+ later and he leaves it in the mailbox; with strict roles such a purchase is always a
  transfer), from the other faction at the price paid, applied to the oldest waiting cards (split across cards, rest
  free); the selling side's Blackwater sale, whenever collected, is matched to it (same item, quantity, price; mail
  becomes [won, sold]) and its cut checked at 15% +-1% (wrong cut -> Needs a look, transfer kept). A Blackwater sale
  with no such transfer waits ("Blackwater listings sold, no transfer yet": a stranger bought it -> Add as sale).
  Trader sales -> one sale per item, faction and visit while the faction holds the units; amber records, sales beyond
  stock or of unknown items -> "Needs a look" (Add / Dismiss). Known trade-off: a transfer char buying a stranger's
  Blackwater item counts as a transfer (delete it). Jeder's first Blackwater sale (2026-11-14) was collected with the
  addon off: recorded by hand; Dismiss its won-mail half if it shows. `sales.events` keeps the last 120 mailbox events for diagnosis. Never stores buyer/sender names. Forever's GetInboxInvoiceInfo (checked by screenshot
  2026-11-14): type, item, buyer, sale price, count, deposit, cut, 0, 0, 0, count, false; mail money = sale + deposit -
  cut. **Every character records** since 2026-11-16 (mail ledger, see Collector); from 2026-11-14 to 11-16 only the six
  trading characters did (`TRADERS` in Sales.lua, now removed: Xfaction Bavvb Player-6925-03AADB1A, Jeder
  Player-6925-037750ED, Horde Xria Player-6921-0306E8F7, Xria Two Player-6921-0308022D, Xfaction Two
  Player-6921-03DDDF8A (Alliance, account 1120039#2), Xfaction Horde Player-6925-03DF8156 (Horde, THOROCKTHEBOLD)).
  `/bscan mail off|on` still switches a character (BavvbScanDB.mailChars, by GUID). The trades page keeps the six as
  roles (`KNOWN_ROLES` in mailSales.ts, plus "Xfaction|Alliance"); other characters now show "Choose…" there (Josh
  no longer uses the page; it stays live, untouched). Sale records also carry `mailDaysLeft` (sale mails last 30 days:
  sale time ~ t - (30 - mailDaysLeft) days). Chat line since 2026-11-16 is short ("N sales (g), M purchases (g)
  recorded"; no checks or waiting notes; `/bscan sales` flags records whose gold/items weren't seen). Chat line after each visit (a popup with a Reload button was dropped 2026-11-14 at
  Josh's request: logging off writes SavedVariables too, so his routine is just to log off; the risk is a crash,
  which loses that session's records since the mails are gone); `/bscan sales`. Tested in a fengari harness (192 checks incl. the popup, purchases, partial won mails, GUIDs, the 60-day limit and per-character switch; scratchpad, gone).
  **Matching fixes (BavvbScan 1.2, 2026-11-15)** after two bad visits that morning: (1) 58 sale mails emptied in 6 s on
  Xfaction, none matched (the gold came in lumps over more than the 12-mail combination window, and unmatched mails at
  the queue's front blocked every later rise): now a single exact match searches every waiting mail, a rise equal to
  all waiting mails takes them all, and whenever the unmatched gold equals the waiting mails to the copper they are all
  paid. (2) 4 sale mails on Xria Two counted twice (first read before the subject loaded: sig "nil|money", kind other;
  the gold went to that copy): a mail without sale details "leaving" in the same read as a same-money mail arriving is
  the same mail. Events kept: 1000 (was 120). Checked in a fengari harness (10 scenarios, 31 checks; the old code fails
  15 of them; scratchpad). Trades page: a visit whose unmatched gold covers its "no gold" sale mails shows "Gold
  arrived: add N sales" (`markPaid`, `doc.mail.paid` = visit ids; those records then go through the normal sale path,
  per item and in stock).
  Tracker side (`mailSales.ts` tested, `mailLink.ts`, `MailPanel.tsx`): File > Link BavvbScan.lua (mailbox sales), one
  or more files (Josh has two accounts, 1120039#2 and THOROCKTHEBOLD), read on open and Refresh. Josh ticks his
  trading characters once (`doc.mail.chars`); suggestions grouped per item and faction, ticked in time order while the
  tracker holds the units on that faction (nogold and untracked items unticked); Add makes one sale per item+faction
  (`mail`: record ids), added or dismissed ids go in `doc.mail.handled` and never return. Visit checks show ✓ or amber.
- **Gold sent** (Josh, 2026-11-14): gold moved between the factions with a junk item, `GOLD_ITEM` = Skinning Knife
  (model.ts; Josh's choice, used for nothing else). The receiving side's transfer char lists it on Blackwater at the
  amount to send, the other side's transfer char buys it. Stored apart from the item entries (`doc.gold`: id, at, to,
  price, mail): the payer -price, `to` +price - 15%; the 15% counts against trading profit (`totals().goldLoss`,
  history days); no item, no stock. From the mailbox: a transfer char's Blackwater won mail of the knife -> gold sent at
  once; the listing side's Blackwater sale of it is matched later (same price and count, cut checked); one with no
  match waits like other Blackwater sales (a stranger bought it). Toolbar "Send gold" types one by hand; history rows
  "Gold sent" with Edit/Delete. Forever Market's Faction profit assumes these sends refill each trade's Blackwater cut.
- Figures: balances per faction and total gold = liquid gold only; tied up = cost of units held (not in the total;
  Josh confirmed); trading profit = received - cost of units sold - transfer loss, per item and overall (= total +
  tied up - starting gold - adjustments, tested).
- Storage like the shuffle app's edits but separate keys: file picked once (File > Create/Open trades file;
  Josh's file `data/private/trades.json`), IndexedDB key `tradesFile`; browser copy in IndexedDB `tradesCopy` (since
  2026-11-14; was localStorage `wow-forever-shuffle:trades:v1`, ~5 MB per site shared with the shuffle app, read once
  and removed after the first IndexedDB write; localStorage only if IndexedDB fails); newer savedAt wins; format
  `forever-trades` v2 (v1 read and converted). File > Download a copy.
- **Growth and speed** (measured 2026-11-14: 87 entries on day one, 19 KB; a simulated year at 90 entries/day =
  33k entries, ~5 MB): totals/ledger ~17 ms, mailbox plan ~27 ms, history ~9 ms. The waiting-cards calculation was
  quadratic (1.4 s a year in) and now goes through `movedFromCards` in one pass. The addon keeps 60 days of records
  and visits (KEEP_DAYS, pruned on save and at logout); the page ignores records older than 70 days (IGNORE_DAYS) and
  drops handled ids older than 75 (FORGET_DAYS; the time is in the id). So Josh must open the page at least every
  ~2 months; raw per-mail detail older than 60 days is gone by design (Josh: fine, no archive).
- **History grouped by day** (Josh, 2026-11-14: "just a huge long list"): today open, older days one line (entries,
  each faction's gold change, trading profit = sales' profit - Blackwater cut on that day's transfers;
  `historyDays` in model.ts, local days), click to open; a search box filters by item (or adjustment note) across
  all days, matching days open. Only open days draw rows.

## Model (must match the workbook)

All money is in copper (1g = 10000). "Blank" means unknown/unpriced, never zero.

**Quantity made**: `(qtyMin + qtyMax) / 2` (the parser already maps Wowhead's 0 to 1).

**Price used for reagent cost** (per item): typed price, else vendor buy price if *Use vendor buy price* is on and the
item has a curated vendor buy price, else imported price if *Use imported prices* is on, else blank.
- Vendor buy price = Wowhead `buy`, unless the user's `vendorBuyOverrides` has the item (`null` = no vendor sells it).
  Wowhead lists nominal buy prices for many items nobody sells, so this is curated by hand.
**Price used for selling** (DE materials and crafted products): typed price, else imported price. Never a vendor price.
**Imported price**: the chosen column (1, 2 or 3; default 3, Josh 2026-11-06, meant for Auctioneer's average of the
cheapest 15%) for the item ID; 0 or blank counts as no price. Two sources (Josh, 2026-11-12, "meaning A"): the price
import (`edits.imports`, if *Use imported prices*) and the **API data** (newest collector summary for *API auction
house*, default 111, if *Use API prices*; same three columns: lowest, median, cheapest 15%). Where both have the item,
the newer wins: the import's scan time (`importsInfo.dataAt`, BavvbScan/Auctioneer) or else its import time, against
the API snapshot's time; a tie goes to the import. Where only one has it, that one. The price's source shows as
"imported" or "API". The API data is read from the linked auction data folder and never stored in the edits.

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

## Leveling planner (started 2026-11-15; agreed with Josh step by step)

Cheapest route to level a profession with the app's prices. Pure code in `app/src/leveling/plan.ts` (tested in
`plan.test.ts` on a made-up profession); data in `app/public/leveling-data.json` from `parse_pages.py`.
- **Data**: every recipe with Wowhead skill colours [orange, yellow, green, grey] (incl. enchants that make no item),
  learnedat, source codes (6 = trainer), trainingcost, specialization, and `recipeItems` = recipe items seen on the
  AH, matched by name ("Pattern:/Plans:/Recipe:/Formula:/Schematic:/Manual: <recipe>", letters only, "the" dropped)
  against the collector's `F:\ForeverAuctionData\items.json` (cache `data/private/recipe-items.json`), plus
  `recipeItemAliases` in data/config/leveling.json for names that differ. Starters (known on learning the profession;
  Josh confirmed the list) are in the same file. 2026-11-15: 2,212 recipes, 466 trainer, 28 starter, 677 with an AH item.
- **Recipes used** (Josh): starters (free), trainer recipes (training cost) and recipes whose recipe item has a price
  (AH; vendor recipes count only this way; unseen = not available). Specialisation recipes and cooldown crafts (the
  model's rule: Transmute..., Mooncloth) are left out.
- **More recipes** (Josh, 2026-11-19: BoP vendor recipes such as the Merchant's Favor ones, rep, drops): every other
  non-spec, non-cooldown recipe of the profession (incl. AH recipes with no price right now) is a candidate. Ticked
  ones (`edits.leveling.recipes`, save file) are used **free** (Josh values the Favor himself). Unticked candidates
  whose skill range can raise a level of the route are listed with "Saves" = gold saved by that one recipe with the
  rest of the route's recipes as chosen (no re-search of AH recipes; approximate), or "reaches N more levels" where
  the route stops; the route is chosen by the choosing score, the saving shown is gold. Candidates never make
  reagents for other recipes. Saves in Recipes to learn is now gold too (was the choosing score with the 1s/craft
  time cost); when removing a recipe leaves a gap, that comparison may use any AH recipe again.
- **Working Overtime** (legacy talent; Josh, 2026-11-19): checkbox + points (default 12, `OVERTIME_PTS`; Josh's
  tentative test result, the talent text says 20%), saved in `edits.leveling.overtime`. Adds flat points to a green
  chance, capped at 100%; orange/yellow stay 100%, grey 0%. Not confirmed how the game codes it (flat vs x1.2).
- **Chance of a point** at skill s: 1 below yellow, (grey - s) / (grey - yellow) up to grey (+ Working Overtime's
  points if on), 0 from grey; 0 before learnedat (starters: from 1). Classic community formula, not confirmed on Forever.
- **Actions**: a recipe, with each same-profession craftable reagent either bought (its reagent price) or crafted
  (one level; its ingredients at the model's best cost); every craft in the action rolls for a point. Other reagents
  at the model's best cost (so Allow crafting applies), no skill credit.
- **Choice per skill level**: lowest (max(0, cost - vendor value of the product) + 1s x crafts) / expected points.
  Profit at the vendor counts as 0 (else low chances look better); 1s per craft is Josh's time cost (2026-11-15:
  Tailoring 1-300 498 -> 370 crafts for +0.45g), only for choosing, never in the totals. Products count at vendor
  value by default (Josh); DE and AH exits are shown, not counted.
- **Recipes to buy**: greedy: add the AH recipe that lowers the total most (its price included), drop a trainer recipe
  that doesn't pay for its training cost, repeat. "Saves" = total without it - total with it.
- **Quantities**: the route is simulated with dice rolls (2,000 runs, seeded): expected crafts and the 90% amount
  (covers 9 runs of 10) per stretch; intermediates kept in stock between crafts. Totals = mean; safe total = 90% of
  whole-route runs. The amount to queue = max(90% amount, mean rounded up) (Josh: one clear number, details in a hover).
- **View** (tab "Leveling", `LevelingView.tsx`, classes `lv-`; leveling-data.json fetched on first open): profession,
  from / to skill, time per craft in silver (per browser, localStorage `wow-forever-shuffle:leveling`). Summary
  (expected, "Bad luck" = 9 in 10, recipes and training, crafts), Recipes to learn (skill, trainer / AH item, cost,
  saves), Route (skill range, recipe + crafted reagents, Craft = amount to queue, Gold = stretch total vendor-only
  (Josh), Cost each; then a grey band "If you sell what one craft makes" (divider before it): Vendor / AH / Disenchant
  (Josh's order) = what one craft brings back that way, plain text, the best of the three green (ties: Vendor, AH;
  Josh chose this over "green when it beats Cost each"), the profit or loss in a hover; Sold / day = our sale estimate for the product on the API house's faction, from sales.json). Money in the
  route without copper once there is gold. **The route on screen stays fixed** (Josh, 2026-11-16: it changed under
  him mid-session when the 10-minute API read brought a new snapshot): new prices replace it only if the route itself
  (stretches + recipes to learn) is unchanged, or within 20 s of planning (start-up loading); otherwise an amber bar
  "Prices have updated… Re-plan" and the old route keeps its old figures. Input changes re-plan at once. Kept in a
  module variable, so it survives tab switches, not a reload. Design history (Josh, 2026-11-15): profit/loss pills with a starred best
  exit, then plain pills, then red/green text were all rejected as hard to read; losses everywhere drowned the signal. Click a stretch: what to craft and buy, with
  amounts for the queued crafts. Shopping list for the whole route: every stretch's amounts summed plus the AH recipe
  items (exact item names), as an Auctionator import (same format as the Shopping view); items a vendor sells (curated
  vendor buy price) listed apart, not on the list.

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
- **API prices** (Josh, 2026-11-12; `app/src/apiprices/`, class `papi`): File > Link auction data folder
  (F:\ForeverAuctionData, read-only handle in IndexedDB key `auctionDataDir`). Read on open, every 10 min while open, on
  Refresh now and when the house changes; walks summary/YYYY/MM/DD newest first (up to 72 files) for the house.
  Toolbar: "API: <data time>, house 111, N items (age)" (amber after 3 h), then "Import: ..." (was "Prices:").
  Settings > Prices: Use API prices, Auction house (list of the 15 with guessed labels; only 111 confirmed).
- Prices, Intermediates, DE table and Settings views (details in Build plan steps 7-10); Auctionator drop zone;
  Export/Import of edits.
- **Fixed top rows** (Josh, 2026-11-12: the bar moved between tabs): row 1 = title, view tabs, save status + File;
  row 2 (`.statusbar`, always present) = messages left, API / Import / Linked / History right. Both identical on every
  tab. Each view's own controls come below: List/Table/Favorites share `.rfilters` (search, Exit; List/Table add Min
  profit, Hide unpriced, Hide BoP, count, then the profession chips); Prices has its own `.pfilters`. Don't put
  per-view controls back into rows 1-2.
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
2026-11-12/13: Collector (Blizzard API auction history, cloud + PC sync, price database on F:), API prices in the
  shuffle app, and Forever Market steps 1-6 (names, Trends, TSM region sales, our sale-rate estimate + Method check,
  Faction tab), last 428747b, all pushed. Market is local only (not on GitHub Pages).

2026-11-10: Auctioneer 4.0.3 stopped loading (new hard dependency on LoadOnDemand Enchantrix); Josh uninstalled it
and BavvbScan replaced it (see Prices; 40e29a5, c1323de, live). "Sign off" phrase and checklist added.
Same evening: Shopping view (Auctionator shopping-list import for chosen recipes; see UI), f82eec8, live; Josh
checked it on the live site ("looks good").

2026-11-13 (evening session): NA PvP houses identified (110/113, see Collector > Houses; background data only, Josh's
  apps stay on PvE). Method check reads only the "r@Normal@" TSM section (a116e34). Forever Market redesign: light
  theme with coin / faction / quality colours, Wowhead item icons, Open Sans, a kept Light | Dark (Wowhead) switch,
  grey tab underline, sales as three tiles (f7bd332, b79dd57; see Forever Market > Look). Josh: "this looks perfect".
  All pushed except the final CLAUDE.md commits.
2026-11-14 (short session): Faction tab's sales header now names the destination faction (see Faction tab). Josh had
  asked for destination-side sales; it already was, the old "Sales / day*" header just didn't say so.
  Then the p3 / cheapest15 wall cutoff (see Prices > Auctioneer; 9772f07, pushed and live); all summaries on F: and
  market.db recomputed. Josh's saved imports keep the old p3 until his next Refresh / import. Older files in
  data/private/price-history/ keep the old p3 (archive only).
  Then the Trade tracker (see its section): discussed Google Sheet vs Market tab vs claude.ai page vs GitHub; Josh
  chose a separate GitHub page saving to a file. Built, demoed locally, pushed and live.
  Later the same day (after real use): batches dropped for per-item stock pools with average cost (sales were too
  scattered to match to purchases), purchase cards + "Transfer to ..." kept at Josh's request, item Edit panel for
  typos (8948234, pushed and live).
  Then (same day): transfer prices typed per unit, and partial transfers from a purchase card (the rest stays on the
  card) (b2f9f9d, pushed and live; checked in headless Chrome, not yet by Josh). Josh asked how often Market updates:
  one snapshot an hour (Blizzard ~:22, in Market after the :55 sync, only while the PC is on).
  Then (same day): Avg buy / Avg sell columns in both item tables, for restock prices (9dfa364), and price each on
  purchase cards (4d364fe); both pushed and live, checked in headless Chrome, not yet by Josh.
2026-11-14 (evening, long session): mailbox log for the trade tracker (see Trade tracker > Sales from the mailbox).
  Josh found typing scattered sales tedious and doesn't trust TSM's records, so BavvbScan 1.1 records auction sales
  (gold-checked) and purchases (bag-checked) from the mailbox, with a chat report the moment the mailbox
  closes; the trades page applies them by itself from character roles: purchases -> cards, a Blackwater won mail ->
  transfer at once, seller's gold matched later, sales while in stock. Commits b05e67d .. f6c2cae, all pushed and
  live. Found on the way: this client never sends MAIL_CLOSED (interaction events used); short names collide ("Xria" x3;
  GUIDs used). Verified for real: sales and gold checks on Xria Two and Xfaction, and a full Horde -> Alliance
  Pristine Leather transfer (Jeder's won mail -> transfer on the card, instant). Josh: "leave alone" the ~25c price
  differences on his three hand-typed transfers of earlier that day.

2026-11-14/15 (late session): BavvbScan's mailbox popup dropped, chat line kept (6a5543d; Josh logs off instead of
  /reload; copied to the WoW AddOns folder). Josh struggled to find Horde -> Alliance return trades, so: Forever Market
  Faction tab switch "Send the gold back to Alliance" (ab4c32b) and "Gold sent" with a Skinning Knife in the trade
  tracker, both directions (e0776ac). All pushed; the trades page is live.

2026-11-15 (short session, talk + one model change): Josh decided to fund Horde with Skinning Knife gold sends
  (Horde -> Alliance has far more trades; he can't keep Horde stocked from sales). Worked through the cost with him
  ("100g on Horde, buy 10g, sell 15g -> 2.49g"): only the 15% Blackwater cut leaves the buying side's pool (the
  transfer listing returns 85%), and refilling it costs 17.6% of the cut. Faction profit is now sell x 0.95 - buy / 0.85
  in both directions; both gold checkboxes removed (d49517c, b5b004b, pushed). Magnitude on one snapshot: 143 of 2,982
  rows dropped (all < 2.6% above old break-even, 1.8g total), top 50 by profit 49/50 the same. Considered and not built
  (Josh agreed it would double up): a per-item "gold cost" share in the trade tracker.
2026-11-15 (morning session, mailbox fixes): a big mailbox gave ~100 "no gold" warnings. Two addon bugs (see Sales
  from the mailbox > Matching fixes): gold lumps over the 12-mail window blocked the queue (Xfaction 9:05, 58 mails;
  Horde Xria 9:13, 29; Jeder 9:14, 10, all old addon), and mails read before their subject loaded waited twice (Xria
  Two 9:10, 4 sales). BavvbScan 1.2 (d71e0cb) + "Gold arrived: add N sales" on the trades page; Josh used it on all
  three visits (39 Blackwater sales paired with existing overnight transfers, cuts OK) and added the 4 by hand. Visit
  lines now go once their records are handled (87653b4). New traders: Xfaction Two (Alliance, account 1120039#2,
  7aa2c00) and Xfaction Horde (Horde, account THOROCKTHEBOLD, 8a3c5d5); both in TRADERS and the page's KNOWN_ROLES.
  Xfaction Two had BavvbScan disabled in its AddOns list (found from 91/Xfaction-Two/AddOns.txt; Josh enabled it,
  nothing was collected before). All pushed and live.
2026-11-15 (evening session): profession leveling planner (see Leveling planner), built step by step with Josh:
  data (1248844; Josh re-saved eight profession pages first, Mining left at 11-05; the five hand-removed vendor prices
  removed again), planner + tests, the Leveling tab with whole-route Auctionator list, sales.json from the sync for
  Sold / day (93b9b98), then several design rounds on the exit columns (736885d, cdf67f3). All pushed and live.
  Josh confirmed: starter recipes, vendor value only in Gold, AH recipes only when seen on the AH, no specialisations,
  1s per craft, crafting intermediates per stretch. Josh's live-site menu was checked by screenshot: BavvbScan.lua
  linked, auction data folder linked, save file and price history on (an older screenshot with Auc-ScanData.lua
  linked came from another browser/site).

2026-11-16 (afternoon): Josh retired the trade tracker in practice (cumbersome with several characters; trades
clearly profitable, no interest in its stats). Replaced by the mail ledger (see Collector): every character records,
archived hourly on F:. The trades page stays live, unused. Confirmed 2026-11-17: the sync writes "ledger: N new
entries from 2 account(s)" each run (e.g. 202, 93). Not yet seen for real: the short chat line on a new character.

Where we left off (2026-11-15 evening, signed off): the Leveling tab is live and Josh will use it when he levels a
profession, coming back with specific questions (he prefers that to working through check lists; see memory).
2026-11-16 just after midnight: Josh is levelling Leatherworking 85 -> 243 on the route saved in
`data/private/leveling-route-leatherworking-85-243.md` (rebuilt at the 06:17 UTC snapshot after the live route changed
under him; he confirmed it). Since 787fc85 the page keeps a route fixed until Re-plan. Nothing
was checked by him in game yet: the whole-route Auctionator import, Sold / day in his browser (headless Chrome can't
open F:). The sync writes sales.json by itself every run (confirmed 2026-11-17, ~6,700 items per faction).
2026-11-16 (short session, talk + one change): snipe protection for cross-faction transfers. Josh is about to move
well-known high-value items, which bots on Blackwater will snipe at the buy-price listing (he can't beat them on
speed). Worked out with him: listing the transfer at sell x 0.95 leaves a sniper nothing; the cost is a fixed
share of profit (keep 85% if the gain stays on the buying faction, 72.25% if knifed back, whatever the gap); a
listing above 95% adds cut, not protection; a high listing is the same as a cheap one plus a knife send of the
difference. Built the Faction tab's **Protected** checkbox (72.25%, Josh's choice since he knifes profit back;
4002f76, pushed; Josh checked it: "everything looks good"). Blackwater deposits go by vendor price (Josh).
Not built, could matter once he uses it: the trade tracker records the higher transfer price as typed (its totals
stay right); nothing flags which items bots watch, Josh decides per item.
2026-11-17 (morning session, fixes): Market looked stale because the PC was off ~2:55-9:30 local; the logon sync
caught up (one download "terminated" mid-way on a slow just-logged-on network, stored by the next hourly retry).
Blizzard skipped the 15:17 UTC update (data jumped 14:17 -> 16:25; unrecoverable). Two fixes, both pushed: a snapshot
stored late now has its sale-estimate pairs redone (ed50683), and the Method check caches each pair on F: (82 s ->
0.5 s, 2e85119). Josh hasn't yet reported back on the Method check figures themselves (2,892 records now: sales+buys
detected 60% (867 of 1,435 judged; 803 sales "invisible"), well below the 88% of the 140-record v2 check; the
~100+ records for a method review now exist: raise it when he next looks at Market).
2026-11-18 (short session): "snapshot could not be stored" toast after the PC was off ~3:55 am-2:05 pm local; the
logon sync's first download hit "fetch failed" (10 others stored). Stored by a manual sync, late-snapshot redo
recalculated 20 pairs, no data lost. Fix: one retry 30 s later before alerting (see Collector > PC side); not yet
exercised for real (watch for "retrying in 30 s" in sync.log after the next morning backlog).
Unconfirmed from the 11-17 morning (raise only if relevant to what he is doing): a big sales mailbox through BavvbScan 1.2,
Xfaction Bavvb / Jeder on 1.2, Xfaction Two's and Xfaction Horde's first records, a Skinning Knife gold send end to
end ("1 gold sent", History row, no knife in stock, seller's gold matched later), the Faction tab without the two
checkboxes (Market restart), a seller's Blackwater gold matched to an item transfer, a wrong-cut flag, a won mail
emptied across two visits. Josh funds Horde with Skinning Knife sends (Horde Xria lists, Jeder buys). If he later
wants per-item gold cost in the tracker, the design is: 17.6% of the net gold an item took from the buying side's
pool (credit for gold it brought), leftover = 17.6% of the float.
Earlier state (2026-11-13 evening): Forever Market steps 1-7 done; its new look and sales tiles are
done and checked by Josh. Cycles waits for data (shows "Still collecting" until items have 2 days with 12+ priced
hours that share hours: first rough results around midday 2026-11-14; amber "rough" until 7 days, ~2026-11-20);
Faction works now, with Steady and Sales/day firming up as data grows. Next: Josh uses Price history, Faction and
Cycles on live data and comes back with iterations; he wants to discuss adjusting the Cycles conditions (window,
stretch length, 12-hour day rule, 2-day minimum, a held-on threshold above break-even) once he has seen results.
Josh asks ad-hoc price questions about any house (e.g. Swiftthistle 2452 on PvP 2026-11-13: ~9s 40c Alliance 110,
~8s 30c Horde 113 vs ~2s 50c-3s on his PvE); answer from market.db (`prices`, cheapest15 per hour, local days).
The sales estimate's confidence was explained to him (Method check: ~96% of his buys, ~half of his sales caught,
misses = sales near listing end; leans low); rules change only with his yes after ~100+ more records.
Collection check 2026-11-13: every hourly snapshot stored since the Google timer took over (2026-11-12 17:40 PT);
one hour lost before it (2026-11-12 15:22 PT, manual-run period); the one failed run was the deliberate test; Google
skipped one timer start (09:40 PT) at no cost. Check 2026-11-17 (Josh asked): 107 snapshots 11-12 20:22 to 11-17
08:17 UTC, all 15 houses each hour, every run successful, sync "0 problem(s)", F: 857 GB free. One more hour missing:
2026-11-13 19:22 UTC; right after it Blizzard's refresh moved from :22 to :17, so likely a skipped Blizzard update
(unproven, run logs gone); no gaps since. The collector and PC sync run unattended (scheduled sync + name fetch
are normal background Node processes; don't stop them).
Shuffle app: Favorites and API prices shipped and live. Josh uses them with real scans and comes back with
iterations. BavvbScan is the price source for up-to-the-minute prices; its scan panel is in use
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
  any change to `addon/BavvbScan/` (a `/reload` loads it, even new files and .toc changes:
  Josh, 2026-11-14; no restart needed).
  Copied 2026-11-11 with the scan panel; 2026-11-14 with Sales.lua (1.1), 2026-11-15 with 1.2 (matching fixes), last copy 2026-11-16 (every character records, short chat line). A fengari harness for Sales.lua (mock mailbox, gold, bags; 156 checks; rebuilt 2026-11-15
  as 10 matching scenarios / 31 checks on BavvbScanSalesCore with a CreateFrame stub) lived in the scratchpad and is
  gone; rebuild it the same way before changing Sales.lua. To check the page on Josh's real files without a browser:
  a throwaway script in app/src/trades running readMailLog + mergeLogs + plan via `npx vite-node` (delete after). `.gitignore` ignores `*.lua` (SavedVariables copies) with an
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
  "Forever-US". Since 2026-11-13 the TSM app also downloads "Normal-Horde", "PvP-Alliance" and "PvP-Horde" (Josh added
  them; nothing reads those blocks). Kinds: NON_COMMODITY_DATA (minBuyout, numAuctions, marketValueRecent), NON_COMMODITY_SCAN_STAT
  (marketValue = DBMarket), NON_COMMODITY_HISTORICAL (historical), REGION_STAT (regionMarketValue), REGION_HISTORICAL,
  REGION_SALE (regionSale, regionSoldPerDay, regionSalePercent: the last two are x1000, confirmed by Josh against
  TSM's tooltip 2026-11-13; Forever Market reads them, see there). A trial CSV is `data/private/tsm-prices-2026-11-06.csv` (p1 minBuyout,
  p2 marketValueRecent, p3 marketValue). Next step when Josh wants it: a TSM reader (link AppData.lua like the
  scan file) and his choice of which figures fill the three columns; needs his yes. TSM's full scan only runs on the
  Mists client and only uploads listings; it is not a price source by itself. TSM on that account also records his
  real AH sales (TradeSkillMaster.lua `csvSales`).
- Auctioneer history (removed 2026-11-10; its reader stays for old scans): its Forever build needed local patches to
  CoreScan.lua for the scan timeout (gone with the uninstall); scans took ~4 min because of Auctioneer's own storing;
  `/reload` cleared its 15-minute guard; tooltip errors in `!Swatter.lua` were harmless noise.

Open items to raise when relevant:
- Leveling planner (2026-11-15): the skill-up chance is the Classic community formula, not confirmed on Forever (if
  a green recipe levels noticeably faster or slower than planned, check it). Sold / day overstates cheap, heavily
  relisted items (Linen Bag ~425/day, Red Linen Bag ~900/day). Offered, not decided: Sold / day next to AH (it now sits
  after Disenchant since Josh reordered Vendor / AH / Disenchant). Known simplifications: only one level of
  same-profession crafting earns skill points; AH recipes chosen greedily one at a time (no pairs); trainer rank
  purchases (75/150/225) not modelled; recipes whose yellow is 0 on Wowhead use a pessimistic chance. A new
  profession page re-parse needs `F:\ForeverAuctionData\items.json` for the recipe-item match (else the cache in
  data/private/recipe-items.json is used), and new name mismatches go in `recipeItemAliases`.
- Mail ledger / mailbox log (every character since 2026-11-16, 069b9f6): BavvbScan must be enabled per character in
  WoW's AddOns list or that character records nothing (Xfaction Two started disabled): check
  `WTF/Account/<acct>/91/<First-Last>/AddOns.txt`. If records look wrong: read both accounts' SavedVariables
  (records, visits, `sales.events`, 1000 kept) and the ledger files; the sync.log "ledger:" lines show each run.
  Records match gold to mails (1.2 fixes); a record with status nogold/noitem is kept as is (no tracker to fix it).
  When Josh can't paste from the game, ask for a screenshot (Print Screen) and read the newest file in
  F:\World of Warcraft\_forever_\Screenshots. Not yet seen for real: partial won mails across visits.
- Trade tracker: retired in practice 2026-11-16 (page live, unused, never removed unless Josh asks). Its data up to
  then is in data/private/trades.json and the copy in the ledger folder.
- Wall cutoff (2026-11-14): Josh hasn't yet looked at the new figures in the apps (check steps given: Mud Snapper Horde
  ~10c, Stonescale Eel Horde ~1s 64c). If a price looks wrong, print the item's listing ladder from the raw snapshot
  first (that is how the wall was found). A cheap cluster holding over 5% of units would still set the anchor low.
- Forever Market: weekday patterns in Cycles (not built; need ~3 weeks of data, ~2026-12-03). Sale-rate method:
  re-run the Method check and consider tuning only once ~100+ more of Josh's TSM records exist; record any new method
  version in `market/method-history.json`. 110/113 are PvP (2026-11-13); the realms behind 119/120/121 and
  123/124/125 are unconfirmed (collected anyway). Josh doesn't need them now and will ask (method: add the realms in
  the TSM app and match its AppData.lua against the houses, as for PvP). These need no input from Josh: raise them
  when due (Cycles results ~2026-11-14, firm ~11-20; weekday patterns ~12-03; method review at ~100+ more records).
- Parked 2026-11-11 (Josh: not now): in-game companion in BavvbScan. The app would write
  `Interface\AddOns\BavvbScan\AppData.lua` (TSM-style; the AddOns folder is shared by all accounts) with per-recipe
  cost, exits, profit and the Shopping list; the addon would show a panel beside the profession window and create
  the Auctionator list on /reload via `Auctionator.API.v1.CreateShoppingList(callerID, name, searchStrings)` (exists
  in v345, replaces a same-name list). Costs a second /reload after Refresh. Open questions were: auto-create vs
  button, list name, Enchanting (CraftFrame) left out, which characters. Josh wanted ToS-clean: paste or
  file-write only, no automation.
- Wowhead vendor buy prices removed by hand from `game-data.json` (2026-11-11; Josh: incorrect, ignore for now):
  Black Lotus 13468 (40s), Pyrite 249391 (4s), Pristine Leather 249427 (5s), Pristine Hide 249428 (10s), Pristine
  Scale 249429 (15s). The new Tailoring page lists them; `parse_pages.py` puts them back on every run (last removed
  again 2026-11-15 after the re-parse). Remove them again after a parse (or have Josh mark them "No vendor sells it" in the Prices view, which survives re-parses).
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
- **Kept-alive views** (2026-11-12, tab-switch lag): List and Prices stay mounted once opened and are hidden
  (`.vkeep.off`, display none) when another view shows; `useResetOnShow` (`app/src/keepAlive.ts`) resets their sort,
  open cards, filters and scroll on return, as the old rebuild did (Josh: keep behaviour as close to today as
  reasonable). Their rows are memoised apart (`ListBody`, `PriceRows`) and App's card props are stable, so a switch
  doesn't re-render 2,000 rows; rows use `content-visibility: auto`. Production build: arriving at List 230-300 ms ->
  ~25-30 ms, Prices 580-650 -> ~45-55; screenshots pixel-identical. Keep new props to these views stable (useCallback/useMemo).
- Views: List · Favorites (`favorites/`) · Table · Prices (`itemprices/`) · Intermediates (`intermediates/`) · DE table (`detable/`) · Settings
  (`settings/`) · Shopping (`shopping/`) · Leveling (`leveling/`). Pure logic sits next to each view with a `.test.ts`; the model stays in `model/`.
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
