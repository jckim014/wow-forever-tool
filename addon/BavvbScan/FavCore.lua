-- BavvbScan favorites: the price math behind the in-game favorites panel (FavPanel.lua). Pure Lua (no WoW API), so the
-- shuffle app's tests run it next to the app's own model (app/src/ingame/parity.test.ts) and require the same numbers.
--
-- Inputs:
--   BavvbScanFavorites  (Favorites.lua, written by the shuffle app: favorites, recipes, settings already applied)
--   BavvbScanDB.scan    (this character's latest /bscan, live in memory from the moment it is saved)
--   BavvbScanApi        (ApiPrices.lua, written by the hourly PC sync: newest API prices per faction)
-- The rules are the shuffle app's (CLAUDE.md, Model): reagent price = custom, else vendor buy price (only exported when
-- that setting is on), else imported; selling price = custom, else imported; imported = the scan or the hourly API
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
    elseif it.vendor then p.reagent, p.reagentSource = it.vendor, "vendor"
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
