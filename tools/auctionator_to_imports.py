"""
Auctionator -> shuffle sheet Imports converter.

Reads Auctionator's SavedVariables file (Auctionator.lua, or a .zip containing it) and writes a CSV whose
rows paste straight into the Imports tab of all_professions_by_vendor_value.xlsx (columns A-E).

  Price 1 = latest lowest buyout Auctionator saw (its current "min" price)
  Price 2 = median of the daily lowest buyouts over the last --days scan days
  Price 3 = lowest daily lowest buyout over the same window
All prices are in copper. Item names are left blank: the Imports tab matches on Item ID.

Get the file from WTF/Account/<ACCOUNT>/SavedVariables/Auctionator.lua after a scan and a /reload or logout.
Upload it zipped: the price database is a binary string, and text handling of the bare .lua corrupts it.

Run:
  python3 auctionator_to_imports.py Auctionator.zip                 # writes auctionator_imports.csv
  python3 auctionator_to_imports.py Auctionator.lua --days 7 --realm "PvE" --out prices.csv

Data model (Auctionator price database v8): per realm, a CBOR-encoded map of item key ->
{m: current min, h: {day: price}, l: {day: price}, a: {day: quantity}}. For each day, h is the highest
and l the lowest of that day's minimum-buyout readings (l is only stored when it differs from h).
Keys that are not plain item IDs (gear with item-level variants, pets) are skipped.
"""
import argparse, csv, io, re, statistics, struct, sys, zipfile

ap = argparse.ArgumentParser(description='Convert Auctionator SavedVariables to Imports-tab rows.')
ap.add_argument('src', help='Auctionator.lua or a .zip containing it')
ap.add_argument('--realm', help='realm/faction key in the price database (default: the only one, or asks)')
ap.add_argument('--days', type=int, default=7, help='scan days used for Price 2 and 3 (default 7)')
ap.add_argument('--out', default='auctionator_imports.csv')
args = ap.parse_args()

if args.src.lower().endswith('.zip'):
    z = zipfile.ZipFile(args.src)
    name = next((n for n in z.namelist() if n.lower().endswith('auctionator.lua')), None)
    if not name: sys.exit(f'No Auctionator.lua inside {args.src}: {z.namelist()}')
    raw = z.read(name)
else:
    raw = open(args.src, 'rb').read()
if b'\xef\xbf\xbd' in raw[raw.find(b'AUCTIONATOR_PRICE_DATABASE'):]:
    sys.exit('The price database contains replacement characters, so the file was converted as text somewhere. '
             'Zip the original Auctionator.lua and use the .zip.')

# ---------- pull realm strings out of AUCTIONATOR_PRICE_DATABASE ----------
start = raw.find(b'AUCTIONATOR_PRICE_DATABASE = {')
if start < 0: sys.exit('No AUCTIONATOR_PRICE_DATABASE in this file.')
ESC = {ord('a'): 7, ord('b'): 8, ord('f'): 12, ord('n'): 10, ord('r'): 13, ord('t'): 9, ord('v'): 11,
       ord('\\'): 92, ord('"'): 34, ord("'"): 39, 10: 10, 13: 10}
def lua_string(b, i):  # b[i] is the opening quote; returns (bytes, index after closing quote)
    q = b[i]; i += 1; out = bytearray()
    while True:
        c = b[i]
        if c == q: return bytes(out), i + 1
        if c != 92: out.append(c); i += 1; continue
        n = b[i + 1]
        if 48 <= n <= 57:
            m = re.match(rb'\d{1,3}', b[i + 1:i + 4]); out.append(int(m.group())); i += 1 + len(m.group())
        elif n in ESC:
            out.append(ESC[n]); i += 2
            if n == 13 and b[i:i + 1] == b'\n': i += 1
        else: sys.exit(f'Unknown escape \\{chr(n)} at byte {i}')
realms = {}; i = raw.find(b'\n', start)
while True:
    m = re.compile(rb'\s*\["((?:[^"\\]|\\.)*)"\]\s*=\s*').match(raw, i)
    if not m: break
    key = m.group(1).decode('utf8', 'replace'); j = m.end()
    if raw[j:j + 1] == b'"':
        val, j = lua_string(raw, j); realms[key] = val
    else:
        j = re.compile(rb'[^,\r\n]*').match(raw, j).end()
    i = re.compile(rb'\s*,').match(raw, j).end()
if not realms: sys.exit('Price database is empty: run a full scan, then /reload before copying the file.')
if args.realm: realm = args.realm
elif len(realms) == 1: realm = next(iter(realms))
else: sys.exit(f'Several realms in this file, pick one with --realm: {", ".join(realms)}')
if realm not in realms: sys.exit(f'Realm {realm!r} not found. Available: {", ".join(realms)}')

# ---------- minimal CBOR decoder ----------
def cbor(b, i=0):
    ib = b[i]; mt, ai = ib >> 5, ib & 31; i += 1
    if ai < 24: n = ai
    elif ai == 24: n = b[i]; i += 1
    elif ai == 25: n = struct.unpack('>H', b[i:i + 2])[0]; i += 2
    elif ai == 26: n = struct.unpack('>I', b[i:i + 4])[0]; i += 4
    elif ai == 27: n = struct.unpack('>Q', b[i:i + 8])[0]; i += 8
    else: raise ValueError(f'unsupported CBOR length at byte {i}')
    if mt == 0: return n, i
    if mt == 1: return -1 - n, i
    if mt in (2, 3): return b[i:i + n].decode('utf8', 'replace'), i + n
    if mt == 4:
        out = []
        for _ in range(n): v, i = cbor(b, i); out.append(v)
        return out, i
    if mt == 5:
        out = {}
        for _ in range(n): k, i = cbor(b, i); v, i = cbor(b, i); out[k] = v
        return out, i
    if mt == 7:
        if ai == 20: return False, i
        if ai == 21: return True, i
        if ai in (22, 23): return None, i
        if ai == 25: raise ValueError('half floats unsupported')
        if ai == 26: return struct.unpack('>f', b[i - 4:i])[0], i
        if ai == 27: return struct.unpack('>d', b[i - 8:i])[0], i
    raise ValueError(f'unsupported CBOR type {mt} at byte {i}')
db, end = cbor(realms[realm])
if end != len(realms[realm]): print(f'Warning: {len(realms[realm]) - end} trailing bytes ignored', file=sys.stderr)

# ---------- build rows ----------
rows = []; skipped = 0; days_seen = set()
for key, rec in db.items():
    if not re.fullmatch(r'\d+', str(key)) or not isinstance(rec, dict): skipped += 1; continue
    h = {int(d): p for d, p in (rec.get('h') or {}).items()}
    l = {int(d): p for d, p in (rec.get('l') or {}).items()}
    daily = {d: min(p, l.get(d, p)) for d, p in h.items()}
    days_seen |= set(daily)
    recent = [daily[d] for d in sorted(daily)[-args.days:]]
    m = rec.get('m')
    if m is None and not recent: continue
    rows.append([int(key), '', m if m is not None else recent[-1],
                 round(statistics.median(recent)) if recent else m, min(recent) if recent else m])
rows.sort()
with open(args.out, 'w', newline='') as f:
    w = csv.writer(f); w.writerow(['Item ID', 'Item name (optional)', 'Price 1 (copper)', 'Price 2 (copper)', 'Price 3 (copper)']); w.writerows(rows)
print(f'{realm}: {len(rows)} items written to {args.out}; {skipped} non-item keys skipped; '
      f'{len(days_seen)} scan day(s) in history (Price 2/3 use the last {args.days})')
