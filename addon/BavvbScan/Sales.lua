-- BavvbScan sales log: records each auction sale when its money reaches the character's gold, and each auction
-- purchase when its items reach the character's bags.
--
-- Why gold and not clicks: a mail can glitch (money taken but the mail stays, or it seems to come twice), and the
-- money can be collected by anything (by hand, Open All, TSM's mailbox). So the inbox is watched instead: when a mail
-- with money leaves the inbox (or its money goes), it waits; when the character's gold rises, the rise is matched to
-- waiting mails whose money adds up to exactly that amount; when rises can't be told apart (a big mailbox emptied
-- fast), the gold not yet matched equalling the waiting mails to the copper pays them all. Only matched auction-sale
-- mails become sales. A mail that comes back cancels its wait. Nothing is clicked, opened or sent: the addon only reads.
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
--   Purchases (2026-11-14): "Auction won" mails (invoice type "buyer"; on the Forever client the 4th value is the total
--   paid, the 5th the quantity). The gold left at the auction house, so the check is the items instead: the units
--   taken out of each won mail that reached the bags (units from other mails of the same item count first, so they
--   never vouch for a won mail). A won mail can be emptied over several visits (Josh: bags full, mail half off to
--   another character, come back for the rest): every visit records the units of it that arrived, at their share of
--   the price, and `wonCarry` remembers how much of each mail is recorded (mails told apart by subject, price,
--   quantity and expiry time, which is fixed per mail); when the mail is gone, the last part takes the rest of the
--   price, and units that never arrived are a "noitem" record. Records { kind = "buy", t, item, itemID, count (units
--   in this part), price (paid for them), status "ok" / "noitem", mailCount, mailPrice (the whole mail) }; sale records
--   carry kind = "sale" (older ones have no kind). Visits add buys (parts), spent, buyMissing.
-- Records are only added, never changed; fixes happen in the trade tracker. Records and visits older than KEEP_DAYS are
-- dropped (2026-11-14: ~0.4 KB a record would otherwise grow the file by 10-15 MB a year, slowing logins and /reload).
-- Buyer names are never read into the saved data.

local GRACE = 10     -- seconds after the mailbox closes to wait for late gold or inbox updates
local EXPIRY_SLACK = 300 -- seconds: a won mail's expiry time, worked out from its days left, matches within this
local CARRY_DAYS = 35  -- won mails expire after 30 days; older carry entries are dropped
local KEEP_DAYS = 60   -- records and visits older than this are dropped (the trade tracker has long since added them;
                       -- it ignores anything older than 70 days, so a record can't come back after it forgot it)
local MAX_SUBSET = 12 -- waiting mails tried in combinations when matching one gold rise (a rise can pay several mails)
local EVENTS_KEPT = 1000 -- mailbox events kept for diagnosis (120 until 2026-11-15: one big mailbox pushed them all out)

-- Pure part (no WoW calls), exposed for the test harness.
local Core = {}
BavvbScanSalesCore = Core

function Core.newVisit(now)
  return { t0 = now, present = {}, info = {}, pending = {}, rises = {}, goldIn = 0, goldOut = 0, confirmed = {},
    other = 0,
    -- purchases: the won mails seen this visit (in order: units in them when first seen / now, gone, what earlier
    -- visits recorded of them), and per watched item ID the units of it in other mails when first seen / now, the bag
    -- count last seen and the units that reached the bags
    buy = { mails = {}, watch = {}, otherFirst = {}, otherLast = {}, bagLast = {}, bagIn = {} } }
end

-- buyers: the won mails now in the inbox, each { sig, item, itemID, count, price, remaining (units still in it),
-- expiry (Unix time) }. totals: units per item ID in the whole inbox (all mails' attachments). carry: the saved list of
-- won mails partly recorded on earlier visits ({ sig, expiry, units, price, t }).
function Core.buyers(v, buyers, totals, now, carry)
  local b = v.buy
  b.claimed = b.claimed or {}
  local here = {}
  -- Which known mail is this listing? Same subject, price and quantity, expiry within the slack, and its units can only
  -- have gone down; one that hasn't changed first, then the closest expiry. (Identical mails bought seconds apart are
  -- interchangeable: same price and quantity.)
  local function known(m)
    local best, bestScore
    for _, y in ipairs(b.mails) do
      local d = math.abs(y.mail.expiry - m.expiry)
      if not here[y] and y.mail.sig == m.sig and d <= EXPIRY_SLACK and y.last >= m.remaining then
        local score = (y.last == m.remaining and 0 or EXPIRY_SLACK + 1) + d
        if not bestScore or score < bestScore then best, bestScore = y, score end
      end
    end
    return best
  end
  -- What earlier visits recorded of a mail: an unclaimed saved entry whose units plus the units still in the mail make
  -- the whole quantity (closest expiry first); failing that, for a mail already partly emptied only, the closest entry.
  -- An untouched mail never takes another mail's entry.
  local function savedFor(m, strict)
    local best, bestD
    for _, c in ipairs(carry or {}) do
      local d = math.abs(c.expiry - m.expiry)
      if not b.claimed[c] and c.sig == m.sig and d <= EXPIRY_SLACK and (not strict or c.units + m.remaining == m.count)
        and (not bestD or d < bestD) then best, bestD = c, d end
    end
    return best
  end
  local fresh = {}
  for _, m in ipairs(buyers) do
    local x = known(m)
    if not x then
      x = { mail = m, first = m.remaining, last = m.remaining }
      b.mails[#b.mails + 1] = x
      fresh[#fresh + 1] = x
    end
    here[x] = true
    x.last, x.gone = m.remaining, false
    if m.itemID and not x.mail.itemID then x.mail.itemID = m.itemID end
    if x.mail.itemID then b.watch[x.mail.itemID] = true end
  end
  for pass = 1, 2 do
    for _, x in ipairs(fresh) do
      if not x.carry and (pass == 1 or x.first < x.mail.count) then
        local c = savedFor({ sig = x.mail.sig, expiry = x.mail.expiry, remaining = x.first, count = x.mail.count }, pass == 1)
        if c then x.carry, b.claimed[c] = c, true end
      end
    end
  end
  for _, y in ipairs(b.mails) do
    if not here[y] then y.gone = true end
  end
  for id in pairs(b.watch) do
    local won = 0
    for _, y in ipairs(b.mails) do
      if here[y] and y.mail.itemID == id then won = won + y.last end
    end
    local other = math.max(0, (totals[id] or 0) - won)
    if b.otherFirst[id] == nil then b.otherFirst[id] = other end
    b.otherLast[id] = other
  end
end

-- The item IDs whose bag counts matter (items of won mails seen this visit).
function Core.watched(v)
  local ids = {}
  for id in pairs(v.buy.watch) do ids[#ids + 1] = id end
  return ids
end

-- counts: bag count per watched item ID now. Only rises count (items can also leave the bags, e.g. sent by mail).
function Core.bags(v, counts)
  local b = v.buy
  for id, n in pairs(counts) do
    local last = b.bagLast[id]
    if last and n > last then b.bagIn[id] = (b.bagIn[id] or 0) + (n - last) end
    b.bagLast[id] = n
  end
end

-- Per won mail seen this visit: the units of it that arrived (give), whether it is gone (final), and what earlier
-- visits recorded of it (before, beforePrice). Units that reached the bags are shared out to the won mails of that
-- item in order, after the units that left other mails of the item.
function Core.buyResult(v)
  local b = v.buy
  local avail = {}
  local out = {}
  for _, x in ipairs(b.mails) do
    local id = x.mail.itemID
    if id and avail[id] == nil then
      local fromOthers = math.max(0, (b.otherFirst[id] or 0) - (b.otherLast[id] or 0))
      avail[id] = math.max(0, (b.bagIn[id] or 0) - fromOthers)
    end
    local taken = math.max(0, x.first - (x.gone and 0 or x.last))
    local give = id and math.min(taken, avail[id]) or 0
    if id then avail[id] = avail[id] - give end
    out[#out + 1] = { x = x, mail = x.mail, give = give, final = x.gone == true,
      before = x.carry and x.carry.units or 0, beforePrice = x.carry and x.carry.price or 0 }
  end
  return out
end

-- The purchase records of one result (a part that arrived, and for a mail now gone the units that never did), and the
-- figures for the visit. Pure.
local function buyParts(r, at)
  local m = r.mail
  local parts = {}
  local done = r.before + r.give
  local partPrice = 0
  if r.give > 0 then
    if r.final and done >= m.count then partPrice = m.price - r.beforePrice
    else partPrice = math.floor(m.price * r.give / m.count + 0.5) end
    parts[#parts + 1] = { kind = "buy", t = at, item = m.item, itemID = m.itemID, count = r.give, price = partPrice,
      status = "ok", mailCount = m.count, mailPrice = m.price }
  end
  if r.final and done < m.count then
    parts[#parts + 1] = { kind = "buy", t = at, item = m.item, itemID = m.itemID, count = m.count - done,
      price = m.price - r.beforePrice - partPrice, status = "noitem", mailCount = m.count, mailPrice = m.price }
  end
  return parts, partPrice
end

-- The subset of v.pending whose money sums to amount, as a list of indexes: one mail of exactly that amount (any of
-- them, earliest first), else all of them, else a combination of the first MAX_SUBSET (earliest preferred).
local function subset(pending, amount)
  local all, sum = {}, 0
  for i = 1, #pending do all[i] = i; sum = sum + pending[i].mail.money end
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
  for i = 1, #pending do
    if pending[i].mail.money == amount then return { i } end
  end
  if #pending > 0 and sum == amount then return all end
  if dfs(1, amount) then return pick end
  return nil
end

local function take(v, p, now)
  if p.mail.kind == "seller" then
    v.confirmed[#v.confirmed + 1] = { mail = p.mail, at = now }
  else
    v.other = v.other + p.mail.money
  end
end

local function match(v, now)
  local i = 1
  while i <= #v.rises do
    local pick = subset(v.pending, v.rises[i].amount)
    if pick then
      table.sort(pick, function(a, b) return a > b end)
      local got = {}
      for _, k in ipairs(pick) do got[#got + 1] = table.remove(v.pending, k) end
      for k = #got, 1, -1 do take(v, got[k], now) end
      table.remove(v.rises, i)
    else
      i = i + 1
    end
  end
  -- The gold not yet matched equals the waiting mails to the copper: they are all paid, even if no single rise could be
  -- told apart (2026-11-15: 58 sale mails emptied in 6 s on Xfaction, none matched rise by rise, the gold all there).
  local risen, owed = 0, 0
  for _, r in ipairs(v.rises) do risen = risen + r.amount end
  for _, p in ipairs(v.pending) do owed = owed + p.mail.money end
  if #v.rises > 0 and #v.pending > 0 and risen == owed then
    for _, p in ipairs(v.pending) do take(v, p, now) end
    v.pending, v.rises = {}, {}
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
  local leaving, arriving = {}, {}
  for sig, n in pairs(v.present) do
    for _ = 1, n - (counts[sig] or 0) do leaving[#leaving + 1] = sig end
  end
  for sig, n in pairs(counts) do
    for _ = 1, n - (v.present[sig] or 0) do arriving[#arriving + 1] = sig end
  end
  -- A mail first read before its subject and sale details loaded has another sig ("nil|<money>", kind "other"); when
  -- they load it seems to leave and a new mail to arrive in the same read. Same money = the same mail, not a departure
  -- (2026-11-15: 4 sale mails on Xria Two waited twice, the gold went to the "other" copy, the sales got no gold).
  for i = #leaving, 1, -1 do
    local old = v.info[leaving[i]]
    if old and old.src ~= "invoice" then
      for j = #arriving, 1, -1 do
        if v.info[arriving[j]].money == old.money and arriving[j] ~= leaving[i] then
          table.remove(leaving, i)
          table.remove(arriving, j)
          break
        end
      end
    end
  end
  for _, sig in ipairs(leaving) do
    v.pending[#v.pending + 1] = { mail = v.info[sig], at = now }
  end
  for _, sig in ipairs(arriving) do
    -- A mail that comes back (a refresh that briefly dropped it) cancels its wait.
    for k = #v.pending, 1, -1 do
      if v.pending[k].mail.sig == sig then
        table.remove(v.pending, k)
        break
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

-- Ends a visit: returns the records (without ids) and the visit summary. carry (the saved list of partly recorded won
-- mails) is updated in place.
function Core.finish(v, now, carry)
  local out = {}
  local function add(mail, at, status)
    local received = mail.money - (mail.deposit or 0)
    out[#out + 1] = { kind = "sale", t = at, item = mail.item, count = mail.count, price = mail.price,
      deposit = mail.deposit, cut = mail.cut, money = mail.money, received = received, status = status, src = mail.src }
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
  local buys, spent, buyMissing = 0, 0, 0
  for _, r in ipairs(Core.buyResult(v)) do
    local parts, partPrice = buyParts(r, now)
    for _, part in ipairs(parts) do
      out[#out + 1] = part
      if part.status == "ok" then buys, spent = buys + 1, spent + part.price else buyMissing = buyMissing + 1 end
    end
    -- What is recorded of a mail still in the inbox is remembered for the next visit; a gone mail is forgotten.
    if carry then
      local c = r.x.carry
      if r.final then
        if c then for k = #carry, 1, -1 do if carry[k] == c then table.remove(carry, k) end end end
      elseif r.give > 0 then
        if not c then
          c = { sig = r.mail.sig, expiry = r.mail.expiry, units = 0, price = 0, item = r.mail.item }
          carry[#carry + 1] = c
          r.x.carry = c
        end
        c.units, c.price, c.t = c.units + r.give, c.price + partPrice, now
      end
    end
  end
  if carry then
    for k = #carry, 1, -1 do
      if carry[k].t and now - carry[k].t > CARRY_DAYS * 86400 then table.remove(carry, k) end
    end
  end
  return out, { t0 = v.t0, t1 = now, goldIn = v.goldIn, goldOut = v.goldOut, sales = sales, received = received,
    deposits = deposits, other = v.other, unexplained = unexplained, missing = missing, buys = buys, spent = spent,
    buyMissing = buyMissing }
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

local function attachmentID(i, a)
  local link = GetInboxItemLink and GetInboxItemLink(i, a)
  local id = link and tonumber(link:match("item:(%d+)"))
  if id then return id end
  local _, second = GetInboxItem(i, a)
  return type(second) == "number" and second or nil
end

-- The inbox in the Core's shape: money mails, won mails, and units per item ID over all attachments. Only items,
-- counts and amounts are kept: never the buyer or sender.
local function readInbox()
  local list, buyers, totals = {}, {}, {}
  for i = 1, GetInboxNumItems() do
    local _, _, _, subject, money, _, daysLeft, hasItem = GetInboxHeaderInfo(i)
    local firstID
    local units = 0 -- this mail's units of its first item (a won mail holds one item)
    if type(hasItem) == "number" and hasItem > 0 then
      for a = 1, (ATTACHMENTS_MAX_RECEIVE or 16) do
        local _, _, _, n = GetInboxItem(i, a)
        local id = n and attachmentID(i, a)
        if id then
          totals[id] = (totals[id] or 0) + n
          firstID = firstID or id
          if id == firstID then units = units + n end
        end
      end
    end
    local t, item, _, bid, c5, _, _, _, _, _, c11 = GetInboxInvoiceInfo(i)
    if t == "buyer" and item then
      local count = (type(c11) == "number" and c11 > 0 and c11) or (type(c5) == "number" and c5 > 0 and c5) or 1
      local remaining = 0
      if firstID then remaining = units end
      buyers[#buyers + 1] = { sig = "B|" .. tostring(subject) .. "|" .. tostring(bid) .. "|" .. count, item = item,
        itemID = firstID, count = count, price = bid or 0, remaining = remaining,
        expiry = math.floor(time() + (tonumber(daysLeft) or 0) * 86400 + 0.5) }
    end
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
  return list, buyers, totals
end

local function itemCount(id)
  if C_Item and C_Item.GetItemCount then return C_Item.GetItemCount(id, false, false, false, false) or 0 end
  return GetItemCount(id) or 0
end

local function readBags(v)
  local counts = {}
  for _, id in ipairs(Core.watched(v)) do counts[id] = itemCount(id) end
  Core.bags(v, counts)
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
  p.buys, p.spent, p.buyWaiting = 0, 0, 0
  for _, r in ipairs(Core.buyResult(v)) do
    local parts = buyParts(r, 0)
    for _, part in ipairs(parts) do
      if part.status == "ok" then p.buys, p.spent = p.buys + 1, p.spent + part.price else p.buyWaiting = p.buyWaiting + 1 end
    end
  end
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
  if (x.buyMissing or 0) > 0 then
    out[#out + 1] = plural(x.buyMissing, "won mail") .. " left without " .. (x.buyMissing == 1 and "its" or "their")
      .. " items reaching your bags"
  end
  return out
end

-- The chat line after a mailbox visit: sales, gold, and either "everything matches", "waiting for ..." or the problems.
-- (A popup with a Reload button showed the same until 2026-11-14; Josh dropped it: logging off saves the file too.)
local function reportLine(x)
  local parts = {}
  if x.sales > 0 or (x.buys or 0) == 0 then parts[#parts + 1] = plural(x.sales, "sale") .. " (" .. coins(x.received) .. ")" end
  if (x.buys or 0) > 0 then parts[#parts + 1] = plural(x.buys, "purchase") .. " (" .. coins(x.spent) .. ")" end
  local line = table.concat(parts, ", ") .. " recorded"
  local issues = issuesOf(x)
  if #issues > 0 then
    return line .. ". |cffffb000Check in the tracker: " .. table.concat(issues, "; ") .. "|r"
  end
  local waits = {}
  if (x.waiting or 0) > 0 then waits[#waits + 1] = "the gold of " .. plural(x.waiting, "mail") end
  if (x.buyWaiting or 0) > 0 then waits[#waits + 1] = "the items of " .. plural(x.buyWaiting, "won mail") end
  if #waits > 0 then
    return line .. ", |cffffff80waiting for " .. table.concat(waits, " and ") .. "...|r"
  end
  return line .. ", everything matches |cff40ff40(OK)|r"
end

local function hasNews(x)
  return x.sales > 0 or (x.missing or 0) > 0 or (x.unexplained or 0) > 0 or (x.waiting or 0) > 0 or (x.buys or 0) > 0
    or (x.buyMissing or 0) > 0 or (x.buyWaiting or 0) > 0
end

-- The character's name as shown in game. On Forever the short name (UnitName) is only the first word, so "Xria Two",
-- "Xria Forever" and "Xria Blacksmith" are all "Xria" (2026-11-14); records also carry the character's GUID, which is
-- unique. The second word is taken from UnitFullName when it isn't just the server's realm; otherwise the short name.
local function fullName()
  local name = UnitName("player")
  local n, r = nil, nil
  if UnitFullName then n, r = UnitFullName("player") end
  local realm = (GetNormalizedRealmName and GetNormalizedRealmName()) or (GetRealmName() or ""):gsub("[%s%-]", "")
  if n and r and r ~= "" and r ~= realm then return n .. " " .. r end
  local g = GetUnitName and GetUnitName("player", true)
  if type(g) == "string" and g ~= name and not g:find(realm, 1, true) then return (g:gsub("%-", " ")) end
  return name
end

-- Drops records and visits older than KEEP_DAYS (on every save and at logout, so even a character that hasn't visited a
-- mailbox for months writes a trimmed file).
function Core.prune(s, now)
  local cut = now - KEEP_DAYS * 86400
  local function keep(list, field)
    local out = {}
    for _, x in ipairs(list or {}) do if (x[field] or 0) >= cut then out[#out + 1] = x end end
    return out
  end
  s.records = keep(s.records, "t")
  s.visits = keep(s.visits, "t0")
end

local function save(v, now)
  local s0 = db()
  s0.wonCarry = s0.wonCarry or {}
  local records, summary = Core.finish(v, now, s0.wonCarry)
  if #records == 0 and summary.goldIn == 0 then return end -- no money came in (e.g. only postage paid): keep no visit
  local s = db()
  local who = {
    char = UnitName("player"), realm = GetRealmName(), faction = UnitFactionGroup("player"),
    guid = UnitGUID and UnitGUID("player"), full = fullName(),
  }
  local vid = who.char .. "-" .. v.t0 .. "-" .. s.next
  s.next = s.next + 1
  summary.id, summary.char, summary.realm, summary.faction = vid, who.char, who.realm, who.faction
  summary.guid, summary.full = who.guid, who.full
  s.visits[#s.visits + 1] = summary
  for _, r in ipairs(records) do
    r.id = who.char .. "-" .. r.t .. "-" .. s.next
    s.next = s.next + 1
    r.char, r.realm, r.faction, r.visit = who.char, who.realm, who.faction, vid
    r.guid, r.full = who.guid, who.full
    s.records[#s.records + 1] = r
  end
  Core.prune(s, now)
  -- Chat: once when the mailbox closed (the preview); again only if the final result differs from it.
  local final = reportLine(summary)
  if hasNews(summary) and final ~= v.reported then say(final) end
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
    local live = Core.preview(visit)
    if hasNews(live) then
      visit.reported = reportLine(live)
      say(visit.reported)
    end
    local token = {}
    closing = token
    C_Timer.After(GRACE, function()
      if closing == token then finishVisit() end
    end)
  end
end

-- Diagnostics: the last EVENTS_KEPT mailbox-related events (name, time, mails in the inbox, gold, visit open), saved with
-- the log so a visit that goes wrong can be read back from the file. No mail contents.
local function note(event, arg)
  local s = db()
  s.events = s.events or {}
  local n = GetInboxNumItems and GetInboxNumItems() or -1
  s.events[#s.events + 1] = string.format("%d %s %s n=%d m=%d v=%s c=%s", time(), event, tostring(arg), n, GetMoney(),
    visit and "1" or "0", closing and "1" or "0")
  while #s.events > EVENTS_KEPT do table.remove(s.events, 1) end
end

-- Which characters record their mail (Josh, 2026-11-14: the report showed on all his other characters). By default only
-- his four trading characters; `/bscan mail on` / `off` changes it for the character playing (saved per account, by
-- GUID, in BavvbScanDB.mailChars).
local TRADERS = {
  ["Player-6925-03AADB1A"] = "Xfaction Bavvb",
  ["Player-6925-037750ED"] = "Jeder Hillmont",
  ["Player-6921-0306E8F7"] = "Horde Xria",
  ["Player-6921-0308022D"] = "Xria Two",
}
function Core.recording(guid, choices)
  local c = choices and guid and choices[guid]
  if c ~= nil then return c end
  return guid ~= nil and TRADERS[guid] ~= nil
end
local function recording()
  return Core.recording(UnitGUID and UnitGUID("player"), BavvbScanDB and BavvbScanDB.mailChars)
end

frame:SetScript("OnEvent", function(_, event, arg)
  -- A character that doesn't record: no visits, no chat; only the gold baseline is kept.
  if not recording() and not visit then
    if event == "PLAYER_LOGIN" or event == "PLAYER_ENTERING_WORLD" or event == "PLAYER_MONEY" then lastMoney = GetMoney() end
    if event == "PLAYER_LOGOUT" and BavvbScanDB and BavvbScanDB.sales then Core.prune(BavvbScanDB.sales, time()) end
    return
  end
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
    if visit and not closing then
      local list, buyers, totals = readInbox()
      Core.buyers(visit, buyers, totals, time(), db().wonCarry)
      readBags(visit) -- new watched items get their baseline before any are taken
      Core.inbox(visit, list, time())
    end
  elseif event == "BAG_UPDATE_DELAYED" then
    if visit then readBags(visit) end
  elseif event == "PLAYER_MONEY" then
    local now = GetMoney()
    if visit and lastMoney then Core.money(visit, now - lastMoney, time()) end
    lastMoney = now
  elseif event == "PLAYER_LOGOUT" then
    finishVisit() -- a /reload or logout with the mailbox open still saves what was matched
    if BavvbScanDB and BavvbScanDB.sales then Core.prune(BavvbScanDB.sales, time()) end
  end
end)
for _, e in ipairs({ "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "MAIL_SHOW", "MAIL_INBOX_UPDATE", "PLAYER_MONEY",
  "MAIL_CLOSED", "PLAYER_LOGOUT", "PLAYER_INTERACTION_MANAGER_FRAME_SHOW", "PLAYER_INTERACTION_MANAGER_FRAME_HIDE", "BAG_UPDATE_DELAYED" }) do
  pcall(frame.RegisterEvent, frame, e) -- an event this client doesn't know is skipped
end

-- /bscan sales: the last few sales and the last mailbox check.
-- /bscan mail [on|off]: whether this character records its mail.
function BavvbScanMailSwitch(arg)
  local guid = UnitGUID and UnitGUID("player")
  if arg == "on" or arg == "off" then
    BavvbScanDB = BavvbScanDB or {}
    BavvbScanDB.mailChars = BavvbScanDB.mailChars or {}
    BavvbScanDB.mailChars[guid] = (arg == "on")
  end
  if recording() then
    say("This character records its auction mail (sales and purchases). /bscan mail off to stop.")
  else
    say("This character doesn't record its auction mail. /bscan mail on to start.")
  end
end

function BavvbScanSalesStatus()
  local s = db()
  local n = #s.records
  if n == 0 then
    say("Nothing recorded yet. Sales and purchases are recorded when you collect them at a mailbox.")
    return
  end
  say(n .. " sales and purchases recorded. Latest:")
  for i = n, math.max(1, n - 4), -1 do
    local r = s.records[i]
    local buy = r.kind == "buy"
    local flag = r.status == "ok" and "" or (buy and "  |cffffb000(items not seen)|r" or "  |cffffb000(no gold seen)|r")
    say(string.format("  %s  %s %s x%d  %s%s", date("%m-%d %H:%M", r.t), buy and "bought" or "sold", tostring(r.item),
      r.count or 1, coins((buy and r.price or r.received) or 0), flag))
  end
  local v = s.visits[#s.visits]
  if v then
    local ok = v.missing == 0 and v.unexplained == 0 and (v.buyMissing or 0) == 0
    say(string.format("Last mailbox visit %s (%s): %d sales, %d purchases, gold in %s%s", date("%m-%d %H:%M", v.t0),
      tostring(v.char), v.sales, v.buys or 0, coins(v.goldIn), ok and " |cff40ff40(OK)|r" or " |cffffb000check in the tracker|r"))
  end
end
