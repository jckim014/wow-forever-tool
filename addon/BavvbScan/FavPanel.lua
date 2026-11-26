-- BavvbScan favorites panel: the shuffle app's Favorites (cost, best exit, profit, and a cost breakdown per recipe)
-- worked out in game from this character's latest /bscan, with the hourly API prices filling gaps (FavCore.lua).
-- Opens by itself to the right of the profession window when that profession has favorites, and with /bsf
-- (all professions, movable). It only shows numbers, plus a shopping list: Add in a recipe's breakdown puts it on the
-- list with a number of crafts, Show lists what to buy, and Make list creates that list in Auctionator through
-- Auctionator's own API (Auctionator.API.v1.CreateShoppingList; it only writes the list, nothing at the auction house).
-- The list is kept in BavvbScanDB.shop = { name, recipes = { {id, count} } }.

local Core = BavvbScanFavCore
local W, ROW, PAD, SIZE = 460, 19, 10, 13 -- SIZE: font size of the lines
local panel, content, scroll
local pool = {}
local open = {}        -- recipe ID -> breakdown shown
local mode             -- "profession" (docked) or "alone" (/bsf)
local profession       -- the profession window's profession, when docked
local closedFor        -- the profession the close button hid it for (until that window opens again)
local view = "fav"     -- "fav" (favorites) or "shop" (the shopping list)
local addQty = {}      -- recipe ID -> crafts typed in its Add box (this session)
local note             -- last shopping-list message, shown under the title in the list view
local clearArmed       -- Clear was clicked once; a second click within 3 s clears
local makeArmed        -- Make list was held back for recipes under the margin; a second click within 5 s goes ahead
local DEFAULT_LIST = "BavvbScan"
local MAX_COUNT = 9999

local GOLD, GREY, GREEN, RED, WHITE = "ffd100", "8c8c8c", "40ff40", "ff5050", "ffffff"
local function color(hex, s) return "|cff" .. hex .. s .. "|r" end

-- 123456 -> "12g 34s" (copper dropped once there is gold), 3456 -> "34s 56c", nil -> grey dash
local function money(c)
  if c == nil then return color(GREY, "-") end
  local neg = c < 0
  c = math.floor(math.abs(c) + 0.5)
  local g, s, k = math.floor(c / 10000), math.floor(c / 100) % 100, c % 100
  local out
  if g > 0 then out = g .. color("ffd700", "g") .. " " .. string.format("%02d", s) .. color("c7c7cf", "s")
  elseif s > 0 then out = s .. color("c7c7cf", "s") .. " " .. string.format("%02d", k) .. color("eda55f", "c")
  else out = k .. color("eda55f", "c") end
  return (neg and "-" or "") .. out
end
local function profitText(c)
  if c == nil then return color(GREY, "-") end
  return color(c >= 0 and GREEN or RED, (c >= 0 and "+" or "")) .. money(c)
end
local function qtyText(q)
  if q == math.floor(q) then return string.format("%d", q) end
  return string.format("%.1f", q)
end
-- 6:48 PM
local function clock(t)
  if not t then return nil end
  return (date("%I:%M %p", t):gsub("^0", ""))
end

local function exitShort(name) return name == "Disenchant" and "DE" or name end

local SOURCE = { custom = "custom", vendor = "vendor", craft = "craft", scan = "", api = "" }

-- A price with its source: the hourly fallback gets a small grey degree sign.
local function priced(c, source)
  return money(c) .. (source == "api" and color(GREY, "°") or "")
end

local function apiTip(book)
  local t = clock(book.apiTime)
  if book.scanTime and book.apiTime and book.apiTime > book.scanTime then
    return "° Hourly API price (" .. (t or "?") .. "): newer than your /bscan (" .. clock(book.scanTime) .. ")."
  end
  return "° Hourly API price (" .. (t or "?") .. "): not in your /bscan" .. (book.scanTime and "" or " (no scan on this faction yet)") .. "."
end

-- ---------- frame ----------

local function makeLine(i)
  local b = CreateFrame("Button", nil, content)
  b:SetHeight(ROW)
  local function fs(justify)
    local f = b:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
    f:SetFont(STANDARD_TEXT_FONT, SIZE, "")
    f:SetJustifyH(justify)
    f:SetWordWrap(false)
    return f
  end
  -- columns: name | source (or best exit) | price each | total (or profit)
  b.left, b.mid, b.each, b.right = fs("LEFT"), fs("LEFT"), fs("RIGHT"), fs("RIGHT")
  b.right:SetPoint("RIGHT", b, "RIGHT", -4, 0)
  b.each:SetPoint("RIGHT", b, "RIGHT", -96, 0)
  b.each:SetWidth(86)
  b.mid:SetPoint("RIGHT", b, "RIGHT", -188, 0)
  b.mid:SetWidth(56)
  b.hl = b:CreateTexture(nil, "BACKGROUND")
  b.hl:SetAllPoints()
  b.hl:SetColorTexture(1, 1, 1, 0.08)
  b.hl:Hide()
  b:SetScript("OnEnter", function(self)
    if self.spec and (self.spec.onClick or self.spec.tip) then self.hl:Show() end
    if self.spec and self.spec.tip then
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      for n, line in ipairs(self.spec.tip) do
        if n == 1 then GameTooltip:SetText(line) else GameTooltip:AddLine(line, 0.9, 0.9, 0.9, true) end
      end
      GameTooltip:Show()
    end
  end)
  b:SetScript("OnLeave", function(self)
    self.hl:Hide()
    GameTooltip:Hide()
  end)
  b:SetScript("OnClick", function(self)
    if self.spec and self.spec.onClick then self.spec.onClick() end
  end)
  pool[i] = b
  return b
end

local function makePanel()
  if panel then return panel end
  local p = CreateFrame("Frame", "BavvbScanFavPanel", UIParent)
  p:SetSize(W, 520)
  p:SetFrameStrata("HIGH")
  p:SetClampedToScreen(true)
  p:EnableMouse(true)
  p:SetMovable(true)
  p:RegisterForDrag("LeftButton")
  p:SetScript("OnDragStart", function(self) if mode == "alone" then self:StartMoving() end end)
  p:SetScript("OnDragStop", function(self)
    self:StopMovingOrSizing()
    local x, y = self:GetLeft(), self:GetTop()
    if x and y then BavvbScanDB.favPos = { x, y } end
  end)
  p.bg = p:CreateTexture(nil, "BACKGROUND")
  p.bg:SetAllPoints()
  p.bg:SetColorTexture(0.05, 0.05, 0.06, 0.94)
  for _, side in ipairs({ { "TOPLEFT", "TOPRIGHT", "h" }, { "BOTTOMLEFT", "BOTTOMRIGHT", "h" }, { "TOPLEFT", "BOTTOMLEFT", "v" }, { "TOPRIGHT", "BOTTOMRIGHT", "v" } }) do
    local e = p:CreateTexture(nil, "BORDER")
    e:SetPoint(side[1])
    e:SetPoint(side[2])
    if side[3] == "h" then e:SetHeight(1) else e:SetWidth(1) end
    e:SetColorTexture(0.45, 0.38, 0.2, 1)
  end
  p.title = p:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  p.title:SetPoint("TOPLEFT", PAD, -PAD)
  p.title:SetJustifyH("LEFT")
  p.sub = p:CreateFontString(nil, "OVERLAY", "GameFontDisable")
  p.sub:SetPoint("TOPLEFT", p.title, "BOTTOMLEFT", 0, -3)
  p.sub:SetJustifyH("LEFT")
  p.close = CreateFrame("Button", nil, p, "UIPanelCloseButton")
  p.close:SetPoint("TOPRIGHT", 2, 2)
  p.close:SetScript("OnClick", function()
    if mode == "profession" then closedFor = profession end
    p:Hide()
  end)
  scroll = CreateFrame("ScrollFrame", "BavvbScanFavScroll", p, "UIPanelScrollFrameTemplate")
  scroll:SetPoint("TOPLEFT", PAD - 4, -52)
  scroll:SetPoint("BOTTOMRIGHT", -28, PAD + 30)
  -- the shopping-list bar along the bottom
  local bar = CreateFrame("Frame", nil, p)
  bar:SetPoint("BOTTOMLEFT", PAD, PAD)
  bar:SetPoint("BOTTOMRIGHT", -PAD, PAD)
  bar:SetHeight(24)
  local rule = bar:CreateTexture(nil, "BORDER")
  rule:SetPoint("TOPLEFT", 0, 4)
  rule:SetPoint("TOPRIGHT", 0, 4)
  rule:SetHeight(1)
  rule:SetColorTexture(0.45, 0.38, 0.2, 0.6)
  bar.text = bar:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  bar.text:SetFont(STANDARD_TEXT_FONT, SIZE, "")
  bar.text:SetPoint("LEFT", 0, 0)
  bar.text:SetJustifyH("LEFT")
  local function button(w)
    local b = CreateFrame("Button", nil, bar, "UIPanelButtonTemplate")
    b:SetSize(w, 22)
    b:SetScript("OnClick", function(self) if self.onClick then self.onClick() end end)
    return b
  end
  bar.b3 = button(56)
  bar.b3:SetPoint("RIGHT", 0, 0)
  bar.b2 = button(56)
  bar.b2:SetPoint("RIGHT", bar.b3, "LEFT", -4, 0)
  bar.b1 = button(76)
  bar.b1:SetPoint("RIGHT", bar.b2, "LEFT", -4, 0)
  bar.name = CreateFrame("EditBox", nil, bar, "InputBoxTemplate")
  bar.name:SetSize(130, 20)
  bar.name:SetAutoFocus(false)
  bar.name:SetMaxLetters(40)
  bar.name:SetPoint("RIGHT", bar.b1, "LEFT", -10, 0)
  bar.name:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
  bar.name:SetScript("OnEscapePressed", function(self) self.cancel = true; self:ClearFocus() end)
  bar.name:SetScript("OnEditFocusLost", function(self)
    local cancel = self.cancel
    self.cancel = nil
    if not cancel then
      local t = ((self:GetText() or ""):gsub("^%s+", ""):gsub("%s+$", ""))
      BavvbScanShop().name = t ~= "" and t or DEFAULT_LIST
    end
    C_Timer.After(0, BavvbScanFavRefresh)
  end)
  p.bar = bar
  content = CreateFrame("Frame", nil, scroll)
  content:SetSize(W - PAD - 28, 10)
  scroll:SetScrollChild(content)
  p:Hide()
  panel = p
  return p
end

-- ---------- shopping list ----------

function BavvbScanShop()
  BavvbScanDB.shop = BavvbScanDB.shop or {}
  local shop = BavvbScanDB.shop
  shop.recipes = shop.recipes or {}
  shop.name = shop.name or DEFAULT_LIST
  shop.margin = shop.margin or Core.DEFAULT_MARGIN
  shop.exits = shop.exits or {} -- recipe ID -> the exit it is judged on (kept after the recipe leaves the list)
  return shop
end

local function countOf(rid)
  for _, e in ipairs(BavvbScanShop().recipes) do if e.id == rid then return e.count end end
  return nil
end

local function clampCount(n)
  n = math.floor(tonumber(n) or 1)
  if n < 1 then n = 1 end
  if n > MAX_COUNT then n = MAX_COUNT end
  return n
end

local function say(msg) print("|cffffd100BavvbScan|r: " .. msg) end

local function shopAdd(rid, n, name)
  n = clampCount(n)
  local shop = BavvbScanShop()
  for _, e in ipairs(shop.recipes) do
    if e.id == rid then
      e.count = clampCount(e.count + n)
      say("added " .. n .. " x " .. name .. " to the shopping list (now " .. e.count .. ").")
      return
    end
  end
  shop.recipes[#shop.recipes + 1] = { id = rid, count = n }
  say("added " .. n .. " x " .. name .. " to the shopping list.")
end

local function shopSet(rid, n)
  for _, e in ipairs(BavvbScanShop().recipes) do if e.id == rid then e.count = clampCount(n or e.count) end end
end

local function shopRemove(rid)
  local shop = BavvbScanShop()
  for i, e in ipairs(shop.recipes) do if e.id == rid then table.remove(shop.recipes, i); return end end
end

-- What to buy, and the profit check with its price caps (FavCore: shopping, checkList).
local function shopping(fav)
  local shop = BavvbScanShop()
  local res = Core.compute(fav, BavvbScanDB.scan, BavvbScanApi, UnitFactionGroup("player"), nil)
  return Core.shopping(fav, res.inter, shop.recipes), Core.checkList(fav, res.book.price, res.inter, shop.recipes, shop.margin, shop.exits)
end

-- Names of the recipes on the list making less than the margin (or unpriced), in list order.
local function underMargin(check)
  local names = {}
  for _, e in ipairs(BavvbScanShop().recipes) do
    local c = check.recipes[e.id]
    if c and c.flagged then names[#names + 1] = c.name end
  end
  return names
end

local function exitWord(c) return c.exit == "Disenchant" and "disenchant" or (c.exit or "?") end

-- After each /bscan (BavvbScan.lua): name the recipes on the list that no longer make the margin.
function BavvbScanShopCheck()
  local fav = BavvbScanFavorites
  if not fav or fav.format ~= "bavvbfav" or not BavvbScanDB.shop or #BavvbScanShop().recipes == 0 then return end
  local shop = BavvbScanShop()
  local _, check = shopping(fav)
  for _, e in ipairs(shop.recipes) do
    local c = check.recipes[e.id]
    if c and c.flagged then
      say("shopping list: " .. color(RED, c.name) .. (c.profit and (" makes " .. money(c.profit) .. " per craft on " .. exitWord(c)) or " can't be priced")
        .. ", under your " .. money(shop.margin) .. " margin.")
    end
  end
end

-- Creates (or replaces) the list in Auctionator, through Auctionator's own API.
local function makeList()
  local fav = BavvbScanFavorites
  local shop = BavvbScanShop()
  local api = Auctionator and Auctionator.API and Auctionator.API.v1
  if not api or not api.CreateShoppingList then
    note = color(RED, "Auctionator isn't loaded: enable it in the AddOns list.")
  elseif not fav or fav.format ~= "bavvbfav" then
    note = color(RED, "No favorites file: nothing to list.")
  else
    local list, check = shopping(fav)
    local terms = {}
    for _, l in ipairs(list.buy) do terms[#terms + 1] = Core.searchTermCapped(l.name, l.qty, check.caps[l.item]) end
    local under = underMargin(check)
    if #under > 0 and not makeArmed then
      makeArmed = true
      C_Timer.After(5, function() makeArmed = nil end)
      note = color(RED, table.concat(under, ", ") .. " under the margin. Make list again to include anyway.")
      say(note)
      BavvbScanFavRefresh()
      return
    end
    makeArmed = nil
    if #terms == 0 then
      note = color(RED, "Nothing to buy on the list.")
    else
      local ok, err = pcall(api.CreateShoppingList, "BavvbScan", shop.name, terms)
      if ok then
        local capped = 0
        for _, l in ipairs(list.buy) do if check.caps[l.item] then capped = capped + 1 end end
        note = color(GREEN, 'Made "' .. shop.name .. '" in Auctionator: ' .. #terms .. (#terms == 1 and " item" or " items")
          .. ", " .. capped .. " with a max price" .. (#list.vendor > 0 and "; vendor items left off" or "") .. ".")
      else
        note = color(RED, "Auctionator refused the list: " .. tostring(err))
      end
    end
  end
  say(note)
  BavvbScanFavRefresh()
end

local function clearList()
  if not clearArmed then
    clearArmed = true
    C_Timer.After(3, function() clearArmed = nil; BavvbScanFavRefresh() end)
  else
    clearArmed = nil
    BavvbScanShop().recipes = {}
    note = nil
  end
  BavvbScanFavRefresh()
end

local function buildShop()
  local fav = BavvbScanFavorites
  local shop = BavvbScanShop()
  local specs = {}
  if #shop.recipes == 0 then
    specs[1] = { left = "Nothing on the list yet." }
    specs[2] = { left = color(GREY, "Open a recipe in Favorites and press Add.") }
    return specs
  end
  if not fav or fav.format ~= "bavvbfav" then
    specs[1] = { left = "No favorites file: the list can't be worked out." }
    return specs
  end
  local list, check = shopping(fav)
  specs[#specs + 1] = { key = "margin", left = "Keep at least" .. color(GREY, "  ·  silver per craft, after the AH cut"),
    tip = { "Margin", "Each recipe must make at least this much per craft at its exit (disenchant when the product can be disenchanted, unless you click the recipe to pick another; the AH cut is already taken off). Max prices on the list keep it there; a recipe under it shows red and is named after each /bscan." },
    box = { get = function() return math.floor(shop.margin / 100) end, set = function(n) shop.margin = math.max(0, math.floor(n or 0)) * 100 end } }
  specs[#specs + 1] = { left = color(GOLD, "Recipes"), right = color(GREY, "crafts     "), group = true }
  for _, e in ipairs(shop.recipes) do
    local r, rid = fav.recipes[e.id], e.id
    local c = check.recipes[rid]
    local label, tip
    if r and c then
      label = (c.flagged and color(RED, r.name) or r.name) .. "  " .. color(GREY, c.exit and exitShort(c.exit) or "no exit") .. " "
        .. (c.profit and profitText(c.profit) or color(RED, "unpriced"))
      tip = { r.name, (c.exit or "No exit") .. " per craft: " .. money(c.value) .. ", profit " .. profitText(c.profit),
        c.factor and ("AH reagents can cost up to " .. string.format("%.2f", c.factor) .. " x today's price and still keep " .. money(shop.margin) .. ".")
          or "Sets no max prices (a reagent or the exit is unpriced)." }
      if c.flagged then tip[#tip + 1] = color(RED, "Under the margin at today's prices.") end
      if #c.exits > 1 then tip[#tip + 1] = color(GREY, "Click to judge it on another exit (" .. table.concat(c.exits, ", ") .. ").") end
    end
    -- a click moves the recipe to its next exit (Vendor, Disenchant, AH order), remembered per recipe
    local cycle
    if c and #c.exits > 1 then
      cycle = function()
        local nextName = c.exits[1]
        for i, name in ipairs(c.exits) do if name == c.exit then nextName = c.exits[i % #c.exits + 1] end end
        shop.exits[rid] = nextName
        BavvbScanFavRefresh()
      end
    end
    specs[#specs + 1] = { key = "count:" .. rid, indent = 8, tip = tip, onClick = cycle,
      left = label or color(RED, "Recipe " .. rid .. ": not in Favorites now, left off"),
      box = r and { get = function() return countOf(rid) or 1 end, set = function(n) shopSet(rid, n) end } or nil,
      btn = { text = "x", width = 24, onClick = function() shopRemove(rid); BavvbScanFavRefresh() end } }
  end
  -- the whole list as one session (FavCore.session)
  local sess = Core.session(check, shop.recipes, shop.margin)
  specs[#specs + 1] = { key = "session", left = color(GOLD, "Session") .. color(GREY, "  ·  expected at today's prices"
      .. (sess.unpriced > 0 and (", " .. sess.unpriced .. " unpriced left out") or "")), right = profitText(sess.expected), group = true,
    tip = { "Session", "Profit per craft x crafts, added up over the list, each recipe on its exit.",
      "If you pay every max price: at least " .. profitText(sess.floor) .. " (each capped recipe keeps the margin)." } }
  specs[#specs + 1] = { left = color(GREY, "At least, paying every max price"), right = profitText(sess.floor), indent = 8 }
  specs[#specs + 1] = { left = color(GOLD, "To buy") .. color(GREY, "  ·  goes on the list"), each = color(GREY, "max price"), right = color(GREY, "units"), group = true }
  for _, l in ipairs(list.buy) do
    local cap = check.caps[l.item]
    specs[#specs + 1] = { left = l.name, each = cap and money(cap) or color(GREY, "none"), right = qtyText(l.qty), indent = 8 }
  end
  if #list.buy == 0 then specs[#specs + 1] = { left = color(GREY, "Nothing."), indent = 8 } end
  if #list.vendor > 0 then
    specs[#specs + 1] = { left = color(GOLD, "From a vendor") .. color(GREY, "  ·  not on the list"), group = true }
    for _, l in ipairs(list.vendor) do specs[#specs + 1] = { left = color(GREY, l.name), right = color(GREY, qtyText(l.qty)), indent = 8 } end
  end
  return specs
end

local function updateBar()
  local bar = panel.bar
  local n = #BavvbScanShop().recipes
  local function set(b, text, fn, enabled)
    b:SetText(text)
    b.onClick = fn
    if enabled == false then b:Disable() else b:Enable() end
    b:Show()
  end
  if view == "shop" then
    bar.text:SetText("List name")
    if not bar.name:HasFocus() then bar.name:SetText(BavvbScanShop().name) end
    bar.name:Show()
    set(bar.b1, "Make list", makeList, n > 0)
    set(bar.b2, clearArmed and "Sure?" or "Clear", clearList, n > 0)
    set(bar.b3, "Back", function() view = "fav"; note = nil; BavvbScanFavRefresh() end)
  else
    local warn = ""
    local fav = BavvbScanFavorites
    if n > 0 and fav and fav.format == "bavvbfav" then
      local _, check = shopping(fav)
      local under = #underMargin(check)
      if under > 0 then warn = color(RED, "  ·  " .. under .. " under margin") end
    end
    bar.text:SetText("Shopping list: " .. (n == 0 and color(GREY, "empty") or n .. (n == 1 and " recipe" or " recipes")) .. warn)
    bar.name:ClearFocus()
    bar.name:Hide()
    bar.b1:Hide()
    set(bar.b2, "Show", function() view = "shop"; BavvbScanFavRefresh() end)
    set(bar.b3, clearArmed and "Sure?" or "Clear", clearList, n > 0)
  end
end

-- ---------- what the panel lists ----------


local function rowTip(r)
  local tip = { r.name, "Cost (cheapest path): " .. money(r.cheapest) }
  for _, e in ipairs(r.exits) do
    tip[#tip + 1] = exitShort(e.name) .. ": " .. money(e.value) .. "   profit " .. profitText(e.profit) .. (e.isBest and "  " .. color(GOLD, "best") or "")
  end
  if #r.unpriced > 0 then tip[#tip + 1] = color(GREY, table.concat(r.unpriced, ", ") .. " unpriced") end
  tip[#tip + 1] = color(GREY, "Click for the cost breakdown.")
  return tip
end

local function addBreakdown(specs, r, book)
  local fallback = apiTip(book)
  specs[#specs + 1] = { left = color(GREY, "Cost" .. (r.made ~= 1 and " (makes " .. qtyText(r.made) .. ")" or "")), right = money(r.cheapest), indent = 14 }
  for _, l in ipairs(r.lines) do
    local tip
    if l.source == "api" then tip = { l.name, fallback } end
    specs[#specs + 1] = { left = qtyText(l.qty) .. " " .. (l.name or "?"), mid = color(GREY, SOURCE[l.source or ""] or ""),
      each = l.unit and priced(l.unit, l.source) or nil,
      right = l.unit and priced(l.total, l.source) or color(RED, "unpriced"), indent = 14, tip = tip }
    -- a crafted reagent: what goes into it (the cheapest path's choice; the buy / craft alternative isn't shown)
    if l.craft and l.craft.used then
      for _, s in ipairs(l.craft.lines) do
        specs[#specs + 1] = { left = color(GREY, qtyText(s.qty) .. " " .. (s.name or "?")), mid = color(GREY, SOURCE[s.source or ""] or ""),
          each = s.unit and priced(s.unit, s.source) or nil,
          right = s.unit and priced(s.total, s.source) or color(RED, "unpriced"), indent = 30,
          tip = s.source == "api" and { s.name, fallback } or nil }
      end
    end
  end
  local parts, anyApi = {}, false
  for _, e in ipairs(r.exits) do
    local src
    if e.name == "AH" then src = r.ahSource end
    if e.name == "Disenchant" then for _, m in ipairs(r.deMaterials or {}) do if m.source == "api" then src = "api" end end end
    if src == "api" then anyApi = true end
    parts[#parts + 1] = exitShort(e.name) .. " " .. priced(e.value, src) .. (e.isBest and color(GOLD, "*") or "")
  end
  specs[#specs + 1] = { left = table.concat(parts, color(GREY, "  ·  ")), indent = 14, tip = anyApi and { "Exits", fallback } or nil }
  local rid, have = r.id, countOf(r.id)
  specs[#specs + 1] = { key = "add:" .. rid, indent = 14,
    left = "Shopping list" .. (have and color(GREY, " (on it: " .. have .. ")") or "") .. color(GREY, "  ·  crafts"),
    tip = { "Shopping list", "Adds this recipe with the number of crafts in the box (1 unless you type more). Show, at the bottom, lists what to buy and makes the Auctionator list." },
    box = { get = function() return addQty[rid] or 1 end, set = function(n) addQty[rid] = clampCount(n) end },
    btn = { text = "Add", onClick = function(line)
      -- a number still being typed counts (clicking a button doesn't always end the typing first)
      if line.box and line.box:HasFocus() then
        addQty[rid] = clampCount(line.box:GetText())
        line.box.editing = nil
        line.box:ClearFocus()
      end
      shopAdd(rid, addQty[rid] or 1, r.name)
      addQty[rid] = nil
      BavvbScanFavRefresh()
    end } }
end

local function build()
  local fav = BavvbScanFavorites
  local specs = {}
  if not fav or fav.format ~= "bavvbfav" then
    specs[1] = { left = "No favorites yet. In the shuffle app: File > Link game addon folder, then /reload here." }
    return specs, nil, nil
  end
  local faction = UnitFactionGroup("player")
  local only = mode == "profession" and profession or nil
  local res = Core.compute(fav, BavvbScanDB.scan, BavvbScanApi, faction, only)
  if only and #res.groups == 0 then res = Core.compute(fav, BavvbScanDB.scan, BavvbScanApi, faction, nil) end
  for _, g in ipairs(res.groups) do
    local folded = BavvbScanDB.favFolded and BavvbScanDB.favFolded[g.name]
    specs[#specs + 1] = { left = color(GOLD, (folded and "+ " or "- ") .. g.name), group = true, onClick = function()
      BavvbScanDB.favFolded = BavvbScanDB.favFolded or {}
      BavvbScanDB.favFolded[g.name] = not folded or nil
      BavvbScanFavRefresh()
    end }
    if not folded then
      for _, r in ipairs(g.rows) do
        specs[#specs + 1] = { left = r.name, mid = color(GREY, r.bestExitName and exitShort(r.bestExitName) or "unpriced"),
          -- the product's AH listing price (per unit, before the cut), then the profit at the best exit in brackets
          each = r.ahPrice and priced(r.ahPrice, r.ahSource) or nil,
          right = color(GREY, "(") .. profitText(r.profitBest) .. color(GREY, ")"), indent = 8, tip = rowTip(r),
          onClick = function() open[r.id] = not open[r.id] or nil; BavvbScanFavRefresh() end }
        if open[r.id] then addBreakdown(specs, r, res.book) end
      end
    end
  end
  if #specs == 0 then specs[1] = { left = "No favorites in the shuffle app's Favorites yet." } end
  return specs, res.book, fav
end

local function layout(specs)
  local y = 0
  for i, s in ipairs(specs) do
    local b = pool[i] or makeLine(i)
    -- a box being typed in keeps its text only while the same line (key) stays on it
    if b.box and b.box:HasFocus() and (not s.box or b.box.editKey ~= s.key) then b.box:ClearFocus() end
    b.spec = s
    local h = s.group and ROW + 4 or ROW
    b:SetHeight(h)
    b:ClearAllPoints()
    b:SetPoint("TOPLEFT", content, "TOPLEFT", 0, -y)
    b:SetPoint("RIGHT", content, "RIGHT", 0, 0)
    b.left:ClearAllPoints()
    b.left:SetPoint("LEFT", b, "LEFT", s.indent or 0, 0)
    if s.mid then b.left:SetPoint("RIGHT", b.mid, "LEFT", -4, 0)
    elseif s.right then b.left:SetPoint("RIGHT", b, "RIGHT", -96, 0)
    else b.left:SetPoint("RIGHT", b, "RIGHT", -4, 0) end
    b.left:SetText(s.left or "")
    b.mid:SetText(s.mid or "")
    b.each:SetText(s.each or "")
    b.right:SetText(s.right or "")
    -- a number box and/or a button on the right (shopping list lines)
    if s.box then
      if not b.box then
        b.box = CreateFrame("EditBox", nil, b, "InputBoxTemplate")
        b.box:SetSize(44, ROW - 2)
        b.box:SetAutoFocus(false)
        b.box:SetNumeric(true)
        b.box:SetMaxLetters(4)
        b.box:SetJustifyH("RIGHT")
        b.box:SetScript("OnEnterPressed", function(self) self:ClearFocus() end)
        b.box:SetScript("OnEscapePressed", function(self) self.cancel = true; self:ClearFocus() end)
        b.box:SetScript("OnEditFocusGained", function(self)
          local spec = self:GetParent().spec
          self.editing, self.editKey = spec and spec.box, spec and spec.key
        end)
        b.box:SetScript("OnEditFocusLost", function(self)
          local editing, cancel = self.editing, self.cancel
          self.editing, self.editKey, self.cancel = nil, nil, nil
          if editing and not cancel then editing.set(tonumber(self:GetText() or "")) end
          C_Timer.After(0, BavvbScanFavRefresh) -- not now: this can run in the middle of a layout
        end)
      end
      b.box:ClearAllPoints()
      b.box:SetPoint("RIGHT", b, "RIGHT", -(s.btn and 66 or 4), 0)
      if not b.box:HasFocus() then b.box:SetText(tostring(s.box.get())) end
      b.box:Show()
      b.left:SetPoint("RIGHT", b.box, "LEFT", -8, 0)
    elseif b.box then b.box:ClearFocus(); b.box:Hide() end
    if s.btn then
      if not b.btn then
        b.btn = CreateFrame("Button", nil, b, "UIPanelButtonTemplate")
        b.btn:SetHeight(ROW)
        b.btn:SetScript("OnClick", function(self)
          local spec = self:GetParent().spec
          if spec and spec.btn then spec.btn.onClick(self:GetParent()) end
        end)
      end
      b.btn:ClearAllPoints()
      b.btn:SetPoint("RIGHT", b, "RIGHT", -2, 0)
      b.btn:SetWidth(s.btn.width or 56)
      b.btn:SetText(s.btn.text)
      b.btn:Show()
      if not s.box then b.left:SetPoint("RIGHT", b.btn, "LEFT", -8, 0) end
    elseif b.btn then b.btn:Hide() end
    b:Show()
    y = y + h
  end
  for i = #specs + 1, #pool do
    local b = pool[i]
    if b.box then b.box:ClearFocus() end
    b:Hide(); b.spec = nil
  end
  content:SetHeight(math.max(y, 10))
end

function BavvbScanFavRefresh()
  if not panel or not panel:IsShown() then return end
  updateBar()
  if view == "shop" then
    layout(buildShop())
    panel.title:SetText("Shopping list " .. color(GREY, "· all professions"))
    panel.sub:SetText(note or "Units for the crafts above, on the cheapest path.")
    return
  end
  local specs, book, fav = build()
  layout(specs)
  local shown = mode == "profession" and profession or "all professions"
  panel.title:SetText("Favorites " .. color(GREY, "· " .. shown))
  local parts = {}
  if book then
    parts[#parts + 1] = book.scanTime and ("scan " .. clock(book.scanTime)) or "no scan on this faction"
    if book.apiTime then parts[#parts + 1] = "hourly " .. clock(book.apiTime) end
  end
  if fav and fav.at and fav.at > 0 then parts[#parts + 1] = "favorites sent " .. date("%b %d ", fav.at) .. clock(fav.at) end
  panel.sub:SetText(table.concat(parts, "  ·  "))
end

-- ---------- showing it ----------

local function professionName()
  local ok, info = pcall(function() return C_TradeSkillUI.GetBaseProfessionInfo() end)
  if ok and type(info) == "table" and info.professionName and info.professionName ~= "" then return info.professionName end
  ok, info = pcall(function() return C_TradeSkillUI.GetChildProfessionInfo() end)
  if ok and type(info) == "table" and info.parentProfessionName and info.parentProfessionName ~= "" then return info.parentProfessionName end
  if GetTradeSkillLine then
    local name = GetTradeSkillLine()
    if name and name ~= "" and name ~= "UNKNOWN" then return name end
  end
  return nil
end

local function hasFavorites(prof)
  local fav = BavvbScanFavorites
  if not fav or not prof then return false end
  for _, g in ipairs(fav.groups) do
    for _, rid in ipairs(g.recipes) do
      local r = fav.recipes[rid]
      if r and r.profession == prof then return true end
    end
  end
  return false
end

local function dock()
  local host = ProfessionsFrame or TradeSkillFrame
  if not host or not host:IsShown() then return end
  local prof = professionName()
  if prof ~= profession then closedFor = nil end
  profession = prof
  if closedFor and closedFor == prof then return end
  if not hasFavorites(prof) then
    if mode == "profession" and panel then panel:Hide() end
    return
  end
  local p = makePanel()
  mode = "profession"
  p:ClearAllPoints()
  p:SetPoint("TOPLEFT", host, "TOPRIGHT", 4, 0)
  p:SetHeight(math.max(300, host:GetHeight()))
  p:Show()
  BavvbScanFavRefresh()
end

local function undock()
  closedFor = nil
  if panel and mode == "profession" then panel:Hide() end
end

-- /bsf (or /bscan fav): on its own, all professions; a second /bsf closes it.
function BavvbScanFavToggle()
  local p = makePanel()
  if p:IsShown() and mode == "alone" then p:Hide() return end
  mode = "alone"
  p:ClearAllPoints()
  local pos = BavvbScanDB.favPos
  if pos then p:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", pos[1], pos[2]) else p:SetPoint("CENTER") end
  p:SetHeight(520)
  p:Show()
  BavvbScanFavRefresh()
end

local f = CreateFrame("Frame")
f:RegisterEvent("TRADE_SKILL_SHOW")
f:RegisterEvent("TRADE_SKILL_CLOSE")
f:RegisterEvent("TRADE_SKILL_LIST_UPDATE")
f:RegisterEvent("ADDON_LOADED")
local hooked = false
local pending = false
f:SetScript("OnEvent", function(_, event, name)
  if event == "ADDON_LOADED" then
    if not hooked and ProfessionsFrame then
      hooked = true
      ProfessionsFrame:HookScript("OnShow", function() C_Timer.After(0, dock) end)
      ProfessionsFrame:HookScript("OnHide", undock)
    end
  elseif event == "TRADE_SKILL_CLOSE" then
    undock()
  elseif not pending then -- the window opened or switched profession: wait a frame for its info to settle
    pending = true
    C_Timer.After(0.1, function() pending = false; dock() end)
  end
end)
