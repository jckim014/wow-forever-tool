-- BavvbScan favorites panel: the shuffle app's Favorites (cost, best exit, profit, and a cost breakdown per recipe)
-- worked out in game from this character's latest /bscan, with the hourly API prices filling gaps (FavCore.lua).
-- Opens by itself to the right of the profession window when that profession has favorites, and with /bscan fav
-- (all professions, movable). Read-only: it only shows numbers.

local Core = BavvbScanFavCore
local W, ROW, PAD, SIZE = 460, 19, 10, 13 -- SIZE: font size of the lines
local panel, content, scroll
local pool = {}
local open = {}        -- recipe ID -> breakdown shown
local mode             -- "profession" (docked) or "alone" (/bscan fav)
local profession       -- the profession window's profession, when docked
local closedFor        -- the profession the close button hid it for (until that window opens again)

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
  scroll:SetPoint("BOTTOMRIGHT", -28, PAD)
  content = CreateFrame("Frame", nil, scroll)
  content:SetSize(W - PAD - 28, 10)
  scroll:SetScrollChild(content)
  p:Hide()
  panel = p
  return p
end

-- ---------- what the panel lists ----------

local function exitShort(name) return name == "Disenchant" and "DE" or name end

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
          right = profitText(r.profitBest), indent = 8, tip = rowTip(r),
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
    b:Show()
    y = y + h
  end
  for i = #specs + 1, #pool do pool[i]:Hide(); pool[i].spec = nil end
  content:SetHeight(math.max(y, 10))
end

function BavvbScanFavRefresh()
  if not panel or not panel:IsShown() then return end
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

-- /bscan fav: on its own, all professions; a second /bscan fav closes it.
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
