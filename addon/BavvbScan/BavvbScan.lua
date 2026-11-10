-- BavvbScan: one full auction house scan when asked (/bscan), saving every listing that has a buyout.
--
-- The shuffle app reads the saved file (WTF\Account\<account>\SavedVariables\BavvbScan.lua) and works out its prices.
-- Saved layout (format "bavvbscan", version 1):
--   BavvbScanDB = {
--     lastRequest = <Unix time of the last full-scan request, for the server's 15-minute limit>,
--     scan = { format, version, realm, faction, time, auctions, listings, bidOnly, skipped,
--              items = { [itemID] = "count:buyout,count:buyout,..." } },   -- buyout is for the whole stack, in copper
--   }
-- Only the latest complete scan is kept. A scan that does not finish (auction house closed, server silent) saves
-- nothing and leaves the previous scan in place.

local THROTTLE = 15 * 60 -- the server answers one full-scan request per 15 minutes (any addon's request counts)
local SETTLE = 15        -- seconds with no new auctions before the list counts as complete
local SETTLE_SMALL = 60  -- the same while fewer than 80% of the previous scan's auctions have arrived
local GIVE_UP = 300      -- seconds to wait for the server overall (scans used to arrive within ~2 minutes)
local REPORT = 15        -- seconds between progress lines while waiting
local BATCH = 2000       -- listings read per frame
local RETRIES = 5        -- passes over listings whose data was not loaded yet

BavvbScanDB = BavvbScanDB or {}

local frame = CreateFrame("Frame")
local ahOpen = false
local scan -- the scan in progress, nil when idle
local tick, read

local function say(msg)
  DEFAULT_CHAT_FRAME:AddMessage("|cff33ccffBavvbScan|r: " .. msg)
end

local function num(x) -- 128412 -> "128,412"
  local s, r = tostring(x), 0
  repeat s, r = string.gsub(s, "^(%d+)(%d%d%d)", "%1,%2") until r == 0
  return s
end

local function nextAllowed()
  local last = BavvbScanDB.lastRequest
  if not last then return 0 end
  return math.max(0, last + THROTTLE - time())
end

local function nextScanText()
  local left = nextAllowed()
  if left <= 0 then return "now" end
  return string.format("in %dm %02ds", math.floor(left / 60), left % 60)
end

local function isAhOpen()
  return ahOpen or (AuctionHouseFrame ~= nil and AuctionHouseFrame:IsShown()) or false
end

local function finish()
  scan = nil
  frame:UnregisterEvent("REPLICATE_ITEM_LIST_UPDATE")
end

local function fail(msg)
  finish()
  say("|cffff4040" .. msg .. "|r Nothing was saved; the previous scan is kept. Next scan allowed " .. nextScanText() .. ".")
end

local function start()
  if scan then
    say("A scan is already running. Keep the auction house open.")
    return
  end
  if not isAhOpen() then
    say("Open the auction house first.")
    return
  end
  if nextAllowed() > 0 then
    say("The server allows one full scan every 15 minutes. Next scan allowed " .. nextScanText() .. ".")
    return
  end
  BavvbScanDB.lastRequest = time()
  local now = GetTime()
  -- base: the list size before this request (a list from an earlier scan this session stays readable until replaced)
  local base = C_AuctionHouse.GetNumReplicateItems() or 0
  scan = { started = now, heard = false, base = base, count = 0, changed = now, reported = now }
  frame:RegisterEvent("REPLICATE_ITEM_LIST_UPDATE")
  C_AuctionHouse.ReplicateItems()
  say("Scan requested. Keep the auction house open until it says the scan is saved (usually under a minute).")
  C_Timer.After(1, tick)
end

-- Once a second while waiting: done when auctions have arrived and their number has stopped growing.
tick = function()
  if not scan or scan.reading then return end
  local now = GetTime()
  local c = C_AuctionHouse.GetNumReplicateItems() or 0
  -- Answered: the client said so (REPLICATE_ITEM_LIST_UPDATE), or the list size changed without that event.
  if not scan.heard and c > 0 and c ~= scan.base then
    scan.heard, scan.count, scan.changed = true, c, now
  end
  if scan.heard then
    if c ~= scan.count then
      scan.count, scan.changed = c, now
    end
    local prev = BavvbScanDB.scan and BavvbScanDB.scan.auctions
    local settle = (prev and c < 0.8 * prev) and SETTLE_SMALL or SETTLE
    if c > 0 and now - scan.changed >= settle then
      read()
      return
    end
  end
  if now - scan.started >= GIVE_UP then
    if scan.count > 0 then
      fail("Auctions were still arriving after " .. math.floor(GIVE_UP / 60) .. " minutes (" .. num(scan.count) .. " so far).")
    else
      fail("The server sent no auctions in " .. math.floor(GIVE_UP / 60) .. " minutes. Another addon may have asked for a full scan in the last 15 minutes.")
    end
    return
  end
  if now - scan.reported >= REPORT then
    scan.reported = now
    if scan.count > 0 then
      say("Receiving auctions: " .. num(scan.count) .. " so far.")
    else
      say(string.format("Waiting for the server... (%ds; the client holds %s auctions%s)", math.floor(now - scan.started), num(c),
        scan.base > 0 and (", " .. num(scan.base) .. " of them from an earlier scan") or ""))
    end
  end
  C_Timer.After(1, tick)
end

-- One listing. Returns false if its data is not loaded yet (try again later).
local function take(i)
  local _, _, count, _, _, _, _, _, _, buyout, _, _, _, _, _, _, itemID = C_AuctionHouse.GetReplicateItemInfo(i)
  if not itemID or not count then
    if itemID and C_Item and C_Item.RequestLoadItemDataByID then C_Item.RequestLoadItemDataByID(itemID) end
    return false
  end
  if count <= 0 then
    scan.bad = scan.bad + 1
  elseif not buyout or buyout <= 0 then
    scan.bidOnly = scan.bidOnly + 1
  else
    local t = scan.items[itemID]
    if not t then
      t = {}
      scan.items[itemID] = t
    end
    t[#t + 1] = count .. ":" .. buyout
    scan.listings = scan.listings + 1
  end
  return true
end

local function save()
  local items, nItems = {}, 0
  for id, t in pairs(scan.items) do
    items[id] = table.concat(t, ",")
    nItems = nItems + 1
  end
  local skipped = #scan.missing + scan.bad
  BavvbScanDB.scan = {
    format = "bavvbscan",
    version = 1,
    realm = GetRealmName(),
    faction = UnitFactionGroup("player"),
    time = time(),
    auctions = scan.total,
    listings = scan.listings,
    bidOnly = scan.bidOnly,
    skipped = skipped,
    items = items,
  }
  local extra = scan.bidOnly > 0 and (", " .. num(scan.bidOnly) .. " bid-only left out") or ""
  if skipped > 0 then extra = extra .. ", " .. num(skipped) .. " unreadable skipped" end
  finish()
  say("|cff40ff40Scan saved:|r " .. num(BavvbScanDB.scan.auctions) .. " auctions, " .. num(BavvbScanDB.scan.listings) .. " listings of "
    .. num(nItems) .. " items" .. extra
    .. ". /reload to write the file, then Refresh in the app.")
end

local function retry(pass)
  if not scan then return end
  if #scan.missing == 0 or pass > RETRIES then
    save()
    return
  end
  C_Timer.After(2, function()
    if not scan then return end
    local still = {}
    for _, i in ipairs(scan.missing) do
      if not take(i) then still[#still + 1] = i end
    end
    scan.missing = still
    retry(pass + 1)
  end)
end

local function readBatch(from)
  if not scan then return end
  local last = math.min(from + BATCH, scan.total) - 1
  for i = from, last do
    if not take(i) then scan.missing[#scan.missing + 1] = i end
  end
  if last + 1 < scan.total then
    C_Timer.After(0, function() readBatch(last + 1) end)
  else
    retry(1)
  end
end

read = function()
  scan.reading = true
  scan.total = C_AuctionHouse.GetNumReplicateItems() or 0
  scan.items, scan.missing = {}, {}
  scan.listings, scan.bidOnly, scan.bad = 0, 0, 0
  say("Reading " .. num(scan.total) .. " auctions...")
  readBatch(0)
end

local function status()
  local s = BavvbScanDB.scan
  if s then
    say(string.format("Last saved scan: %s, %s %s, %s listings.", date("%Y-%m-%d %H:%M", s.time), tostring(s.realm),
      tostring(s.faction), num(s.listings)))
  else
    say("No scan saved yet.")
  end
  if scan then
    say(scan.reading and "Reading the auctions now." or ("Scan in progress: " .. num(scan.count) .. " auctions received so far."))
  else
    say("Next scan allowed " .. nextScanText() .. ".")
  end
end

frame:SetScript("OnEvent", function(_, event)
  if event == "AUCTION_HOUSE_SHOW" then
    ahOpen = true
  elseif event == "AUCTION_HOUSE_CLOSED" then
    ahOpen = false
    if scan then fail("The auction house was closed before the scan finished.") end
  elseif event == "REPLICATE_ITEM_LIST_UPDATE" then
    if scan and not scan.reading then
      scan.heard = true
      scan.count = C_AuctionHouse.GetNumReplicateItems() or 0
      scan.changed = GetTime()
    end
  end
end)
frame:RegisterEvent("AUCTION_HOUSE_SHOW")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")

SLASH_BAVVBSCAN1 = "/bscan"
SLASH_BAVVBSCAN2 = "/bavvbscan"
SlashCmdList.BAVVBSCAN = function(msg)
  msg = string.lower(strtrim(msg or ""))
  if msg == "" or msg == "scan" then
    start()
  elseif msg == "status" then
    status()
  else
    say("/bscan scans the auction house (keep it open); /bscan status shows the last scan and when the next is allowed.")
  end
end
