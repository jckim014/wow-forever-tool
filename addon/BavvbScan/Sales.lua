-- BavvbScan sales log: records each auction sale when its money reaches the character's gold.
--
-- Why gold and not clicks: a mail can glitch (money taken but the mail stays, or it seems to come twice), and the
-- money can be collected by anything (by hand, Open All, TSM's mailbox). So the inbox is watched instead: when a mail
-- with money leaves the inbox (or its money goes), it waits; when the character's gold rises, the rise is matched to
-- waiting mails whose money adds up to exactly that amount. Only matched auction-sale mails become sales. A mail that
-- comes back cancels its wait. Nothing is clicked, opened or sent: the addon only reads.
--
-- Saved layout (in BavvbScanDB, the same file as the scans):
--   sales = { format = "bavvbsales", version = 1, next = <counter for ids>,
--     records = { { id, t, char, realm, faction, visit, item, count, price, deposit, cut, money, received, status,
--                   src }, ... },
--     visits  = { { id, t0, t1, char, realm, faction, goldIn, goldOut, sales, received, deposits, other,
--                   unexplained, missing }, ... } }
--   price = sale price (whole stack), cut = AH cut, deposit = listing deposit returned, money = gold in the mail,
--   received = money - deposit (sale price - AH cut), all copper. status: "ok" = its money reached the gold;
--   "nogold" = the mail went but no matching gold came (left for Josh to judge). src: "invoice" (the mail's sale
--   details) or "subject" (only the subject could be read: item and count from it, deposit unknown, received = money).
--   A visit = one mailbox opening: goldIn / goldOut = all rises / falls of gold while open, other = money from mails
--   that are not sales (refunds, gold sent between characters), unexplained = gold rises no mail accounts for,
--   missing = sale mails that left without their gold.
-- Records are only ever added; fixes happen in the trade tracker. Buyer names are never read into the saved data.

local GRACE = 10     -- seconds after the mailbox closes to wait for late gold or inbox updates
local MAX_SUBSET = 12 -- waiting mails considered when matching one gold rise (a rise can pay several mails at once)

-- Pure part (no WoW calls), exposed for the test harness.
local Core = {}
BavvbScanSalesCore = Core

function Core.newVisit(now)
  return { t0 = now, present = {}, info = {}, pending = {}, rises = {}, goldIn = 0, goldOut = 0, confirmed = {},
    other = 0 }
end

-- The subset of v.pending (first MAX_SUBSET, earliest preferred) whose money sums to amount, as a list of indexes.
local function subset(pending, amount)
  local n = math.min(#pending, MAX_SUBSET)
  local pick = {}
  local function dfs(i, left)
    if left == 0 then return true end
    if i > n then return false end
    local m = pending[i].mail.money
    if m <= left then
      pick[#pick + 1] = i
      if dfs(i + 1, left - m) then return true end
      pick[#pick] = nil
    end
    return dfs(i + 1, left)
  end
  -- A single exact match first (the usual case), then combinations.
  for i = 1, n do
    if pending[i].mail.money == amount then return { i } end
  end
  if dfs(1, amount) then return pick end
  return nil
end

local function match(v, now)
  local i = 1
  while i <= #v.rises do
    local pick = subset(v.pending, v.rises[i].amount)
    if pick then
      table.sort(pick, function(a, b) return a > b end)
      local got = {}
      for _, k in ipairs(pick) do got[#got + 1] = table.remove(v.pending, k) end
      for k = #got, 1, -1 do
        local p = got[k]
        if p.mail.kind == "seller" then
          v.confirmed[#v.confirmed + 1] = { mail = p.mail, at = now }
        else
          v.other = v.other + p.mail.money
        end
      end
      table.remove(v.rises, i)
    else
      i = i + 1
    end
  end
end

-- list: the money mails now in the inbox, each { sig, money, kind, item, count, price, deposit, cut, src }.
function Core.inbox(v, list, now)
  local counts = {}
  for _, m in ipairs(list) do
    counts[m.sig] = (counts[m.sig] or 0) + 1
    local old = v.info[m.sig]
    -- Keep the fullest details seen for a mail (sale details can load after the subject).
    if not old or old.src ~= "invoice" or m.src == "invoice" then v.info[m.sig] = m end
  end
  for sig, n in pairs(v.present) do
    for _ = 1, n - (counts[sig] or 0) do
      v.pending[#v.pending + 1] = { mail = v.info[sig], at = now }
    end
  end
  for sig, n in pairs(counts) do
    for _ = 1, n - (v.present[sig] or 0) do
      -- A mail that comes back (a refresh that briefly dropped it) cancels its wait.
      for k = #v.pending, 1, -1 do
        if v.pending[k].mail.sig == sig then
          table.remove(v.pending, k)
          break
        end
      end
    end
  end
  v.present = counts
  match(v, now)
end

function Core.money(v, delta, now)
  if delta > 0 then
    v.goldIn = v.goldIn + delta
    v.rises[#v.rises + 1] = { amount = delta, at = now }
    match(v, now)
  elseif delta < 0 then
    v.goldOut = v.goldOut - delta
  end
end

-- Ends a visit: returns the sale records (without ids) and the visit summary.
function Core.finish(v, now)
  local out = {}
  local function add(mail, at, status)
    local received = mail.money - (mail.deposit or 0)
    out[#out + 1] = { t = at, item = mail.item, count = mail.count, price = mail.price, deposit = mail.deposit,
      cut = mail.cut, money = mail.money, received = received, status = status, src = mail.src }
  end
  local sales, received, deposits, missing = 0, 0, 0, 0
  for _, c in ipairs(v.confirmed) do
    add(c.mail, c.at, "ok")
    sales = sales + 1
    received = received + (c.mail.money - (c.mail.deposit or 0))
    deposits = deposits + (c.mail.deposit or 0)
  end
  for _, p in ipairs(v.pending) do
    if p.mail.kind == "seller" then
      add(p.mail, p.at, "nogold")
      missing = missing + 1
    end
  end
  local unexplained = 0
  for _, r in ipairs(v.rises) do unexplained = unexplained + r.amount end
  return out, { t0 = v.t0, t1 = now, goldIn = v.goldIn, goldOut = v.goldOut, sales = sales, received = received,
    deposits = deposits, other = v.other, unexplained = unexplained, missing = missing }
end

-- The parts below talk to the game.

local function db()
  BavvbScanDB = BavvbScanDB or {}
  local s = BavvbScanDB.sales
  if type(s) ~= "table" or s.format ~= "bavvbsales" then
    s = { format = "bavvbsales", version = 1, next = 1, records = {}, visits = {} }
    BavvbScanDB.sales = s
  end
  return s
end

local function say(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ccffBavvbScan|r: " .. msg)
end

local function coins(c)
  c = math.floor(c + 0.5)
  local g, s, k = math.floor(c / 10000), math.floor(c / 100) % 100, c % 100
  if g > 0 then return string.format("%dg %02ds %02dc", g, s, k) end
  if s > 0 then return string.format("%ds %02dc", s, k) end
  return k .. "c"
end

-- "Auction successful: %s" -> a pattern capturing the item part.
local soldPattern
local function subjectItem(subject)
  if not soldPattern then
    local fmt = AUCTION_SOLD_MAIL_SUBJECT or "Auction successful: %s"
    soldPattern = "^" .. fmt:gsub("([%(%)%.%+%-%*%?%[%]%^%$])", "%%%1"):gsub("%%s", "(.+)") .. "$"
  end
  local item = subject and subject:match(soldPattern)
  if not item then return nil end
  local name, n = item:match("^(.-)%s*%((%d+)%)$")
  if name then return name, tonumber(n) end
  return item, 1
end

-- The inbox's money mails, in the Core's shape. Only item, count and amounts are kept: never the buyer or sender.
local function readInbox()
  local list = {}
  for i = 1, GetInboxNumItems() do
    local _, _, _, subject, money = GetInboxHeaderInfo(i)
    if money and money > 0 then
      local m = { sig = tostring(subject) .. "|" .. money, money = money, kind = "other" }
      local t, item, _, bid, buyout, deposit, cut, _, _, c10, c11 = GetInboxInvoiceInfo(i)
      if t == "seller" and item then
        -- On the Forever client the quantity came as the 5th and 11th values (checked 2026-11-14); take the first
        -- positive of the 11th, 10th, 5th.
        local count = (type(c11) == "number" and c11 > 0 and c11) or (type(c10) == "number" and c10 > 0 and c10)
          or (type(buyout) == "number" and buyout > 0 and buyout) or 1
        m.kind, m.item, m.count, m.price, m.deposit, m.cut, m.src = "seller", item, count, bid, deposit or 0, cut or 0,
          "invoice"
      else
        local name, n = subjectItem(subject)
        if name then
          m.kind, m.item, m.count, m.src = "seller", name, n, "subject"
        end
      end
      list[#list + 1] = m
    end
  end
  return list
end

local frame = CreateFrame("Frame")
local visit, closing
local lastMoney

-- What a visit has recorded so far, for the report the moment the mailbox closes (the visit itself stays open
-- GRACE seconds longer for gold that arrives late; the report is corrected if that changes anything).
function Core.preview(v)
  local p = { sales = 0, received = 0, waiting = 0, unexplained = 0, missing = 0 }
  for _, c in ipairs(v.confirmed) do
    p.sales = p.sales + 1
    p.received = p.received + (c.mail.money - (c.mail.deposit or 0))
  end
  for _, q in ipairs(v.pending) do
    if q.mail.kind == "seller" then p.waiting = p.waiting + 1 end
  end
  for _, r in ipairs(v.rises) do p.unexplained = p.unexplained + r.amount end
  return p
end

local function plural(n, word) return n .. " " .. word .. (n == 1 and "" or "s") end

-- Problems in a summary (finished visit), as short phrases.
local function issuesOf(x)
  local out = {}
  if (x.missing or 0) > 0 then
    out[#out + 1] = plural(x.missing, "sale mail") .. " left without " .. (x.missing == 1 and "its" or "their") .. " gold"
  end
  if (x.unexplained or 0) > 0 then out[#out + 1] = coins(x.unexplained) .. " gold no mail accounts for" end
  return out
end

-- One line for chat and the popup: sales, gold, and either "gold OK", "waiting for gold" or the problems.
local function reportLine(x, chat)
  local line = plural(x.sales, "sale") .. " recorded (" .. coins(x.received) .. ")"
  local issues = issuesOf(x)
  if #issues > 0 then
    return line .. (chat and ". " or "\n") .. "|cffffb000Check in the tracker: " .. table.concat(issues, "; ") .. "|r"
  elseif (x.waiting or 0) > 0 then
    return line .. (chat and ", " or "  ") .. "|cffffff80waiting for the gold of " .. plural(x.waiting, "mail") .. "...|r"
  end
  return line .. (chat and ", mailbox gold matches " or "  ") .. "|cff40ff40" .. (chat and "(OK)" or "gold OK") .. "|r"
end

local function hasNews(x) return x.sales > 0 or (x.missing or 0) > 0 or (x.unexplained or 0) > 0 or (x.waiting or 0) > 0 end

-- A small popup near the top of the screen after a mailbox visit with sales: what was recorded, whether the gold
-- matched, and a Reload button (WoW writes the file on /reload). Visits add up until it is closed or reloaded; the
-- visit just closed counts from its preview until it is final. Stays until clicked; no sound. Never saved, so a
-- /reload removes it.
local popup
local shown = { sales = 0, received = 0, missing = 0, unexplained = 0 }
local live -- preview of the visit just closed, until it is saved

local function drawPopup()
  local x = { sales = shown.sales, received = shown.received, missing = shown.missing, unexplained = shown.unexplained,
    waiting = 0 }
  if live then
    x.sales, x.received = x.sales + live.sales, x.received + live.received
    x.unexplained, x.waiting = x.unexplained + live.unexplained, live.waiting
  end
  if not hasNews(x) then return end
  if not popup then
    local p = CreateFrame("Frame", "BavvbScanSalesPopup", UIParent)
    p:SetSize(520, 84)
    p:SetPoint("TOP", UIParent, "TOP", 0, -110)
    p:SetFrameStrata("DIALOG")
    p.bg = p:CreateTexture(nil, "BACKGROUND")
    p.bg:SetAllPoints()
    p.bg:SetColorTexture(0, 0, 0, 0.8)
    p.edge = p:CreateTexture(nil, "BORDER")
    p.edge:SetPoint("TOPLEFT")
    p.edge:SetPoint("BOTTOMLEFT")
    p.edge:SetWidth(4)
    p.line = p:CreateFontString(nil, "OVERLAY", "GameFontHighlightLarge")
    p.line:SetPoint("TOPLEFT", 16, -12)
    p.line:SetPoint("RIGHT", -36, 0)
    p.line:SetJustifyH("LEFT")
    p.reload = CreateFrame("Button", nil, p, "UIPanelButtonTemplate")
    p.reload:SetSize(110, 26)
    p.reload:SetPoint("BOTTOMRIGHT", -12, 10)
    p.reload:SetText("Reload")
    p.reload:SetScript("OnClick", function() ReloadUI() end)
    p.close = CreateFrame("Button", nil, p, "UIPanelCloseButton")
    p.close:SetPoint("TOPRIGHT", 0, 0)
    p.close:SetScript("OnClick", function()
      p:Hide()
      shown = { sales = 0, received = 0, missing = 0, unexplained = 0 }
    end)
    popup = p
  end
  local bad = #issuesOf(x) > 0
  popup.edge:SetColorTexture(bad and 1 or 0.25, bad and 0.7 or 1, bad and 0.1 or 0.25, 1)
  popup.line:SetText("BavvbScan: " .. reportLine(x, false))
  popup:Show()
end

local function save(v, now)
  local records, summary = Core.finish(v, now)
  if #records == 0 and summary.goldIn == 0 then return end -- no money came in (e.g. only postage paid): keep no visit
  local s = db()
  local who = {
    char = UnitName("player"), realm = GetRealmName(), faction = UnitFactionGroup("player"),
  }
  local vid = who.char .. "-" .. v.t0 .. "-" .. s.next
  s.next = s.next + 1
  summary.id, summary.char, summary.realm, summary.faction = vid, who.char, who.realm, who.faction
  s.visits[#s.visits + 1] = summary
  for _, r in ipairs(records) do
    r.id = who.char .. "-" .. r.t .. "-" .. s.next
    s.next = s.next + 1
    r.char, r.realm, r.faction, r.visit = who.char, who.realm, who.faction, vid
    s.records[#s.records + 1] = r
  end
  -- Chat: once when the mailbox closed (the preview); again only if the final result differs from it.
  local final = reportLine(summary, true)
  if hasNews(summary) and final ~= v.reported then say(final) end
  shown.sales, shown.received = shown.sales + summary.sales, shown.received + summary.received
  shown.missing, shown.unexplained = shown.missing + summary.missing, shown.unexplained + summary.unexplained
  live = nil
  drawPopup()
end

local function finishVisit()
  if visit then
    local v = visit
    visit, closing = nil, nil
    save(v, time())
  end
end

-- The mailbox opening and closing. The Forever client (like TSM, which reads the same) reports them as
-- PLAYER_INTERACTION_MANAGER_FRAME_SHOW / _HIDE with the type MailInfo; MAIL_SHOW / MAIL_CLOSED are used only where
-- those don't exist. First real try (2026-11-14): visits ended with no gold seen while relying on MAIL_CLOSED.
local function mailType()
  return Enum and Enum.PlayerInteractionType and Enum.PlayerInteractionType.MailInfo
end

local function opened()
  closing = nil -- reopened within the grace time: same visit
  if not visit then visit = Core.newVisit(time()) end
  lastMoney = GetMoney()
end

local function closed()
  if visit and not closing then
    -- Report at once what is recorded so far.
    live = Core.preview(visit)
    if hasNews(live) then
      visit.reported = reportLine(live, true)
      say(visit.reported)
      drawPopup()
    end
    local token = {}
    closing = token
    C_Timer.After(GRACE, function()
      if closing == token then finishVisit() end
    end)
  end
end

-- Diagnostics: the last 120 mailbox-related events (name, time, mails in the inbox, gold, visit open), saved with
-- the log so a visit that goes wrong can be read back from the file. No mail contents.
local function note(event, arg)
  local s = db()
  s.events = s.events or {}
  local n = GetInboxNumItems and GetInboxNumItems() or -1
  s.events[#s.events + 1] = string.format("%d %s %s n=%d m=%d v=%s c=%s", time(), event, tostring(arg), n, GetMoney(),
    visit and "1" or "0", closing and "1" or "0")
  while #s.events > 120 do table.remove(s.events, 1) end
end

frame:SetScript("OnEvent", function(_, event, arg)
  if event ~= "PLAYER_LOGIN" and event ~= "PLAYER_ENTERING_WORLD" and event ~= "PLAYER_LOGOUT"
    and (event ~= "PLAYER_MONEY" or visit) then
    note(event, arg)
  end
  if event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD" then
    lastMoney = GetMoney()
  elseif event == "PLAYER_INTERACTION_MANAGER_FRAME_SHOW" then
    if arg == mailType() then opened() end
  elseif event == "PLAYER_INTERACTION_MANAGER_FRAME_HIDE" then
    if arg == mailType() then closed() end
  elseif event == "MAIL_SHOW" then
    opened()
  elseif event == "MAIL_CLOSED" then
    if not mailType() then closed() end
  elseif event == "MAIL_INBOX_UPDATE" then
    -- Not after closing: the client may then report an empty inbox, which would look like every mail leaving.
    if visit and not closing then Core.inbox(visit, readInbox(), time()) end
  elseif event == "PLAYER_MONEY" then
    local now = GetMoney()
    if visit and lastMoney then Core.money(visit, now - lastMoney, time()) end
    lastMoney = now
  elseif event == "PLAYER_LOGOUT" then
    finishVisit() -- a /reload or logout with the mailbox open still saves what was matched
  end
end)
for _, e in ipairs({ "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "MAIL_SHOW", "MAIL_INBOX_UPDATE", "PLAYER_MONEY",
  "MAIL_CLOSED", "PLAYER_LOGOUT", "PLAYER_INTERACTION_MANAGER_FRAME_SHOW", "PLAYER_INTERACTION_MANAGER_FRAME_HIDE" }) do
  pcall(frame.RegisterEvent, frame, e) -- an event this client doesn't know is skipped
end

-- /bscan sales: the last few sales and the last mailbox check.
function BavvbScanSalesStatus()
  local s = db()
  local n = #s.records
  if n == 0 then
    say("No sales recorded yet. They are recorded when you collect auction money at a mailbox.")
    return
  end
  say(n .. " sales recorded. Latest:")
  for i = n, math.max(1, n - 4), -1 do
    local r = s.records[i]
    say(string.format("  %s  %s x%d  %s%s", date("%m-%d %H:%M", r.t), tostring(r.item), r.count or 1, coins(r.received),
      r.status == "ok" and "" or "  |cffffb000(no gold seen)|r"))
  end
  local v = s.visits[#s.visits]
  if v then
    local ok = v.missing == 0 and v.unexplained == 0
    say(string.format("Last mailbox visit %s (%s): %d sales, gold in %s%s", date("%m-%d %H:%M", v.t0), tostring(v.char),
      v.sales, coins(v.goldIn), ok and " |cff40ff40(OK)|r" or " |cffffb000check in the tracker|r"))
  end
end
