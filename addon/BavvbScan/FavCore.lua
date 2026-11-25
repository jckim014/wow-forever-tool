-- BavvbScan favorites: the price math behind the in-game favorites panel (FavPanel.lua). Pure Lua (no WoW API), so the
-- shuffle app's tests run it next to the app's own model (app/src/ingame/parity.test.ts) and require the same numbers.
--
-- Inputs:
--   BavvbScanFavorites  (Favorites.lua, written by the shuffle app: favorites, recipes, settings already applied)
--   BavvbScanDB.scan    (this character's latest /bscan, live in memory from the moment it is saved)
--   BavvbScanApi        (ApiPrices.lua, written by the hourly PC sync: newest API prices per faction)
-- The rules are the shuffle app's (CLAUDE.md, Model): reagent price = custom, else vendor buy price (only exported when
-- that setting is on; older files only carry it then), else imported; selling price = custom, else imported; imported = the scan or the hourly API
-- price, the newer of the two winning per item where both have it (a tie goes to the scan). Money in copper; nil =
-- unpriced, never zero.

local C = {}
BavvbScanFavCore = C

C.CHEAPEST_SHARE = 0.15
C.ANCHOR_SHARE = 0.05
C.WALL_CUTOFF = 5

-- Python's round(): half to even (as the app's roundHalfEven).
local function rhe(x)
  local r = math.floor(x + 0.5)
  if math.abs(x % 1) == 0.5 and r % 2 ~= 0 then r = r - 1 end
  return r
end
C.roundHalfEven = rhe

-- "count:stackBuyout,..." -> p1 lowest, p2 unit-weighted median, p3 average of the cheapest 15% of units after the
-- wall cutoff (the app's pricesFromUnits). nil when the string has no listing with a buyout.
function C.summarize(s)
  local xs, units = {}, 0
  for count, buyout in string.gmatch(s, "(%d+):(%d+)") do
    count, buyout = tonumber(count), tonumber(buyout)
    if count > 0 and buyout > 0 then
      xs[#xs + 1] = { buyout / count, count }
      units = units + count
    end
  end
  if #xs == 0 then return nil end
  table.sort(xs, function(a, b) return a[1] < b[1] end)
  local acc, med = 0, xs[#xs][1]
  for _, x in ipairs(xs) do
    acc = acc + x[2]
    if acc >= units / 2 then med = x[1]; break end
  end
  local atShare = math.max(1, C.ANCHOR_SHARE * units)
  acc = 0
  local anchor = xs[#xs][1]
  for _, x in ipairs(xs) do
    acc = acc + x[2]
    if acc >= atShare then anchor = x[1]; break end
  end
  local keptUnits = 0
  for _, x in ipairs(xs) do if x[1] <= C.WALL_CUTOFF * anchor then keptUnits = keptUnits + x[2] end end
  local need = math.max(1, C.CHEAPEST_SHARE * keptUnits)
  local took, sum = 0, 0
  for _, x in ipairs(xs) do
    if x[1] <= C.WALL_CUTOFF * anchor then
      local take = math.min(x[2], need - took)
      sum = sum + x[1] * take
      took = took + take
      if took >= need then break end
    end
  end
  return rhe(xs[1][1]), rhe(med), rhe(sum / took)
end

local function column(a, b, c, col)
  local v = col == 1 and a or col == 2 and b or c
  if v == nil or v == 0 then return nil end
  return v
end

-- A price lookup for one character: price(id) -> { reagent, reagentSource, selling, sellingSource, imported,
-- importedSource } with sources "custom" / "vendor" / "scan" / "api". Plus book.scanTime / book.apiTime (Unix s or nil).
function C.priceBook(fav, scan, api, faction)
  local s = fav.settings
  local scanItems = s.useImports and scan and scan.faction == faction and scan.items or nil
  local apiF = s.useApi and api and api[faction] or nil
  local scanTime = scanItems and scan.time or nil
  local apiNewer = apiF ~= nil and (scanTime == nil or apiF.t > scanTime)
  local cache = {}

  local function fromScan(id)
    local str = scanItems and scanItems[id]
    if not str then return nil end
    local a, b, c = C.summarize(str)
    if not a then return nil end
    return column(a, b, c, s.column)
  end
  local function fromApi(id)
    local str = apiF and apiF.items[id]
    if not str then return nil end
    local a, b, c = string.match(str, "^(%d*):(%d*):(%d*)$")
    return column(tonumber(a), tonumber(b), tonumber(c), s.column)
  end

  local function price(id)
    local p = cache[id]
    if p then return p end
    local it = fav.items[id] or {}
    local imp, impSrc
    local sv, av = fromScan(id), fromApi(id)
    if av and (apiNewer or not sv) then imp, impSrc = av, "api" elseif sv then imp, impSrc = sv, "scan" end
    p = { imported = imp, importedSource = impSrc }
    if it.typed then p.reagent, p.reagentSource = it.typed, "custom"
    elseif it.vendor and s.useVendorBuy ~= false then p.reagent, p.reagentSource = it.vendor, "vendor"
    elseif imp then p.reagent, p.reagentSource = imp, impSrc end
    if it.typed then p.selling, p.sellingSource = it.typed, "custom"
    elseif imp then p.selling, p.sellingSource = imp, impSrc end
    cache[id] = p
    return p
  end

  return { price = price, scanTime = scanTime, apiTime = apiF and apiF.t or nil, faction = faction }
end

local function has(list, v)
  for _, x in ipairs(list) do if x == v then return true end end
  return false
end

-- Every craftable reagent's buy / craft / best cost and source ("Craft" / "Buy"), as the app's intermediates.
function C.intermediates(fav, price)
  local out = {}
  local function resolve(id)
    local r = out[id]
    if r then return r.best end
    local row = fav.inter[id]
    local rec = fav.recipes[row.recipe]
    local buy = price(id).reagent
    local craft
    if row.craft then
      local sum, priced = 0, true
      for j, g in ipairs(rec.reagents) do
        local unit
        if fav.inter[g[1]] and not has(row.breaks, j) then unit = resolve(g[1]) else unit = price(g[1]).reagent end
        if unit == nil then priced = false else sum = sum + g[2] * unit end
      end
      if priced then craft = sum / rec.made end
    end
    local best
    if craft == nil then best = buy elseif buy == nil then best = craft else best = math.min(buy, craft) end
    local source
    if best ~= nil then source = (craft ~= nil and (buy == nil or craft < buy)) and "Craft" or "Buy" end
    out[id] = { buy = buy, craft = craft, best = best, source = source }
    return best
  end
  for id in pairs(fav.inter) do resolve(id) end
  return out
end

-- What one unit would cost to craft, ignoring Allow crafting (display only; the app's potentialCraft).
local function potentialCraft(fav, inter, price, id)
  local row = fav.inter[id]
  local rec = fav.recipes[row.recipe]
  local sum = 0
  for j, g in ipairs(rec.reagents) do
    local unit
    if inter[g[1]] and not has(row.breaks, j) then unit = inter[g[1]].best else unit = price(g[1]).reagent end
    if unit == nil then return nil end
    sum = sum + g[2] * unit
  end
  return sum / rec.made
end

local function sub(a, b) if a == nil or b == nil then return nil end return a - b end

-- One favorite recipe: costs, the three exits and the best one (the app's computeRecipe), plus the cost breakdown
-- (the app's recipeDetail lines). `inter` from C.intermediates.
function C.recipe(fav, price, inter, rid)
  local r = fav.recipes[rid]
  local item = fav.items[r.product] or {}
  local q = r.made
  local cut = 1 - fav.settings.ahCut
  local row = { id = rid, name = r.name, profession = r.profession, product = r.product, made = q }

  row.vendorValue = item.sell and rhe(item.sell * q) or nil

  local buyAll, cheapest = 0, 0
  local lines = {}
  for _, g in ipairs(r.reagents) do
    local id, qty = g[1], g[2]
    local own = price(id)
    local maker = fav.inter[id]
    local used = r.chains and maker and inter[id] or nil
    local unit
    if used then unit = used.best else unit = own.reagent end
    if own.reagent == nil or buyAll == nil then buyAll = nil else buyAll = buyAll + qty * own.reagent end
    if unit == nil or cheapest == nil then cheapest = nil else cheapest = cheapest + qty * unit end
    local crafted = used ~= nil and used.source == "Craft"
    local line = { item = id, name = (fav.items[id] or {}).name, qty = qty, unit = unit, total = unit and qty * unit or nil,
      source = crafted and "craft" or own.reagentSource, buyUnit = own.reagent, buySource = own.reagentSource }
    if maker then
      local mrec = fav.recipes[maker.recipe]
      local each = potentialCraft(fav, inter, price, id)
      line.craft = { recipe = mrec.name, profession = mrec.profession, made = mrec.made, used = crafted,
        cost = each and qty * each or nil,
        off = (not r.chains) and "recipe" or (not maker.craft) and "item" or nil, lines = {} }
      for j, s in ipairs(mrec.reagents) do
        local subRow = (not has(maker.breaks, j)) and inter[s[1]] or nil
        local subUnit
        if subRow then subUnit = subRow.best else subUnit = price(s[1]).reagent end
        local sq = qty * s[2] / mrec.made
        line.craft.lines[#line.craft.lines + 1] = { item = s[1], name = (fav.items[s[1]] or {}).name, qty = sq, unit = subUnit,
          total = subUnit and sq * subUnit or nil,
          source = (subRow and subRow.source == "Craft") and "craft" or price(s[1]).reagentSource }
      end
    end
    lines[#lines + 1] = line
  end
  row.buyAll, row.cheapest, row.lines = buyAll, cheapest, lines

  -- disenchant
  local band = item.de and fav.bands[item.de] or nil
  if band then
    local withChance, priced, value = 0, 0, 0
    local mats = {}
    for _, m in ipairs(band.results) do
      local w = (m[2] or 0) * (m[3] or 0)
      local p = m[1] ~= 0 and price(m[1]) or nil
      local sp = p and p.selling or nil
      if w > 0 then
        withChance = withChance + 1
        if sp then priced = priced + 1 end
      end
      value = value + w * (sp or 0)
      mats[#mats + 1] = { item = m[1], name = (fav.items[m[1]] or {}).name, chance = m[2], avg = m[3], price = sp, source = p and p.sellingSource }
    end
    if priced < withChance then value = nil end
    row.deBand = band.band
    row.deMaterials = mats
    row.deValue = value and value * q * fav.settings.deMult * cut or nil
  end

  -- auction house (0 = unpriced); a product that binds on pickup can't be listed
  local pp = price(r.product)
  local ahPrice = pp.selling
  if ahPrice == 0 then ahPrice = nil end
  row.ahPrice, row.ahSource = ahPrice, ahPrice and pp.sellingSource or nil
  row.ahApplies = item.bind ~= "pickup"
  row.ahValue = (ahPrice and row.ahApplies) and ahPrice * q * cut or nil

  -- best exit: highest priced value; ties go to the earlier exit (Vendor, Disenchant, AH)
  local exits = {}
  if row.vendorValue then exits[#exits + 1] = { name = "Vendor", value = row.vendorValue } end
  if band then exits[#exits + 1] = { name = "Disenchant", value = row.deValue } end
  if row.ahApplies then exits[#exits + 1] = { name = "AH", value = row.ahValue } end
  local best
  row.unpriced = {}
  for _, e in ipairs(exits) do
    e.profit = sub(e.value, cheapest)
    if e.value ~= nil and (best == nil or e.value > best.value) then best = e end
    if e.name ~= "Vendor" and e.value == nil then row.unpriced[#row.unpriced + 1] = e.name == "Disenchant" and "DE" or e.name end
  end
  if best then best.isBest = true end
  row.exits = exits
  row.bestExitName = best and best.name or nil
  row.bestValue = best and best.value or nil
  row.profitBest = sub(row.bestValue, cheapest)
  return row
end

-- Every favorite, in the app's groups and order. `profession` (optional) keeps only that profession's recipes;
-- groups left empty are dropped. Returns { groups = { { name, rows } }, book }.
function C.compute(fav, scan, api, faction, profession)
  local book = C.priceBook(fav, scan, api, faction)
  local inter = C.intermediates(fav, book.price)
  local groups = {}
  for _, g in ipairs(fav.groups) do
    local rows = {}
    for _, rid in ipairs(g.recipes) do
      local r = fav.recipes[rid]
      if r and (not profession or r.profession == profession) then rows[#rows + 1] = C.recipe(fav, book.price, inter, rid) end
    end
    if #rows > 0 then groups[#groups + 1] = { name = g.name, rows = rows } end
  end
  return { groups = groups, book = book, inter = inter }
end

-- ---------- shopping list ----------

-- Auctionator's own separators; a name containing them would break the list.
local function clean(s)
  s = s:gsub('[%^;"\r\n]', " ")
  s = s:gsub("^%s+", ""):gsub("%s+$", "")
  return s
end

-- One Auctionator search term (Source/Search/Advanced.lua; the app's auctionatorImport): exact name in quotes, 14
-- fields split by ";", tier "#" (none), quantity last.
function C.searchTerm(name, qty)
  return '"' .. clean(name) .. '";;;;;;;;;;;#;;' .. string.format("%d", qty)
end

-- What to buy for `entries` ({ {id = recipe ID, count = crafts}, ... }), the app's Shopping view with its default
-- ticks (shopLines + auctionatorImport): reagents merged by item; a reagent the cheapest path crafts (source Craft, and
-- some chosen recipe has Use chains on) is replaced by its maker's ingredients for ceil(needed / made) crafts (one
-- level, as the app); anything a vendor sells is left off and listed apart. Returns { buy = { {item, name, qty} },
-- vendor = { ... }, unknown = { recipe IDs not in Favorites.lua } }, in the app's order.
function C.shopping(fav, inter, entries)
  local need, order, chained, unknown = {}, {}, {}, {}
  for _, e in ipairs(entries) do
    local r = fav.recipes[e.id]
    if not r then unknown[#unknown + 1] = e.id
    elseif (e.count or 0) > 0 then
      for _, g in ipairs(r.reagents) do
        if not need[g[1]] then need[g[1]] = 0; order[#order + 1] = g[1] end
        need[g[1]] = need[g[1]] + g[2] * e.count
        if r.chains then chained[g[1]] = true end
      end
    end
  end
  local buy, vendor, at = {}, {}, {}
  local function add(id, qty)
    local it = fav.items[id] or {}
    local list = it.vendor and vendor or buy
    local key = (it.vendor and "v" or "b") .. id
    if at[key] then at[key].qty = at[key].qty + qty
    else at[key] = { item = id, name = it.name or ("Item " .. id), qty = qty }; list[#list + 1] = at[key] end
  end
  for _, id in ipairs(order) do
    local row, maker = inter[id], fav.inter[id]
    if maker and row and row.source == "Craft" and chained[id] then
      local mrec = fav.recipes[maker.recipe]
      local crafts = math.ceil(need[id] / mrec.made)
      for _, s in ipairs(mrec.reagents) do add(s[1], crafts * s[2]) end
    else
      add(id, need[id])
    end
  end
  return { buy = buy, vendor = vendor, unknown = unknown }
end

-- ---------- profit check and price caps for the shopping list ----------

C.DEFAULT_MARGIN = 1000 -- 10s per craft (Josh, 2026-11-24)

-- For each recipe on the list: the exit it is judged on (`exits[id]`, the one Josh picked, when it applies to that
-- recipe; else Disenchant when the product can be disenchanted, else the best exit), the exits it can switch to, its value and profit per craft (the model's, as the panel's rows), and flagged = profit unknown or
-- under `margin`. Caps: the highest price per unit for each item on the list such that, paying the cap for every
-- AH-bought item, each recipe still makes `margin` per craft:
--   factor = (exit value - margin - off-list reagents) / AH reagents at today's prices, cap = price x factor
-- with the reagents taken as the list buys them (the same crafted-reagent choice as C.shopping, per one craft,
-- unrounded) at their reagent prices; vendor items are off the list and count at their price. An item used by several
-- recipes gets the lowest cap. A recipe under the margin (flagged) or with an unpriced reagent sets no caps.
-- Returns { recipes = { [id] = { name, exit, exits, value, profit, flagged, factor } }, caps = { [item] = copper } }.
function C.checkList(fav, price, inter, entries, margin, exits)
  margin = margin or C.DEFAULT_MARGIN
  local chained = {}
  for _, e in ipairs(entries) do
    local r = fav.recipes[e.id]
    if r and r.chains and (e.count or 0) > 0 then for _, g in ipairs(r.reagents) do chained[g[1]] = true end end
  end
  local out, caps = {}, {}
  for _, e in ipairs(entries) do
    local r = fav.recipes[e.id]
    if r and not out[e.id] then
      local row = C.recipe(fav, price, inter, e.id)
      local exit, names = nil, {}
      local want = exits and exits[e.id]
      for _, x in ipairs(row.exits) do
        names[#names + 1] = x.name
        if x.name == want then exit = x end
      end
      if not exit then for _, x in ipairs(row.exits) do if x.name == "Disenchant" then exit = x end end end
      if not exit then for _, x in ipairs(row.exits) do if x.isBest then exit = x end end end
      local info = { name = r.name, exit = exit and exit.name, exits = names, value = exit and exit.value, profit = exit and exit.profit }
      info.flagged = info.profit == nil or info.profit < margin
      -- what one craft buys, as the list buys it
      local qty, order = {}, {}
      local function add(id, q)
        if not qty[id] then qty[id] = 0; order[#order + 1] = id end
        qty[id] = qty[id] + q
      end
      for _, g in ipairs(r.reagents) do
        local maker, irow = fav.inter[g[1]], inter[g[1]]
        if maker and irow and irow.source == "Craft" and chained[g[1]] then
          local mrec = fav.recipes[maker.recipe]
          for _, s in ipairs(mrec.reagents) do add(s[1], g[2] * s[2] / mrec.made) end
        else add(g[1], g[2]) end
      end
      local fixed, ah, priced = 0, 0, info.value ~= nil
      for _, id in ipairs(order) do
        local p = price(id).reagent
        if p == nil then priced = false
        elseif (fav.items[id] or {}).vendor then fixed = fixed + qty[id] * p
        else ah = ah + qty[id] * p end
      end
      if priced and ah > 0 then
        local f = (info.value - margin - fixed) / ah
        info.factor = f
        if f > 0 and not info.flagged then -- a recipe already under the margin sets no caps (it is flagged instead)
          for _, id in ipairs(order) do
            if not (fav.items[id] or {}).vendor then
              local cap = math.floor(price(id).reagent * f)
              if cap >= 1 and (caps[id] == nil or cap < caps[id]) then caps[id] = cap end
            end
          end
        end
      end
      out[e.id] = info
    end
  end
  return { recipes = out, caps = caps }
end

-- A search term with a maximum price (copper; Auctionator takes it in gold, field 10).
function C.searchTermCapped(name, qty, cap)
  if not cap then return C.searchTerm(name, qty) end
  local g = string.format("%.4f", cap / 10000):gsub("0+$", ""):gsub("%.$", "")
  return '"' .. clean(name) .. '";;;;;;;;;' .. g .. ';;#;;' .. string.format("%d", qty)
end
