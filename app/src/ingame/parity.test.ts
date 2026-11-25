// The in-game favorites panel (addon/BavvbScan/FavCore.lua) must give the app's numbers. Runs the Lua in fengari on
// Favorites.lua (exportLua), a BavvbScan scan and hourly API prices, and the app's compute() + recipeDetail() on the
// same inputs, and compares every favorite: costs, exits, best exit, profit, and each cost-breakdown line.
// A made-up case always runs; Josh's real save file, scan and ApiPrices.lua are used when present.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fengari from 'fengari'
import { describe, expect, it } from 'vitest'
import defaults from '../../../data/config/defaults.json'
import deTableJson from '../../../data/config/de-table.json'
import { compute, emptyEdits, makeConfig, normalizeEdits, recipeDetail, type ApiPrices, type DeBand, type Edits, type GameData, type ImportRow, type Settings } from '../model'
import { readBavvbScan } from '../prices/bavvbscan'
import { auctionatorImport, shopLines } from '../shopping/list'
import { buildExport, exportLua } from './export'

const toLuaEntries = (e: { id: number; count: number }[]) => '{' + e.map((x) => `{ id = ${x.id}, count = ${x.count} }`).join(', ') + '}'

const ROOT = resolve(__dirname, '../../..')
const CORE = readFileSync(resolve(ROOT, 'addon/BavvbScan/FavCore.lua'), 'utf8')
const config = makeConfig(defaults as { settings: Settings; cooldownCrafts: { namePrefixes: string[]; names: string[] } }, deTableJson as { bands: DeBand[] })

const JSON_LUA = `
local function enc(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then return string.format("%.17g", v) end
  if t == "string" then return '"' .. (v:gsub('[%c"\\\\]', function(c) return string.format("\\\\u%04x", c:byte()) end)) .. '"' end
  local out = {}
  if v[1] ~= nil or next(v) == nil then
    for i = 1, #v do out[i] = enc(v[i]) end
    return "[" .. table.concat(out, ",") .. "]"
  end
  for k, x in pairs(v) do out[#out + 1] = enc(tostring(k)) .. ":" .. enc(x) end
  return "{" .. table.concat(out, ",") .. "}"
end
`

/** Runs the Lua sources in order, then `code` (which must return a table), and gives back that table as JSON. */
function runLua(sources: string[], code: string): any {
  const { lua, lauxlib, lualib, to_luastring } = fengari
  const L = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(L)
  for (const [i, src] of [...sources, JSON_LUA + 'BAVVB_OUT = enc((function() ' + code + ' end)())'].entries()) {
    if (lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring(`chunk${i}`)) !== 0 || lua.lua_pcall(L, 0, 0, 0) !== 0) {
      throw new Error(lua.lua_tojsstring(L, -1))
    }
  }
  if (lauxlib.luaL_loadbuffer(L, to_luastring('return BAVVB_OUT'), null, to_luastring('out')) !== 0 || lua.lua_pcall(L, 0, 1, 0) !== 0) throw new Error(lua.lua_tojsstring(L, -1))
  return JSON.parse(lua.lua_tojsstring(L, -1))
}

const SRC: Record<string, string> = { Typed: 'custom', 'Vendor buy': 'vendor', Imported: 'scan', API: 'api', Craft: 'craft' }
const same = (a: unknown, b: unknown, what: string) => {
  const x = a ?? null, y = b ?? null
  if (typeof x === 'number' && typeof y === 'number') expect(Math.abs(x - y), `${what}: lua ${x}, app ${y}`).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(y)))
  else expect(x, what).toEqual(y)
}

/** API text (ApiPrices.lua) -> the app's ApiPrices for one faction. */
function apiFromLua(text: string, faction: string, at?: number): ApiPrices | null {
  const head = new RegExp(`\\b${faction} = \\{ house = (\\d+), t = (\\d+), items = \\{([^}]*)\\}`).exec(text)
  if (!head) return null
  const rows: ImportRow[] = []
  for (const m of head[3].matchAll(/\[(\d+)\] = "(\d*):(\d*):(\d*)"/g)) {
    const n = (s: string) => (s === '' ? null : Number(s))
    rows.push({ item: Number(m[1]), p1: n(m[2]), p2: n(m[3]), p3: n(m[4]) })
  }
  const t = at ?? Number(head[2])
  return { house: Number(head[1]), snapshot: '', at: new Date(t * 1000).toISOString(), rows }
}

/**
 * Compares Lua and app for every favorite. `scanLua` defines BavvbScanDB (a SavedVariables file); `apiLua` defines
 * BavvbScanApi. `apiT` overrides the API data's time in both (to test either side of "newer wins").
 */
function compare(game: GameData, base: Edits, scanRaw: Uint8Array, scanLua: string, apiLua: string, apiT?: number) {
  const scan = readBavvbScan(scanRaw)
  const faction = scan.server.split('_').pop()!
  const edits: Edits = {
    ...base, imports: scan.result.rows,
    importsInfo: { source: 'BavvbScan', at: new Date().toISOString(), count: scan.result.rows.length, dataAt: new Date(scan.scanTime * 1000).toISOString() },
  }
  const api = apiFromLua(apiLua, faction, apiT)
  const result = compute(game, config, edits, api)
  const deTable = edits.deTable ?? config.deTable
  const favLua = exportLua(buildExport(game, result, edits, deTable), 0)
  const out = runLua([CORE, favLua, scanLua, apiLua], `
    ${apiT !== undefined ? `BavvbScanApi.${faction}.t = ${apiT}` : ''}
    local res = BavvbScanFavCore.compute(BavvbScanFavorites, BavvbScanDB.scan, BavvbScanApi, "${faction}")
    local rows = {}
    for _, g in ipairs(res.groups) do for _, r in ipairs(g.rows) do rows[#rows + 1] = r end end
    return rows`) as any[]

  const byId = new Map(result.recipes.map((r) => [r.recipe.id, r]))
  const expected = edits.favorites.groups.flatMap((g) => g.recipes).filter((id) => byId.has(id))
  expect(out.map((r) => r.id)).toEqual(expected)
  let lines = 0
  for (const lr of out) {
    const row = byId.get(lr.id)!
    const n = row.recipe.name
    for (const k of ['buyAll', 'cheapest', 'vendorValue', 'deValue', 'ahPrice', 'ahValue', 'bestExitName', 'bestValue', 'profitBest'] as const) same(lr[k], row[k], `${n} ${k}`)
    same(lr.ahSource, row.ahSource && SRC[row.ahSource], `${n} ahSource`)
    expect(lr.unpriced, `${n} unpriced`).toEqual(row.unpricedExits)
    const d = recipeDetail(result, row, game)
    expect(lr.lines.length, `${n} lines`).toBe(d.lines.length)
    d.lines.forEach((l, i) => {
      const x = lr.lines[i]
      same(x.item, l.item, `${n} line ${i} item`)
      same(x.unit, l.unit, `${n} ${l.name} unit`)
      same(x.total, l.total, `${n} ${l.name} total`)
      same(x.buyUnit, l.buyUnit, `${n} ${l.name} buy`)
      same(x.source, l.source && SRC[l.source], `${n} ${l.name} source`)
      same(x.craft?.cost, l.craft?.cost, `${n} ${l.name} craft cost`)
      same(x.craft?.used, l.craft?.used, `${n} ${l.name} craft used`)
      l.craft?.lines.forEach((s, j) => {
        same(x.craft.lines[j].unit, s.unit, `${n} ${l.name} > ${s.name} unit`)
        same(x.craft.lines[j].total, s.total, `${n} ${l.name} > ${s.name} total`)
        same(x.craft.lines[j].source, s.source && SRC[s.source], `${n} ${l.name} > ${s.name} source`)
      })
      lines++
    })
  }

  // the shopping list: every favorite with 1-3 crafts, as the app's Shopping view with its default ticks
  const entries = expected.map((id, i) => ({ id, count: (i % 3) + 1 }))
  const shop = runLua([CORE, favLua, scanLua, apiLua], `
    ${apiT !== undefined ? `BavvbScanApi.${faction}.t = ${apiT}` : ''}
    local res = BavvbScanFavCore.compute(BavvbScanFavorites, BavvbScanDB.scan, BavvbScanApi, "${faction}")
    local list = BavvbScanFavCore.shopping(BavvbScanFavorites, res.inter, ${toLuaEntries(entries)})
    local terms = { "L" }
    for _, l in ipairs(list.buy) do terms[#terms + 1] = BavvbScanFavCore.searchTerm(l.name, l.qty) end
    return { terms = table.concat(terms, "^"), vendor = #list.vendor, unknown = #list.unknown }`)
  const appLines = shopLines(game, result, { recipes: entries, ticks: {}, listName: null })
  expect(shop.terms).toBe(auctionatorImport('L', appLines))
  expect(shop.unknown).toBe(0)
  return { recipes: out.length, lines, out, shop }
}

// ---------- made-up case ----------
const band: DeBand = { band: 'Uncommon 21-25', quality: 'Uncommon', type: 'Any', ilvlMin: 21, ilvlMax: 25, note: '', results: [
  { item: 900, name: 'Dust', chance: 0.75, min: 2, max: 3 },
  { item: 901, name: 'Essence', chance: 0.25, min: 1, max: 2 },
] }
const game: GameData = {
  professions: ['Tailoring', 'Alchemy'],
  items: {
    1: { id: 1, name: 'Bag', sell: 500, quality: 2, class: 4, ilvl: 22, bind: 'equip' },
    2: { id: 2, name: 'Bolt', sell: 40 },
    3: { id: 3, name: 'Cloth', sell: 10 },
    4: { id: 4, name: 'Thread', sell: 25, buy: 100 },
    6: { id: 6, name: 'Robe', sell: 900, quality: 2, class: 4, ilvl: 24, bind: 'pickup' },
    7: { id: 7, name: 'Potion', sell: 30 },
    8: { id: 8, name: 'Herb' },
    900: { id: 900, name: 'Dust' },
    901: { id: 901, name: 'Essence' },
  },
  recipes: [
    { id: 10, name: 'Bag', profession: 'Tailoring', skill: 100, product: 1, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2, qty: 2 }, { item: 4, qty: 1 }] },
    { id: 11, name: 'Bolt', profession: 'Tailoring', skill: 50, product: 2, qtyMin: 1, qtyMax: 1, reagents: [{ item: 3, qty: 3 }] },
    { id: 12, name: 'Robe', profession: 'Tailoring', skill: 120, product: 6, qtyMin: 1, qtyMax: 1, reagents: [{ item: 2, qty: 4 }, { item: 8, qty: 1 }] },
    { id: 13, name: 'Potion', profession: 'Alchemy', skill: 60, product: 7, qtyMin: 1, qtyMax: 3, reagents: [{ item: 8, qty: 2 }] },
  ],
}
const scanLua = `BavvbScanDB = { scan = { format = "bavvbscan", version = 1, realm = "R", faction = "Alliance", time = 2000, auctions = 9, listings = 9, bidOnly = 0, skipped = 0,
  items = { [3] = "20:2000,5:450,1:5000", [2] = "1:3000", [1] = "1:20000,2:42000", [900] = "10:9000", [7] = "5:999" } } }`
const apiLua = `BavvbScanApi = { Alliance = { house = 111, t = 1000, items = { [3] = "80:90:85", [8] = "300:310:305", [901] = ":5000:", [1] = "1:2:3" } } }`

describe('FavCore.lua gives the app\'s numbers', () => {
  const edits: Edits = { ...emptyEdits(), deTable: [band], favorites: { groups: [{ id: 'g', name: 'A', recipes: [10, 12] }, { id: 'h', name: 'B', recipes: [13] }] } }
  const raw = new TextEncoder().encode(scanLua)

  it('scan newer than the API: scan prices, API fills the gaps', () => {
    const r = compare(game, edits, raw, scanLua, apiLua)
    expect(r.recipes).toBe(3)
    const bag = r.out[0]
    expect(bag.lines[0]).toMatchObject({ source: 'craft' }) // Bolt crafted from scan Cloth
    expect(bag.lines[1]).toMatchObject({ source: 'vendor', unit: 100 })
    expect(r.out[1].ahApplies).toBe(false) // Robe binds on pickup
    expect(r.out[1].lines[1].source).toBe('api') // Herb only in the API
  })
  it('API newer than the scan: API wins where it has the item', () => {
    const r = compare(game, edits, raw, scanLua, apiLua, 3000)
    expect(r.out[0].ahSource).toBe('api')
  })
  it('custom prices, Allow crafting off, Use chains off, another column', () => {
    compare(game, { ...edits, typedPrices: { 8: 77 }, allowCrafting: { 2: false }, settings: { importColumn: 1 } }, raw, scanLua, apiLua)
    compare(game, { ...edits, useChainsNo: [10], settings: { importColumn: 2, useVendorBuy: false, ahCut: 0.1 } }, raw, scanLua, apiLua)
  })
  it('scan prices match the app\'s pricesFromUnits, wall cutoff included', () => {
    const lists = ['20:2000,5:450,1:5000', '1:21,1900:311600,5:9999999', '3:300', '1:10,1:10,2:40']
    const got = runLua([CORE], `local o = {} for i, s in ipairs({${lists.map((s) => `"${s}"`).join(',')}}) do o[i] = { BavvbScanFavCore.summarize(s) } end return o`)
    lists.forEach((s, i) => {
      const row = readBavvbScan(new TextEncoder().encode(`BavvbScanDB = { scan = { format = "bavvbscan", version = 1, items = { [5] = "${s}" } } }`)).result.rows[0]
      expect(got[i], s).toEqual([row.p1, row.p2, row.p3])
    })
  })
})

// ---------- Josh's real files ----------
const WTF = 'F:/World of Warcraft/_forever_'
const realFiles = {
  save: resolve(ROOT, 'data/private/shuffle-edits.json'),
  scan: `${WTF}/WTF/Account/1120039#2/SavedVariables/BavvbScan.lua`,
  api: `${WTF}/Interface/AddOns/BavvbScan/ApiPrices.lua`,
}
const haveReal = Object.values(realFiles).every((f) => existsSync(f))

describe.skipIf(!haveReal)('FavCore.lua on Josh\'s favorites, scan and API prices', () => {
  if (!haveReal) return
  const realGame: GameData = JSON.parse(readFileSync(resolve(ROOT, 'app/public/game-data.json'), 'utf8'))
  const edits = normalizeEdits(JSON.parse(readFileSync(realFiles.save, 'utf8'))).edits
  const raw = readFileSync(realFiles.scan)
  const scanText = raw.toString('latin1')
  const api = readFileSync(realFiles.api, 'utf8')
  const scanTime = readBavvbScan(raw).scanTime

  it('as the files stand', () => {
    const r = compare(realGame, edits, raw, scanText, api)
    expect(r.recipes).toBeGreaterThan(0)
  }, 30000)
  it('with the scan newer than the API', () => {
    compare(realGame, edits, raw, scanText, api, scanTime - 3600)
  }, 30000)
})

// ---------- the panel (FavPanel.lua) with stand-ins for WoW's frame API: catches errors, shows its text ----------
const PANEL = readFileSync(resolve(ROOT, 'addon/BavvbScan/FavPanel.lua'), 'utf8')
export const WOW_STUBS = `
local frames = {}
BAVVB_FRAMES = frames
local function obj(kind)
  local o = { kind = kind, scripts = {}, shown = true, text = "" }
  return setmetatable(o, { __index = function(t, k)
    if k == "Show" then return function(self) self.shown = true end end
    if k == "Hide" then return function(self) self.shown = false; if self.scripts.OnHide then self.scripts.OnHide(self) end end end
    if k == "IsShown" then return function(self) return self.shown end end
    if k == "SetScript" or k == "HookScript" then return function(self, name, fn) self.scripts[name] = fn end end
    if k == "SetText" then return function(self, s) self.text = s end end
    if k == "GetText" then return function(self) return self.text end end
    if k == "GetParent" then return function(self) return self.parent end end
    if k == "CreateFontString" or k == "CreateTexture" then return function(self) return obj("region") end end
    if k == "GetHeight" or k == "GetWidth" then return function() return 500 end end
    if k == "GetLeft" or k == "GetTop" then return function() return 100 end end
    if k:sub(1, 1):match("%l") then return nil end -- a field, not a method
    return function() end
  end })
end
function CreateFrame(kind, name, parent, template)
  local f = obj(kind)
  f.parent = parent
  f.shown = kind ~= "Frame" or name == nil
  frames[#frames + 1] = f
  if name then _G[name] = f end
  return f
end
UIParent = obj("UIParent")
GameTooltip = obj("GameTooltip")
ProfessionsFrame = obj("ProfessionsFrame")
function UnitFactionGroup() return BAVVB_FACTION or "Alliance" end
C_Timer = { After = function(_, fn) fn() end }
C_TradeSkillUI = { GetBaseProfessionInfo = function() return { professionName = BAVVB_PROF } end }
date = os.date
function BAVVB_EVENT(event, ...) for _, f in ipairs(frames) do if f.scripts.OnEvent then f.scripts.OnEvent(f, event, ...) end end end
function BAVVB_TEXT()
  local out = {}
  local function plain(s) return ((s or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")) end
  out[1] = plain(BavvbScanFavPanel.title.text) .. "  |  " .. plain(BavvbScanFavPanel.sub.text)
  for _, f in ipairs(frames) do
    if f.spec and f.shown then out[#out + 1] = plain(f.left.text) .. "  [" .. plain(f.mid.text) .. "]  " .. (f.each.text ~= "" and plain(f.each.text) .. " | " or "") .. plain(f.right.text) end
  end
  return out
end
function BAVVB_CLICK_ALL()
  local list = {}
  for _, f in ipairs(frames) do if f.spec and f.shown and f.spec.onClick and not f.spec.group then list[#list + 1] = f.spec.onClick end end
  for _, fn in ipairs(list) do fn() end
end
`

describe('FavPanel.lua runs', () => {
  const edits: Edits = { ...emptyEdits(), deTable: [band], favorites: { groups: [{ id: 'g', name: 'A', recipes: [10, 12] }, { id: 'h', name: 'B', recipes: [13] }] } }
  const result = compute(game, config, edits, null)
  const favLua = exportLua(buildExport(game, result, edits, [band]), 1795480000)

  it('docks beside the profession window with that profession only, breakdowns open, /bscan fav shows all', () => {
    const out = runLua([WOW_STUBS, CORE, favLua, scanLua, apiLua, 'BavvbScanDB.favFolded = nil', PANEL], `
      BAVVB_PROF = "Tailoring"
      BAVVB_EVENT("ADDON_LOADED", "Blizzard_Professions")
      BAVVB_EVENT("TRADE_SKILL_SHOW")
      local docked = BAVVB_TEXT()
      BAVVB_CLICK_ALL()
      local open = BAVVB_TEXT()
      BavvbScanFavToggle()
      local alone = BAVVB_TEXT()
      BAVVB_EVENT("TRADE_SKILL_CLOSE")
      BAVVB_PROF = "Cooking"
      BAVVB_EVENT("TRADE_SKILL_SHOW")
      return { docked = docked, open = open, alone = alone, cookingShown = BavvbScanFavPanel:IsShown() }`)
    expect(out.docked[0]).toMatch(/^Favorites · Tailoring {2}\| {2}scan \d{1,2}:\d\d [AP]M {2}· {2}hourly \d{1,2}:\d\d [AP]M {2}· {2}favorites sent \w+ \d+ \d{1,2}:\d\d [AP]M$/)
    expect(out.docked.slice(1)).toEqual(['- A  []  ', 'Bag  [AH]  +1g 83s', 'Robe  [Vendor]  -4s 85c'])
    expect(out.open.length).toBeGreaterThan(10)
    expect(out.open.join('\n')).not.toContain('buy instead')
    expect(out.open.some((l: string) => / \| /.test(l))).toBe(true) // price each
    expect(out.alone.some((l: string) => l.startsWith('Potion'))).toBe(true)
    expect(out.cookingShown).toBe(true) // /bscan fav stays open on its own; a profession without favorites doesn't dock
    if (process.env.BAVVB_PRINT) console.log(out.open.join('\n'))
  })

  it('shopping list: Add with a typed count, Show, change a count, Make list in Auctionator, Clear', () => {
    const out = runLua([WOW_STUBS, CORE, favLua, scanLua, apiLua, 'BavvbScanDB.favFolded = nil', PANEL], `
      local made = {}
      Auctionator = { API = { v1 = { CreateShoppingList = function(caller, name, terms) made[#made + 1] = { caller = caller, name = name, terms = terms } end } } }
      local printed = {}
      print = function(s) printed[#printed + 1] = s end
      C_Timer.After = function(d, fn) if d == 0 then fn() end end -- the 3 s / 5 s "again" resets must not fire at once
      BavvbScanFavToggle()
      BAVVB_CLICK_ALL()
      local function line(key) for _, f in ipairs(BAVVB_FRAMES) do if f.spec and f.shown and f.spec.key == key then return f end end end
      local bag = line("add:10")
      bag.box.text = "3"; bag.box.HasFocus = function() return true end -- typed, not yet left the box
      bag.spec.btn.onClick(bag)
      bag.box.HasFocus = function() return false end
      line("add:13").spec.btn.onClick(line("add:13"))
      line("add:10").spec.btn.onClick(line("add:10")) -- again: adds 1 more
      local barFav = BavvbScanFavPanel.bar.text.text
      BavvbScanFavPanel.bar.b2.onClick() -- Show
      local shown = BAVVB_TEXT()
      line("count:10").spec.onClick() -- the Bag: Disenchant -> AH
      local afterClick = BAVVB_TEXT()
      line("count:13").spec.box.set(2)
      BavvbScanFavRefresh()
      BavvbScanFavPanel.bar.b1.onClick() -- Make list: held back while a recipe is under the margin
      local held = { count = #made, text = BAVVB_TEXT()[1] }
      BavvbScanFavPanel.bar.b1.onClick() -- again: goes ahead
      local after = BAVVB_TEXT()
      BavvbScanFavPanel.bar.b2.onClick(); BavvbScanFavPanel.bar.b2.onClick() -- Clear, Sure?
      return { afterClick = afterClick, held = held, saved = BavvbScanDB.shop, made = made, printed = printed, barFav = barFav, shown = shown, after = after, cleared = #BavvbScanDB.shop.recipes }`)
    expect(out.barFav).toContain('2 recipes')
    expect(out.printed[0]).toContain('added 3 x Bag')
    expect(out.printed[2]).toContain('(now 4)')
    expect(out.made).toHaveLength(1)
    expect(out.made[0]).toMatchObject({ caller: 'BavvbScan', name: 'BavvbScan' })
    // the app priced as the panel is (the scan is newer than the API here)
    const scan = readBavvbScan(new TextEncoder().encode(scanLua))
    const priced = compute(game, config, { ...edits, imports: scan.result.rows, importsInfo: { source: 'BavvbScan', at: new Date().toISOString(), count: 1, dataAt: new Date(scan.scanTime * 1000).toISOString() } },
      apiFromLua(apiLua, 'Alliance'))
    const appLines = shopLines(game, priced, { recipes: [{ id: 10, count: 4 }, { id: 13, count: 2 }], ticks: {}, listName: null })
    // the same items and quantities as the app's list; max prices (field 10) are checked in the checkList tests
    const noCap = (t: string) => t.split(';').map((x, i) => (i === 9 ? '' : x)).join(';')
    expect(['BavvbScan', ...out.made[0].terms.map(noCap)].join('^')).toBe(auctionatorImport('BavvbScan', appLines))
    expect(out.held.count).toBe(0)
    expect(out.saved.exits['10']).toBe('AH')
    expect(out.afterClick.some((l: string) => l.startsWith('Bag  AH'))).toBe(true)
    expect(out.held.text).toContain('under the margin')
    expect(out.after[0]).toContain('Made "BavvbScan" in Auctionator')
    expect(out.shown.join('\n')).toContain('From a vendor')
    expect(out.cleared).toBe(0)
    if (process.env.BAVVB_PRINT) console.log(out.shown.join('\n'), '\n---\n', out.after.join('\n'), out.made[0].terms)
  })
})

// ---------- the shopping list's profit check and price caps (FavCore.checkList) ----------
describe('FavCore.checkList: margin per craft and max prices', () => {
  const base: Edits = { ...emptyEdits(), deTable: [band], favorites: { groups: [{ id: 'g', name: 'A', recipes: [10, 12, 13] }] }, settings: { importColumn: 2 } }
  const scan = readBavvbScan(new TextEncoder().encode(scanLua))
  const edits: Edits = { ...base, imports: scan.result.rows, importsInfo: { source: 'BavvbScan', at: new Date().toISOString(), count: 1, dataAt: new Date(scan.scanTime * 1000).toISOString() } }
  const result = compute(game, config, edits, apiFromLua(apiLua, 'Alliance'))
  const favLua = exportLua(buildExport(game, result, edits, [band]), 0)
  const entries = [{ id: 10, count: 2 }, { id: 12, count: 1 }, { id: 13, count: 5 }]

  /** The rule written out again from the app's own prices: factor = (exit value - margin - vendor reagents) / AH reagents. */
  function expected(margin: number) {
    const chained = new Set<number>()
    for (const e of entries) for (const g of game.recipes.find((r) => r.id === e.id)!.reagents) chained.add(g.item)
    const recipes: Record<string, unknown> = {}
    const caps: Record<string, number> = {}
    for (const e of entries) {
      const row = result.recipes.find((r) => r.recipe.id === e.id)!
      const value = row.deBand ? row.deValue : row.bestValue
      const profit = row.deBand ? row.profitDE : row.profitBest
      const qty = new Map<number, number>()
      for (const g of row.recipe.reagents) {
        const inter = result.intermediates.get(g.item)
        if (inter && inter.source === 'Craft' && chained.has(g.item)) {
          for (const s of inter.recipe.reagents) qty.set(s.item, (qty.get(s.item) ?? 0) + (g.qty * s.qty) / inter.qtyMade)
        } else qty.set(g.item, (qty.get(g.item) ?? 0) + g.qty)
      }
      let fixed = 0, ah = 0, priced = value !== null
      for (const [id, q] of qty) {
        const p = result.prices(id)
        if (p.reagent === null) priced = false
        else if (p.vendorBuy !== null) fixed += q * p.reagent
        else ah += q * p.reagent
      }
      const factor = priced && ah > 0 ? (value! - margin - fixed) / ah : null
      const flagged = profit === null || profit < margin
      if (factor !== null && factor > 0 && !flagged) {
        for (const [id] of qty) {
          const p = result.prices(id)
          if (p.vendorBuy !== null) continue
          const cap = Math.floor(p.reagent! * factor)
          if (cap >= 1 && (caps[id] === undefined || cap < caps[id])) caps[id] = cap
        }
      }
      recipes[e.id] = { value, profit, flagged, factor }
    }
    return { recipes, caps }
  }

  for (const margin of [0, 100, 1000]) {
    it(`margin ${margin}c`, () => {
      const got = runLua([CORE, favLua, scanLua, apiLua], `
        local res = BavvbScanFavCore.compute(BavvbScanFavorites, BavvbScanDB.scan, BavvbScanApi, "Alliance")
        return BavvbScanFavCore.checkList(BavvbScanFavorites, res.book.price, res.inter, ${toLuaEntries(entries)}, ${margin})`)
      const want = expected(margin)
      for (const [id, w] of Object.entries(want.recipes) as [string, any][]) {
        const g = got.recipes[id]
        same(g.value, w.value, `${id} value`)
        same(g.profit, w.profit, `${id} profit`)
        same(g.flagged, w.flagged, `${id} flagged`)
        same(g.factor, w.factor, `${id} factor`)
      }
      expect(got.caps).toEqual(want.caps)
      if (process.env.BAVVB_PRINT) console.log(margin, JSON.stringify(got))
    })
  }

  it('a capped search term puts the max price in gold in field 10', () => {
    const got = runLua([CORE], `return { BavvbScanFavCore.searchTermCapped("Rugged Leather", 40, 3250), BavvbScanFavCore.searchTermCapped("Cloth", 5, 12345), BavvbScanFavCore.searchTermCapped("X", 1, nil) }`)
    expect(got).toEqual(['"Rugged Leather";;;;;;;;;0.325;;#;;40', '"Cloth";;;;;;;;;1.2345;;#;;5', '"X";;;;;;;;;;;#;;1'])
    expect(got[0].split(';')[9]).toBe('0.325')
  })
})

describe('FavCore.checkList: the exit picked per recipe', () => {
  const base: Edits = { ...emptyEdits(), deTable: [band], favorites: { groups: [{ id: 'g', name: 'A', recipes: [10, 12, 13] }] }, settings: { importColumn: 2 } }
  const scan = readBavvbScan(new TextEncoder().encode(scanLua))
  const edits: Edits = { ...base, imports: scan.result.rows, importsInfo: { source: 'BavvbScan', at: new Date().toISOString(), count: 1, dataAt: new Date(scan.scanTime * 1000).toISOString() } }
  const result = compute(game, config, edits, apiFromLua(apiLua, 'Alliance'))
  const favLua = exportLua(buildExport(game, result, edits, [band]), 0)
  const row = (id: number) => result.recipes.find((r) => r.recipe.id === id)!

  it('AH for the Bag; AH for the Robe (binds on pickup) falls back to Disenchant; none picked = Disenchant, else best', () => {
    const got = runLua([CORE, favLua, scanLua, apiLua], `
      local res = BavvbScanFavCore.compute(BavvbScanFavorites, BavvbScanDB.scan, BavvbScanApi, "Alliance")
      local entries = { { id = 10, count = 1 }, { id = 12, count = 1 }, { id = 13, count = 1 } }
      local picked = BavvbScanFavCore.checkList(BavvbScanFavorites, res.book.price, res.inter, entries, 1000, { [10] = "AH", [12] = "AH" })
      local plain = BavvbScanFavCore.checkList(BavvbScanFavorites, res.book.price, res.inter, entries, 1000, nil)
      return { picked = picked.recipes, plain = plain.recipes }`)
    expect(got.picked['10']).toMatchObject({ exit: 'AH', exits: ['Vendor', 'Disenchant', 'AH'] })
    same(got.picked['10'].value, row(10).ahValue, 'Bag AH value')
    same(got.picked['10'].profit, row(10).profitAH, 'Bag AH profit')
    expect(got.picked['12']).toMatchObject({ exit: 'Disenchant', exits: ['Vendor', 'Disenchant'] })
    same(got.picked['12'].profit, row(12).profitDE, 'Robe DE profit')
    expect(got.plain['10'].exit).toBe('Disenchant')
    expect(got.plain['13'].exit).toBe(row(13).bestExitName)
  })
})
