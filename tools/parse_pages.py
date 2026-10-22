"""
Parse saved Wowhead Forever profession pages into app/public/game-data.json.

Game facts only: recipes (profession, skill, product, quantity made, reagents) and the items they touch
(name, vendor sell price, vendor buy price, and for crafted items quality, class and item level).
No economics, no prices from any market, and never Wowhead auction-house data: item fields are read
from a whitelist, so avgbuyout and similar fields on the page are never copied.

Input:  data/private/pages/*.html, one per profession, saved with Ctrl+S -> "Webpage, HTML only".
        Filenames are matched loosely: anything whose name starts with the profession name.
Output: app/public/game-data.json (committed; this is what the site serves)

Run:
  python3 tools/parse_pages.py
  python3 tools/parse_pages.py --pages DIR --out PATH
Prints a summary and, when an older game-data.json exists, what changed (recipes added, removed, changed).

Parsing rules match build_forever_shuffle_sheet.py v2.5:
  * only recipes that create an item; a recipe whose product has no item data at all is skipped (warned)
  * creates = [item, min, max]; Wowhead writes 0 for single-item crafts on some recipes, so min/max of 0 means 1
  * crafted-item quality, class and level come from the page's crafted-items list (needed for disenchant bands)
"""
import argparse, glob, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('--pages', default=os.path.join(ROOT, 'data', 'private', 'pages'))
ap.add_argument('--out', default=os.path.join(ROOT, 'app', 'public', 'game-data.json'))
args = ap.parse_args()

PROFS = ['Tailoring', 'Leatherworking', 'Blacksmithing', 'Engineering', 'Enchanting', 'Alchemy', 'First Aid', 'Cooking', 'Mining']
dec = json.JSONDecoder(); norm = lambda s: re.sub(r'[^a-z]', '', s.lower()); warnings = []

def find_page(prof):
    c = [f for f in glob.glob(os.path.join(args.pages, '*')) if f.lower().endswith(('.html', '.htm'))
         and norm(os.path.basename(f)).startswith(norm(prof))]
    c.sort(key=os.path.getmtime, reverse=True)
    if len(c) > 1: warnings.append(f'{prof}: {len(c)} matching files, used newest ({os.path.basename(c[0])})')
    return c[0] if c else None
pages = {p: find_page(p) for p in PROFS}
if any(v is None for v in pages.values()):
    sys.exit(f'Missing saved page(s) for: {", ".join(p for p, v in pages.items() if v is None)} in {args.pages}')

def listview(s, lid):
    for q in ('"', "'"):
        i = s.find(f'id: {q}{lid}{q}')
        if i >= 0: return dec.raw_decode(s, s.find('data: ', i) + 6)[0]
    return None

raw_items, crafted, recipes = {}, {}, []
for prof, path in pages.items():
    s = open(path, encoding='utf8', errors='replace').read()
    for m in re.finditer(r'WH\.Gatherer\.addData\(3, 16, ', s):
        for k, v in dec.raw_decode(s, m.end())[0].items(): raw_items.setdefault(int(k), v)
    R = listview(s, 'recipes')
    if R is None: sys.exit(f'{os.path.basename(path)}: no recipe data. Was it saved as "Webpage, HTML only" after the page fully loaded?')
    ci = listview(s, 'crafted-items')
    if ci is None: warnings.append(f'{prof}: no crafted-items list; nothing from it will be disenchantable')
    for c in ci or []: crafted.setdefault(c['id'], c)
    for r in R:
        if r.get('creates'): recipes.append((prof, r))

def item_fields(i):  # whitelist: never copy avgbuyout or any other market field
    v = raw_items.get(i, {}); je = v.get('jsonequip') or {}
    d = {'id': i, 'name': v.get('name_enus') or f'Item {i}'}
    if je.get('sellprice') is not None: d['sell'] = je['sellprice']
    if je.get('buyprice') is not None: d['buy'] = je['buyprice']
    c = crafted.get(i)
    if c:
        for src, dst in (('quality', 'quality'), ('classs', 'class'), ('level', 'ilvl')):
            if c.get(src) is not None: d[dst] = c[src]
    return d

out_recipes, used = [], set()
for prof, r in recipes:
    cr = r['creates']; pid = cr[0]
    if pid not in raw_items and pid not in crafted:
        warnings.append(f'{prof}: {r.get("name")} creates item {pid}, which has no item data on the page; skipped'); continue
    lo = cr[1] if len(cr) > 1 and cr[1] else 1
    hi = max(cr[2] if len(cr) > 2 and cr[2] else lo, lo)
    reag = [{'item': i, 'qty': n} for i, n in r.get('reagents', [])]
    out_recipes.append({'id': r['id'], 'name': r['name'], 'profession': prof, 'skill': r.get('learnedat'),
                        'product': pid, 'qtyMin': lo, 'qtyMax': hi, 'reagents': reag})
    used.add(pid); used.update(x['item'] for x in reag)
# reagents of reagents are covered because every recipe's reagents are listed; DE materials come from config
items = {str(i): item_fields(i) for i in sorted(used)}
data = {'source': 'Wowhead Forever profession pages (game data only)', 'professions': PROFS,
        'recipes': sorted(out_recipes, key=lambda x: (x['profession'], x['name'], x['id'])), 'items': items}

old = None
if os.path.exists(args.out):
    try: old = json.load(open(args.out))
    except ValueError: pass
os.makedirs(os.path.dirname(args.out), exist_ok=True)
json.dump(data, open(args.out, 'w'), separators=(',', ':'), sort_keys=True)
print(f'{len(out_recipes)} recipes, {len(items)} items -> {os.path.relpath(args.out, ROOT)} ({os.path.getsize(args.out) // 1024} KB)')
if old:
    O = {r['id']: r for r in old['recipes']}; N = {r['id']: r for r in data['recipes']}
    nm = lambda d, r: f'{r["profession"]}: {r["name"]}'
    for k in sorted(N.keys() - O.keys()): print('  +', nm(data, N[k]))
    for k in sorted(O.keys() - N.keys()): print('  -', nm(old, O[k]))
    for k in sorted(N.keys() & O.keys()):
        if N[k] != O[k]: print('  ~', nm(data, N[k]), '|', ', '.join(f for f in N[k] if N[k][f] != O[k].get(f)))
    oi, ni = old['items'], data['items']
    ch = [ni[k]['name'] for k in ni.keys() & oi.keys() if ni[k] != oi[k]]
    if ch: print(f'  items changed ({len(ch)}): {", ".join(sorted(ch)[:30])}{" ..." if len(ch) > 30 else ""}')
for w in warnings: print('WARNING:', w)
