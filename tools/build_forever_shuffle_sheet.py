"""
WoW Forever shuffle sheet builder.

Rebuilds the shuffle workbook from saved Wowhead Forever profession pages.

Inputs: one saved page per profession in the uploads folder for
  Tailoring, Leatherworking, Blacksmithing, Engineering, Enchanting, Alchemy, First Aid, Cooking,
  Mining (for smelting recipes)
  (save each page in a browser with Ctrl+S -> "Webpage, HTML only").
  Filenames are matched loosely: any .html/.htm whose name starts with the profession name works,
  e.g. "Tailoring_-_Skill_-_Forever.html", "Tailoring - Skill - Forever.html", "tailoring.html".

Run:
  python3 build_forever_shuffle_sheet.py                                  # fresh build
  python3 build_forever_shuffle_sheet.py --carry-over OLD.xlsx            # rebuild keeping your edits
  python3 build_forever_shuffle_sheet.py --uploads DIR --out PATH ...     # override folders
Deliver the file as built (Google Sheets recalculates on upload). Recalculating a copy with LibreOffice is useful for
checking values, but LibreOffice before 24.8 has no SORT/FILTER, so the Sorted view only works in Google Sheets.

--carry-over copies from the old workbook:
  * Reagent Prices: typed Gold/Silver/Copper, and any edits to the Vendor buy price column (matched by item name).
    Wowhead lists a nominal buy price for many items nobody sells (herbs, leather, dust), so the vendor
    buy column is curated by hand: blank it for anything not sold by a vendor. New items that arrive
    with a buy price are listed in the output so you can check them.
  * Imports: every pasted row (columns A-E)
  * Settings: every value in column B (matched by setting name), including an edited multiplier formula
    and the per-profession chain toggles. Settings added since the old workbook was built start at their defaults.
  * DE Table: all blue input cells, item-level ranges and notes (matched by band name), plus any bands
    you added. These are applied BEFORE recipes are assigned to bands, so edited level ranges take effect.
  * Intermediates: the "Allow crafting?" column (matched by item name).
  * Recipes: the "Use chains?" column, matched by the hidden Recipe ID column (Wowhead's recipe spell ID), which
    tells apart recipes that share a name. A workbook from before Recipe ID existed falls back to profession +
    name, paired in page order, and the build lists any same-name recipes matched that way.
  * Chain view: the selected recipe.
  * Sorted view: the dropdown choices and minimum profit.
It also prints a summary of what changed in the recipe data between the old and new workbook.

Design (agreed with Josh): single Recipes tab with filter columns; full-coverage profits;
reagent cost order typed > vendor buy > imported; DE values use typed > imported;
editable DE Table (Classic item-level bands); Salvager settings; Imports tab for TSM data.
Expected DE value is net of the auction house cut (Settings, default 5%), since DE materials are sold
on the AH; the vendor exit has no cut. Deposits are not modeled.
Chains (upstream make-vs-buy only): every reagent that some recipe creates gets a row on the Intermediates
tab. Its best cost is the lower of its buy price (the normal reagent cost) and its craft cost, where craft
cost prices each sub-reagent at ITS best cost, so chains of any depth resolve. Rows reference each other
directly by cell (no ranges), so there are no circular references; any loop in the recipe graph is broken
by pricing that one reagent at its buy price, and the build lists where. Crafting only counts when the
profession is switched on in Settings and the row's "Allow crafting?" is Yes. Recipes whose name starts
with "Transmute", and Mooncloth, are cooldown crafts and default to "Allow crafting? = No".
No minimum-savings threshold: crafting wins whenever it is strictly cheaper.
Per recipe, "Use chains? = No" on Recipes makes that recipe buy every reagent (cheapest path = buy all).
Downstream chains (DE output into Enchanting crafts) are deliberately not modeled: those crafts are their
own Recipes rows priced at market. Recipes keeps "Your reagent cost (buy all)" as a baseline next to
"Reagent cost (cheapest path)"; all profit columns use the cheapest path.
Chain view tab: pick a recipe, see each reagent and one level of sub-reagents with buy vs craft.
Links: craftable item names on Intermediates and Chain view are HYPERLINK formulas to their Intermediates row.
Excel/LibreOffice work as built; Google Sheets needs the Intermediates tab ID pasted into Settings after each
upload (Sheets addresses tabs by an ID assigned at upload). Recipes and Reagent Prices have no links, because
carry-over reads those cells as text.
Recipes view: panes frozen through Skill req (D2); two collapsible column groups, saved expanded:
vendor detail (Profit vendoring stays visible) and item/DE info (Expected DE value stays visible).
Profit vendoring separates the groups because adjacent groups at the same level merge into one.
No Wowhead auction-house data is used anywhere (only item sellprice/buyprice game data).

Speed (v2.3): sorting Recipes is slow because every row carries lookup formulas and a sort moves and recalculates
all of them, so sorting lives on the Sorted view tab instead: one SORT(FILTER()) formula (Google Sheets syntax) over the visible Recipes
columns, driven by dropdowns. Recipes stays in build order and can still be filtered. To keep Recipes light, the
build writes everything it already knows as plain values: each reagent's quantity and name, the reagent count,
and the DE-exit columns of recipes that cannot be disenchanted. Empty reagent slots hold nothing, and "Best price"
and "Source" only look up the Intermediates tab for reagents that are craftable. The DE Table computes each band's
value per disenchant once (calculated gray columns), and Recipes reads it through one band lookup per row.
Price lookups stay matched by item name, so sorting Reagent Prices or Intermediates never breaks them.
Sorted view has the same frozen columns (through Skill req) and the same two collapsible column groups as Recipes.
Intermediates shows each row's profession toggle; a toggle missing from Settings is flagged in red and treated as Yes.

AH exit (v2.5): a third exit, selling the crafted item on the auction house. Every crafted product gets a row on
Reagent Prices (Used as: Product), priced typed > imported, never vendor (the "Price used for selling" column, which
also prices DE materials). Product-only rows have no vendor buy price, so they never appear in the "new items with a
buy price" check. Recipes: AH price (each) and its source sit in a third collapsible group; AH value per craft
(price x qty made, minus the AH cut) stays visible, followed by Profit selling on AH and AH beats reagents?.
One AH cut setting ("AH cut on sales", default 5%) applies to DE materials and crafted items alike; a workbook
with the old setting name carries its value over. Best exit is the highest-value priced exit (ties: Vendor,
then Disenchant, then AH), and names any applicable exit that is still unpriced, e.g. "Vendor (AH unpriced)".
Profit at best exit is the highest priced exit value minus the cheapest path. AH uses the imported price column
chosen in Settings (default 1 = market price); liquidity is not modeled. BoP crafted items cannot be listed, but
the pages do not say which those are, so they simply show AH unpriced unless you type a price.
Recipes that create an item with no vendor sell price and no disenchant band are now included (their only exit is
the AH); earlier versions skipped them.
"""
VERSION = '2.5'
import argparse, glob, json, os, re, sys, zipfile
from collections import defaultdict
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter as CL
from openpyxl.formatting.rule import CellIsRule, FormulaRule
from openpyxl.comments import Comment
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.formula import ArrayFormula

ap = argparse.ArgumentParser(description='Build the WoW Forever shuffle sheet.')
ap.add_argument('--uploads', default='/mnt/user-data/uploads/', help='folder containing the saved profession pages')
ap.add_argument('--out', default=f'/mnt/user-data/outputs/Vendor_DE_Master_Sheet_v{VERSION}.xlsx')
ap.add_argument('--carry-over', dest='carry', default=None, help='previous workbook to copy your edits from')
args = ap.parse_args()

dec = json.JSONDecoder()
G = '0"g "00"s "00"c";-0"g "00"s "00"c"'
A = Font(name='Arial'); HB = Font(name='Arial', bold=True, color='FFFFFF'); HF = PatternFill('solid', start_color='305496')
GRAY = PatternFill('solid', start_color='808080'); Y = PatternFill('solid', start_color='FFFF00'); BL = Font(name='Arial', color='0000FF')
LINK = Font(name='Arial', color='0563C1', underline='single'); GREENF = PatternFill('solid', start_color='C6EFCE')
PROFS = ['Tailoring', 'Leatherworking', 'Blacksmithing', 'Engineering', 'Enchanting', 'Alchemy', 'First_Aid', 'Cooking', 'Mining']
TOGGLE = 'Chains: craft with '
warnings = []
norm = lambda s: re.sub(r'[^a-z]', '', s.lower())
lit = lambda v: v.text if isinstance(v, ArrayFormula) else v  # Excel may re-save formulas as array formulas
EXCL = lambda r: r['name'].startswith('Transmute') or r['name'] == 'Mooncloth'  # cooldown crafts

# ---------- locate input pages (loose filename matching) ----------
def find_page(prof):
    key = norm(prof)
    cands = [f for f in glob.glob(os.path.join(args.uploads, '*'))
             if f.lower().endswith(('.html', '.htm')) and norm(os.path.basename(f)).startswith(key)]
    if not cands: return None
    cands.sort(key=os.path.getmtime, reverse=True)
    if len(cands) > 1:
        warnings.append(f'{prof}: {len(cands)} matching files, used newest ({os.path.basename(cands[0])})')
    return cands[0]
pages = {p: find_page(p) for p in PROFS}
missing = [p for p, f in pages.items() if not f]
if missing:
    present = [os.path.basename(f) for f in glob.glob(os.path.join(args.uploads, '*'))]
    sys.exit(f'Missing saved page(s) for: {", ".join(m.replace("_", " ") for m in missing)}\n'
             f'Files in {args.uploads}: {present or "(none)"}')

items = {}; recs = []
for p in PROFS:
    s = open(pages[p], encoding='utf8', errors='replace').read()
    for m in re.finditer(r'WH\.Gatherer\.addData\(3, 16, ', s):
        d, _ = dec.raw_decode(s, m.end())
        for k, v in d.items(): items.setdefault(k, v)
    bad = (f'{os.path.basename(pages[p])}: could not find the recipe data. '
           'Was it saved as "Webpage, HTML only" after the page fully loaded?')
    try:
        i = s.find('id: "recipes"')
        if i < 0: sys.exit(bad)
        R, _ = dec.raw_decode(s, s.find('data: ', i) + 6)
        i = s.find("id: 'crafted-items'")  # optional: some pages may not have this tab
        if i >= 0: ci, _ = dec.raw_decode(s, s.find('data: ', i) + 6)
        else:
            ci = []
            warnings.append(f'{p.replace("_", " ")}: no crafted-items list on the page; item quality/level unknown, so nothing from it is treated as disenchantable')
    except (ValueError, json.JSONDecodeError):
        sys.exit(bad)
    cmap = {c['id']: c for c in ci}
    for r in R:
        if r.get('creates'): recs.append((p.replace('_', ' '), r, cmap.get(r['creates'][0])))
je = lambda i: items.get(str(i), {}).get('jsonequip', {}) or {}
nm = lambda i: items.get(str(i), {}).get('name_enus') or f'Item {i}'
def qty_made(cr):
    lo = cr[1] if len(cr) > 1 and cr[1] else 1  # Wowhead writes 0 for single-item crafts on some recipes (oils, SAF-T/EZ-Thro)
    hi = max(cr[2] if len(cr) > 2 and cr[2] else lo, lo)
    return (lo + hi) / 2

# ---------- DE table defaults (Classic, item-level bands) ----------
D = [(5, 15, 'Strange Dust', 1, 2, 'Lesser Magic Essence', 1, 2, None),
     (16, 20, 'Strange Dust', 2, 3, 'Greater Magic Essence', 1, 2, 'Small Glimmering Shard'),
     (21, 25, 'Strange Dust', 4, 6, 'Lesser Astral Essence', 1, 2, 'Small Glimmering Shard'),
     (26, 30, 'Soul Dust', 1, 2, 'Greater Astral Essence', 1, 2, 'Large Glimmering Shard'),
     (31, 35, 'Soul Dust', 2, 5, 'Lesser Mystic Essence', 1, 2, 'Small Glowing Shard'),
     (36, 40, 'Vision Dust', 1, 2, 'Greater Mystic Essence', 1, 2, 'Large Glowing Shard'),
     (41, 45, 'Vision Dust', 2, 5, 'Lesser Nether Essence', 1, 2, 'Small Radiant Shard'),
     (46, 50, 'Dream Dust', 1, 2, 'Greater Nether Essence', 1, 2, 'Large Radiant Shard'),
     (51, 55, 'Dream Dust', 2, 5, 'Lesser Eternal Essence', 1, 2, 'Small Brilliant Shard'),
     (56, 60, 'Illusion Dust', 1, 2, 'Greater Eternal Essence', 1, 2, 'Large Brilliant Shard'),
     (61, 999, 'Illusion Dust', 2, 5, 'Greater Eternal Essence', 2, 3, 'Large Brilliant Shard')]
rows = []  # band id, quality, type, lo, hi, (mat,chance,min,max)x3, note
NONE3 = (None, 0, None, None)
for lo, hi, du, dmin, dmax, es, emin, emax, sh in D:
    tag = f'{lo}-{hi if hi < 999 else "+"}'
    shc = 0 if sh is None else .05
    for typ, dc, ec in (('Armor', .75, .20), ('Weapon', .20, .75)):
        if sh is None: dc, ec = (.8, .2) if typ == 'Armor' else (.2, .8)
        rows.append((f'Uncommon {typ} {tag}', 'Uncommon', typ, lo, hi, (du, dc, dmin, dmax), (es, ec, emin, emax), (sh, shc, 1, 1) if sh else NONE3, ''))
    if lo >= 56: rows.append((f'Rare {tag}', 'Rare', 'Any', lo, hi, (sh, .995, 1, 1), ('Nexus Crystal', .005, 1, 1), NONE3, ''))
    else: rows.append((f'Rare {tag}', 'Rare', 'Any', lo, hi, (sh or 'Small Glimmering Shard', 1, 1, 1), NONE3, NONE3, 'No shard listed below 16; assumed Small Glimmering' if sh is None else ''))
    if hi <= 55: rows.append((f'Epic {tag}', 'Epic', 'Any', lo, hi, (sh or 'Small Glimmering Shard', 1, 2, 4), NONE3, NONE3, ''))
    elif lo == 56: rows.append((f'Epic {tag}', 'Epic', 'Any', lo, hi, ('Nexus Crystal', 1, 1, 1), NONE3, NONE3, ''))
    else: rows.append((f'Epic {tag}', 'Epic', 'Any', lo, hi, ('Nexus Crystal', 1, 1, 2), NONE3, NONE3, ''))

# ---------- carry-over: read old workbook ----------
def hdrmap(ws):
    return {str(c.value).strip(): c.column for c in ws[1] if c.value is not None}
old = None; carry_log = []
if args.carry:
    old = load_workbook(args.carry)  # formulas kept; only literal inputs are copied
    if 'DE Table' in old.sheetnames:
        ot = old['DE Table']; h = hdrmap(ot)
        idx = {b[0]: n for n, b in enumerate(rows)}
        changed = added = 0
        for r_ in ot.iter_rows(min_row=2):
            name = r_[0].value
            if not name or not isinstance(name, str) or name.startswith('Source:'): continue
            g = lambda col: lit(r_[h[col] - 1].value) if col in h else None
            results = []
            for k in (1, 2, 3):
                mat, ch, mn, mx = g(f'Result {k}'), g(f'Chance {k}'), g(f'Min qty {k}'), g(f'Max qty {k}')
                results.append((mat or None, (ch or 0) if mat else 0, mn if mat else None, mx if mat else None))
            new = (name, g('Quality'), g('Item type'), g('Item level min'), g('Item level max'), *results, g('Notes') or '')
            if name in idx:
                if new != rows[idx[name]]: rows[idx[name]] = new; changed += 1
            else:
                rows.append(new); added += 1
        carry_log.append(f'DE Table: {changed} band(s) carried over with edits, {added} added band(s) kept')

def band(c):
    if not c or c.get('classs') not in (2, 4) or c.get('quality', 0) not in (2, 3, 4): return None
    lv = c.get('level')
    if lv is None:
        warnings.append(f'Crafted item {c.get("id")} has no item level; treated as not disenchantable')
        return None
    q = {2: 'Uncommon', 3: 'Rare', 4: 'Epic'}[c['quality']]; t = 'Weapon' if c['classs'] == 2 else 'Armor'
    for b in rows:
        try:
            if b[1] == q and (b[2] == 'Any' or b[2] == t) and b[3] <= lv <= b[4]: return b
        except TypeError:
            continue  # incomplete DE Table row
    return None
demats = sorted({x[0] for b in rows for x in b[5:8] if x[0]})

# ---------- recipe rows ----------
out = []; reagent_names = set()
for prof, r, c in recs:
    cr = r['creates']; cid = cr[0]
    sp = je(cid).get('sellprice'); q = qty_made(cr)
    b = band(c)
    if str(cid) not in items and not c:  # no item data at all: no name, no prices; anything else can still be sold on the AH
        warnings.append(f'{prof}: {r.get("name")} creates item {cid}, which has no item data on the page; skipped')
        continue
    reag = [f'{n}x {nm(i)}' for i, n in r.get('reagents', [])]
    for i, _ in r.get('reagents', []): reagent_names.add(nm(i))
    rv = 0; miss = 0
    for i, n in r.get('reagents', []):
        p_ = je(i).get('sellprice')
        if p_ is None: miss += 1
        else: rv += p_ * n
    val = None if sp is None else round(sp * q)
    out.append(dict(prof=prof, name=r['name'], rid=r.get('id'), item=nm(cid), iid=cid, skill=r.get('learnedat'), val=val, q=q, sp=sp, rv=rv, gain=None if val is None else val - rv,
        vb=('No sell price' if val is None else ('Yes' if val > rv else 'No')), miss=miss, reag=reag,
        rnames=[nm(i) for i, _ in r.get('reagents', [])],
        ilvl=c.get('level') if c else None, qual={1: 'Common', 2: 'Uncommon', 3: 'Rare', 4: 'Epic', 0: 'Poor'}.get(c.get('quality')) if c else None,
        band=b[0] if b else None, breaks=' / '.join(x[0] for x in b[5:8] if x[0]) if b else ''))
out.sort(key=lambda x: (-(x['val'] or 0), x['prof'], x['name']))
M = max(len(o['reag']) for o in out)
_n = defaultdict(int)
for o in out: _n[(o['prof'], o['name'])] += 1
for o in out:  # Chain view key; same-name recipes get their recipe ID so each can be picked
    o['key'] = f'{o["prof"]}: {o["name"]}' + (f' [ID {o["rid"]}]' if _n[(o['prof'], o['name'])] > 1 else '')

# ---------- intermediates: reagents that some recipe creates ----------
makers = defaultdict(list)
for prof, r, c in recs: makers[nm(r['creates'][0])].append((prof, r))
inter = {}; work = sorted(reagent_names)
while work:
    n = work.pop()
    if n in inter or n not in makers: continue
    cands = makers[n]; ok = [x for x in cands if not EXCL(x[1])]
    prof, r = (ok or cands)[0]
    reag = [(qq, nm(i)) for i, qq in r.get('reagents', [])]
    others = [f'{p_}: {x["name"]}' for p_, x in cands if x is not r]
    inter[n] = dict(prof=prof, recipe=r['name'], qty=qty_made(r['creates']), reag=reag, allow='Yes' if ok else 'No',
                    note=[] if ok else ['Cooldown craft: excluded by default'])
    if others: inter[n]['note'].append('Also made by: ' + '; '.join(others))
    for _, sn in reag:
        reagent_names.add(sn)  # sub-reagents need a price row even if no listed recipe uses them directly
        if sn in makers and sn not in inter: work.append(sn)
iorder = sorted(inter, key=str.lower); irow = {n: k + 2 for k, n in enumerate(iorder)}
depth = {}; state = {}; broken = set()
def visit(n):  # depth-first: back edges (loops) are broken by pricing that reagent at its buy price
    if n in depth: return depth[n]
    state[n] = 'active'; d = 0
    for j, (_, sn) in enumerate(inter[n]['reag']):
        if sn in inter:
            if state.get(sn) == 'active':
                broken.add((n, j)); inter[n]['note'].append(f'Loop: {sn} priced at buy price here'); continue
            d = max(d, visit(sn))
    state[n] = 'done'; depth[n] = d + 1; return d + 1
for n in iorder: visit(n)
for n, j in sorted(broken): warnings.append(f'Chain loop broken: {n} prices {inter[n]["reag"][j][1]} at its buy price')
RI = max([len(v['reag']) for v in inter.values()] or [1])
NI = max(len(iorder) + 1, 2)

wb = Workbook(); wb.remove(wb.active)
def hdr(ws, cols, widths, fills=None):
    ws.append(cols)
    for j, c in enumerate(ws[1]):
        c.font = HB; c.fill = (fills[j] if fills else HF); c.alignment = Alignment(wrap_text=True, vertical='center')
        ws.column_dimensions[c.column_letter].width = widths[j] if j < len(widths) else 10
    ws.row_dimensions[1].height = 45

# ---------- Settings ----------
S = wb.create_sheet('Settings')
S.column_dimensions['A'].width = 44; S.column_dimensions['B'].width = 14; S.column_dimensions['C'].width = 90
S.append(['Setting', 'Value', 'Notes'])
for c in S[1]: c.font = HB; c.fill = HF
setrows = [('Use vendor buy price for reagents left blank', 'Yes', 'Yes = reagents sold by vendors (thread, dye, etc.) use their vendor buy price unless you type a price, even if an imported AH price exists. No = vendor prices never used.'),
 ('Use imported prices (Imports tab)', 'Yes', 'Yes = prices pasted on the Imports tab are used when there is no typed price (and, for reagent cost, no vendor buy price). Typed always wins.'),
 ('Imported price column to use', 1, '1, 2 or 3 = which price column on the Imports tab to use (e.g. 1 = market value, 2 = min buyout).'),
 ('Arcane Salvager in use', 'No', 'Yes applies the Salvager settings below to every Expected DE value.'),
 ('Salvager: proc chance per disenchant', 0.10, 'Current understanding: 10% chance of an extra full disenchant roll. Update as the mechanic becomes clearer.'),
 ('Salvager: extra full disenchants per proc', 1, 'How many additional complete disenchant results one proc gives.'),
 ('Salvager: flat yield bonus', 0, 'Use instead of (or with) the proc if it turns out to be a straight % increase in materials, e.g. 0.15 = +15%.'),
 ('Effective DE multiplier', '=IF(B5="Yes",(1+B8)*(1+B6*B7),1)', 'Calculated: every Expected DE value is multiplied by this. Edit the formula itself if the mechanic turns out to work differently.'),
 ('AH cut on sales', 0.05, 'Share of the sale price the auction house keeps, applied to everything sold on the AH: disenchant materials (Expected DE value) and crafted items (AH value per craft). Vendoring has no cut. Deposits are not included.')]
RENAMED_SETTINGS = {'AH cut on DE materials sold': 'AH cut on sales'}  # old name -> new name, so carry-over keeps the value
for p in PROFS:
    pn = p.replace('_', ' ')
    setrows.append((TOGGLE + pn, 'Yes', f'Yes = intermediates made with {pn} (on the Intermediates tab) can be crafted when cheaper than buying. No = always bought. Set to No for professions you will not have.'))
TOG_ROWS = range(11, len(setrows) + 2)  # rows holding the profession toggles
GID_NAME = 'Intermediates tab ID (Google Sheets)'
setrows.append((GID_NAME, None, 'Google Sheets only: after uploading, open the Intermediates tab and paste the number after "#gid=" from the address bar. This makes the item links on Intermediates and Chain view work in Sheets. Leave blank in Excel. Not carried over on rebuild, because Sheets assigns a new number to every upload.'))
GID_ROW = len(setrows) + 1
for k, (a, b, c) in enumerate(setrows, start=2):
    S.append([a, b, c])
    for cell in S[k]: cell.font = A; cell.alignment = Alignment(wrap_text=True, vertical='top')
    if k != 9: S[f'B{k}'].fill = Y
S['B6'].number_format = S['B8'].number_format = S['B10'].number_format = '0%'; S['B9'].number_format = '0.000"x"'
dv = DataValidation(type='list', formula1='"Yes,No"', allow_blank=False); S.add_data_validation(dv)
for c_ in ['B2', 'B3', 'B5'] + [f'B{k}' for k in TOG_ROWS]: dv.add(c_)
GID = f'Settings!$B${GID_ROW}'
LB = f'IF({GID}="","#\'Intermediates\'!A","#gid="&{GID}&"&range=A")'  # link prefix: Excel/LibreOffice style, or Google Sheets tab ID
def hlink(row_expr, text_expr): return f'HYPERLINK({LB}&{row_expr},{text_expr})'
dv2 = DataValidation(type='list', formula1='"1,2,3"', allow_blank=False); S.add_data_validation(dv2); dv2.add('B4')
dv3 = DataValidation(type='decimal', operator='between', formula1='0', formula2='1', allow_blank=False,
                     error='Enter a fraction between 0 and 1, e.g. 0.05 for 5%.', showErrorMessage=True); S.add_data_validation(dv3); dv3.add('B10')
NOTE_ROW = len(setrows) + 3
S[f'A{NOTE_ROW}'] = 'Prices are per single unit and entered on the Reagent Prices tab. Disenchant odds and quantities live on the DE Table tab and can be edited.'; S[f'A{NOTE_ROW}'].font = Font(name='Arial', italic=True)
SA = 'Settings!$A$2:$A$60'; SB = 'Settings!$B$2:$B$60'

# ---------- Reagent Prices ----------
P = wb.create_sheet('Reagent Prices')
hdr(P, ['Item', 'Item ID', 'Gold', 'Silver', 'Copper', 'Your typed price', 'Imported price', 'Price used for reagent cost', 'Price used for selling', 'Price source', 'Vendor buy price (ref)', 'Vendor sell price (ref)', 'Used as'], [34, 9, 8, 8, 8, 13, 13, 15, 14, 12, 14, 14, 18])
byname = {}; idbyname = {'Lesser Astral Essence': 10998, 'Small Glowing Shard': 11138}
for r_ in recs:
    for i_, _ in r_[1].get('reagents', []): idbyname.setdefault(nm(i_), i_)
products = set()
for o in out: products.add(o['item']); idbyname.setdefault(o['item'], o['iid'])
for k, v in items.items():
    n_ = v.get('name_enus')
    if n_: idbyname.setdefault(n_, int(k))
for k, v in items.items():
    n = v.get('name_enus')
    if n and n not in byname: byname[n] = v.get('jsonequip') or {}
allnames = sorted(reagent_names | set(demats) | products, key=str.lower)
imp = lambda key, rng: f'INDEX(CHOOSE(Settings!$B$4,Imports!$C$2:$C$20001,Imports!$D$2:$D$20001,Imports!$E$2:$E$20001),MATCH({key},{rng},0))'
for i, n in enumerate(allnames, start=2):
    j = byname.get(n, {}); iid = idbyname.get(n)
    used = ', '.join(x for x, f in (('Reagent', n in reagent_names), ('DE material', n in demats), ('Craftable', n in inter), ('Product', n in products)) if f)
    if n not in reagent_names and n not in demats: j = {'sellprice': j.get('sellprice')}  # product only: a vendor buy price is never used
    P.append([n, iid, None, None, None,
      f'=IF(COUNT(C{i}:E{i})>0,N(C{i})*10000+N(D{i})*100+N(E{i}),"")',
      f'=IF(Settings!$B$3<>"Yes","",IFERROR(1/(1/{imp(f"B{i}", "Imports!$A$2:$A$20001")}),IFERROR(1/(1/{imp(f"A{i}", "Imports!$B$2:$B$20001")}),"")))',
      f'=IF(F{i}<>"",F{i},IF(AND(Settings!$B$2="Yes",K{i}<>""),K{i},IF(G{i}<>"",G{i},"")))',
      f'=IF(F{i}<>"",F{i},IF(G{i}<>"",G{i},""))',
      f'=IF(F{i}<>"","Typed",IF(AND(Settings!$B$2="Yes",K{i}<>""),"Vendor buy",IF(G{i}<>"","Imported","")))',
      j.get('buyprice'), j.get('sellprice'), used])
    for cell in P[i]: cell.font = A
    for col in 'CDE': P[f'{col}{i}'].fill = Y
    for col in 'KL': P[f'{col}{i}'].font = BL
    for col in 'FGHIKL': P[f'{col}{i}'].number_format = G
NP = P.max_row; P.freeze_panes = 'B2'; P.auto_filter.ref = f'A1:M{NP}'
P['K1'].comment = Comment('Vendor buy price from Wowhead game data, curated by hand: Wowhead lists a nominal buy price for many items no vendor sells. Blank this cell for anything not vendor-sold so it is not used as the reagent cost. Edits here are kept on rebuild.', 'Claude')
P['C1'].comment = Comment('Yellow cells: type a per-unit price. Typed prices always win. Reagent cost order: typed, then vendor buy price (if vendor-sold), then imported price. Selling prices (disenchant materials and crafted items sold on the AH) use typed or imported prices, never vendor prices. "Craftable" in Used as means the item has a row on the Intermediates tab; "Product" means a recipe creates it, so its selling price is the AH exit.', 'Claude')
PA = f"'Reagent Prices'!$A$2:$A${NP}"; PE = f"'Reagent Prices'!$H$2:$H${NP}"; PT = f"'Reagent Prices'!$I$2:$I${NP}"; PF = f"'Reagent Prices'!$F$2:$F${NP}"

# ---------- Intermediates ----------
X = wb.create_sheet('Intermediates')
ivis = ['Item', 'Profession', 'Recipe', 'Qty made', 'Depth', 'Allow crafting?', 'Profession toggle', 'Buy price (each)', 'Craft cost (each)', 'Best cost (each)', 'Source', 'Craft saves vs buy (each)']
for j in range(1, RI + 1): ivis += [f'Reagent {j}', f'Cost {j}']
ivis += ['Notes']
ihelp = [f'Name {j}' for j in range(1, RI + 1)] + [f'Qty {j}' for j in range(1, RI + 1)] + [f'Unit price {j}' for j in range(1, RI + 1)]
IC = {h: CL(k + 1) for k, h in enumerate(ivis + ihelp)}
hdr(X, ivis + ihelp, [28, 14, 28, 7, 6, 9, 12, 13, 13, 13, 8, 13] + [24, 12] * RI + [44], [HF] * len(ivis) + [GRAY] * len(ihelp))
TOG_MISSING = 'Not in Settings: treated as Yes'
xF, xT, xB, xC, xBest, xS, xSave = (IC[h] for h in ('Allow crafting?', 'Profession toggle', 'Buy price (each)', 'Craft cost (each)',
                                                    'Best cost (each)', 'Source', 'Craft saves vs buy (each)'))
for n in iorder:
    i = irow[n]; v = inter[n]; nr = len(v['reag'])
    row = [n, v['prof'], v['recipe'], v['qty'], depth[n], v['allow']]
    costs = [f'{IC[f"Cost {j}"]}{i}' for j in range(1, nr + 1)]
    units = f'{IC["Unit price 1"]}{i}:{IC[f"Unit price {RI}"]}{i}'
    tg, b_, c_, bs = f'{xT}{i}', f'{xB}{i}', f'{xC}{i}', f'{xBest}{i}'
    row += [f'=IFERROR(INDEX({SB},MATCH("{TOGGLE}"&B{i},{SA},0)),"{TOG_MISSING}")',
            f'=IFERROR(INDEX({PE},MATCH(A{i},{PA},0)),"")',
            f'=IF(OR({xF}{i}<>"Yes",AND({tg}<>"Yes",{tg}<>"{TOG_MISSING}")),"",IF(COUNT({units})<{nr},"",SUM({",".join(costs)})/D{i}))',
            f'=IF({c_}="",{b_},IF({b_}="",{c_},MIN({b_},{c_})))',
            f'=IF({bs}="","",IF(AND({c_}<>"",OR({b_}="",{c_}<{b_})),"Craft","Buy"))',
            f'=IF(OR({b_}="",{c_}=""),"",{b_}-{c_})']
    for j in range(1, RI + 1):
        if j <= nr:
            qq, sn = v['reag'][j - 1]
            row += [f'{qq}x {sn}', f'=IF({IC[f"Unit price {j}"]}{i}="","",{IC[f"Qty {j}"]}{i}*{IC[f"Unit price {j}"]}{i})']
        else: row += [None, None]
    row.append('; '.join(v['note']))
    names = [v['reag'][j - 1][1] if j <= nr else None for j in range(1, RI + 1)]
    qtys = [v['reag'][j - 1][0] if j <= nr else None for j in range(1, RI + 1)]
    unitf = []
    for j in range(1, RI + 1):
        if j > nr: unitf.append(None); continue
        sn = names[j - 1]
        if sn in inter and (n, j - 1) not in broken: unitf.append(f'=IF({xBest}{irow[sn]}="","",{xBest}{irow[sn]})')
        else: unitf.append(f'=IFERROR(INDEX({PE},MATCH({IC[f"Name {j}"]}{i},{PA},0)),"")')
    X.append(row + names + qtys + unitf)
    for cell in X[i]: cell.font = A
    X[f'{xF}{i}'].fill = Y
    for col in (xB, xC, xBest, xSave): X[f'{col}{i}'].number_format = G
    for j in range(1, nr + 1):
        X[f'{IC[f"Cost {j}"]}{i}'].number_format = G
        sn = names[j - 1]
        if sn in inter:  # craftable reagent: formula link to its row (works in Excel, LibreOffice, and Sheets once the tab ID is set)
            rc = X[f'{IC[f"Reagent {j}"]}{i}']; txt_ = str(rc.value).replace('"', '""')
            rc.value = '=' + hlink(irow[sn], f'"{txt_}"'); rc.font = LINK
X.freeze_panes = 'B2'; X.auto_filter.ref = f'A1:{IC["Notes"]}{NI}'
dvi = DataValidation(type='list', formula1='"Yes,No"', allow_blank=False); X.add_data_validation(dvi); dvi.add(f'{xF}2:{xF}{NI}')
X.conditional_formatting.add(f'{xS}2:{xS}{NI}', CellIsRule(operator='equal', formula=['"Craft"'], font=Font(name='Arial', color='006100', bold=True), fill=GREENF))
X.conditional_formatting.add(f'{xSave}2:{xSave}{NI}', CellIsRule(operator='greaterThan', formula=['0'], font=Font(name='Arial', color='006100')))
X.conditional_formatting.add(f'{xT}2:{xT}{NI}', CellIsRule(operator='equal', formula=[f'"{TOG_MISSING}"'], font=Font(name='Arial', color='9C0006', bold=True), fill=PatternFill('solid', start_color='FFC7CE')))
for h in ihelp: X.column_dimensions[IC[h]].hidden = True
X[f'{xF}1'].comment = Comment('Yellow: set to No to stop this item ever counting as crafted (for example a cooldown or a craft you will not do). Kept on rebuild. Transmutes and Mooncloth default to No.', 'Claude')
X[f'{xT}1'].comment = Comment('This profession\'s "Chains: craft with ..." value from Settings. Shown in red if Settings has no toggle for this profession (for example a renamed row); crafting is then still allowed, as if Yes.', 'Claude')
X[f'{xC}1'].comment = Comment('Per unit: sum of the Cost columns divided by Qty made. Each reagent is priced at its own best cost, so chains resolve. Blank if the profession toggle is No, Allow crafting is No, or any reagent is unpriced.', 'Claude')
X[f'{xBest}1'].comment = Comment('Lower of Buy price and Craft cost. This is the price the Recipes tab uses for the cheapest path. Ties go to Buy.', 'Claude')
X['E1'].comment = Comment('Levels of crafting from this item down to bought materials. 1 = made only from bought reagents.', 'Claude')
X[f'{IC["Reagent 1"]}1'].comment = Comment('Blue underlined reagents are themselves craftable: click to jump to their row.', 'Claude')
IA = f"Intermediates!$A$2:$A${NI}"
def ICOL(h): return f"Intermediates!${IC[h]}$2:${IC[h]}${NI}"

# ---------- DE Table ----------
T = wb.create_sheet('DE Table')
th = ['Band', 'Quality', 'Item type', 'Item level min', 'Item level max']
for k in (1, 2, 3): th += [f'Result {k}', f'Chance {k}', f'Min qty {k}', f'Max qty {k}', f'Avg qty {k}']
th += ['Notes']
tcalc = ['Price 1', 'Price 2', 'Price 3', 'Materials with a chance', 'Materials priced', 'Value per disenchant']  # calculated, read by Recipes
hdr(T, th + tcalc, [26, 10, 9, 8, 8] + [22, 8, 7, 7, 7] * 3 + [40] + [13, 13, 13, 10, 10, 14], [HF] * len(th) + [GRAY] * len(tcalc))
TK = {h: CL(len(th) + k + 1) for k, h in enumerate(tcalc)}
for i, b in enumerate(rows, start=2):
    row = [b[0], b[1], b[2], b[3], b[4]]
    for k, (mat, ch, mn, mx) in enumerate(b[5:8]):
        col = 6 + k * 5
        row += [mat, ch if mat else None, mn, mx, f'=IF({CL(col + 2)}{i}="","",({CL(col + 2)}{i}+{CL(col + 3)}{i})/2)']
    row.append(b[8])
    # weight = chance x avg qty; a result counts when its weight is above 0, and the band is valued only when all of those are priced
    wts = [f'N({CL(6 + k * 5 + 1)}{i})*N({CL(6 + k * 5 + 4)}{i})' for k in range(3)]
    pc = [f'{TK[f"Price {k + 1}"]}{i}' for k in range(3)]
    row += [f'=IF({CL(6 + k * 5)}{i}="","",IFERROR(INDEX({PT},MATCH({CL(6 + k * 5)}{i},{PA},0)),""))' for k in range(3)]
    row += ['=' + '+'.join(f'({w}>0)' for w in wts),
            '=' + '+'.join(f'({w}>0)*ISNUMBER({p})' for w, p in zip(wts, pc)),
            f'=IF({TK["Materials priced"]}{i}<{TK["Materials with a chance"]}{i},"",' + '+'.join(f'{w}*N({p})' for w, p in zip(wts, pc)) + ')']
    T.append(row)
    for cell in T[i]: cell.font = A
    for k in range(3):
        col = 6 + k * 5
        for cc in range(col, col + 4): T.cell(i, cc).font = BL
        T.cell(i, col + 1).number_format = '0.0%'
    for h in ('Price 1', 'Price 2', 'Price 3', 'Value per disenchant'): T[f'{TK[h]}{i}'].number_format = G
NT = T.max_row; T.freeze_panes = 'B2'
T[f'{TK["Value per disenchant"]}1'].comment = Comment('Calculated: expected value of one disenchant of an item in this band, before the Salvager multiplier and the AH cut (sum of chance x avg qty x price used for selling). Blank until every result with a chance is priced. Recipes reads this column.', 'Claude')
T[f'A{NT + 2}'] = 'Source: Classic disenchanting tables by item level (uncommon armor ~75% dust / 20% essence / 5% shard, weapons swap dust and essence; rares ~100% shard, ~0.5% Nexus at 56+; epics 2-4 shards at 55 and below, Nexus Crystal at 56+). Forever may differ: edit the blue cells as you confirm results in game. Item-level ranges and band names decide which recipes fall in which band, but only take effect on the next rebuild.'
T[f'A{NT + 2}'].font = Font(name='Arial', italic=True)
TA = f"'DE Table'!$A$2:$A${NT}"
def TKC(h): return f"'DE Table'!${TK[h]}$2:${TK[h]}${NT}"

# ---------- Recipes ----------
W = wb.create_sheet('Recipes', 0)
widths = {'Profession': 14, 'Recipe': 32, 'Skill req': 8, 'Vendor value per craft': 15, 'Qty made': 7, 'Unit sell price': 14,
          'Reagents vendor value': 15, 'Gain over vendoring reagents': 15, 'Vendor beats reagents?': 10, 'Reagents w/o sell price': 10,
          'Your reagent cost (buy all)': 14, 'Reagents priced': 10, 'Use chains?': 8, 'Reagent cost (cheapest path)': 14, 'Crafted inputs': 30,
          'Profit vendoring': 14, 'Item quality': 10, 'Item level': 8, 'DE band': 20, 'Breaks into': 30,
          'Expected DE value (after AH cut)': 14, 'DE materials priced': 10, 'Profit disenchanting': 15, 'DE beats reagents?': 10,
          'AH price (each)': 14, 'AH price source': 9, 'AH value per craft (after AH cut)': 14, 'Profit selling on AH': 15, 'AH beats reagents?': 10,
          'Beats reagents (any exit)?': 12, 'Best exit': 14, 'Profit at best exit': 15}
GOLD_COLS = ('Vendor value per craft', 'Unit sell price', 'Reagents vendor value', 'Gain over vendoring reagents', 'Your reagent cost (buy all)',
             'Reagent cost (cheapest path)', 'Profit vendoring', 'Expected DE value (after AH cut)', 'Profit disenchanting',
             'AH price (each)', 'AH value per craft (after AH cut)', 'Profit selling on AH', 'Profit at best exit')
PROFIT_COLS = ('Profit vendoring', 'Profit disenchanting', 'Profit selling on AH', 'Profit at best exit')
vis = list(widths) + [f'Reagent {k + 1}' for k in range(M)]
helpers = ([f'Qty {k + 1}' for k in range(M)] + [f'Name {k + 1}' for k in range(M)] + [f'Price {k + 1}' for k in range(M)]
           + [f'Best price {k + 1}' for k in range(M)] + [f'Source {k + 1}' for k in range(M)]
           + ['DE row', 'Key', 'Recipe ID', 'Created item', 'AH row'])
C = {h: CL(k + 1) for k, h in enumerate(vis + helpers)}
hdr(W, vis + helpers, list(widths.values()) + [22] * M, [HF] * len(vis) + [GRAY] * len(helpers))
cR = C['Expected DE value (after AH cut)']
W[f'{cR}1'].comment = Comment('Expected value of the disenchant materials per craft, times the Salvager multiplier, minus the auction house cut (Settings). This is what you receive after selling the materials.', 'Claude')
W[f'{C["Your reagent cost (buy all)"]}1'].comment = Comment('Baseline: every reagent bought at its normal reagent cost (Reagent Prices). Compare with the cheapest path to see what crafting intermediates saves.', 'Claude')
W[f'{C["Reagent cost (cheapest path)"]}1'].comment = Comment('Each reagent at its best cost from the Intermediates tab (crafted when cheaper and allowed), otherwise its normal reagent cost. All profit columns use this.', 'Claude')
W[f'{C["Use chains?"]}1'].comment = Comment('Yellow: No = this recipe buys every reagent (cheapest path equals buy all, no crafted inputs), regardless of the Intermediates tab. Kept on rebuild, matched by the hidden Recipe ID column.', 'Claude')
W[f'{C["Crafted inputs"]}1'].comment = Comment('Reagents the cheapest path crafts instead of buying (top level only). Pick the recipe on the Chain view tab to see each one and what it is made from; item names there link to the Intermediates tab.', 'Claude')
W[f'{C["AH price (each)"]}1'].comment = Comment('Selling price of one crafted item: your typed price on Reagent Prices, otherwise the imported price (Settings picks the column). Never a vendor price. Looked up by the hidden Created item column, so it works when the recipe name differs from the item name.', 'Claude')
W[f'{C["AH value per craft (after AH cut)"]}1'].comment = Comment('AH price x Qty made, minus the auction house cut (Settings). What you receive per craft if it sells. Deposits and liquidity are not modeled.', 'Claude')
W[f'{C["Best exit"]}1'].comment = Comment('The priced exit worth the most per craft (ties: Vendor, then Disenchant, then AH). Any exit that applies but has no price yet is named in brackets, e.g. "Vendor (AH unpriced)", because it might be better once priced.', 'Claude')
rng = lambda pre, i, n: f'{C[f"{pre} 1"]}{i}:{C[f"{pre} {n}"]}{i}'
for i, o in enumerate(out, start=2):
    L = {h: f'{c}{i}' for h, c in C.items()}
    nr = len(o['reag']); de = bool(o['band'])
    vd, cp, rr, dr = L['Vendor value per craft'], L['Reagent cost (cheapest path)'], L['Expected DE value (after AH cut)'], L['DE row']
    ap_, av, ar = L['AH price (each)'], L['AH value per craft (after AH cut)'], L['AH row']
    vals = {
        'Profession': o['prof'], 'Recipe': o['name'], 'Skill req': o['skill'], 'Vendor value per craft': o['val'], 'Qty made': o['q'],
        'Unit sell price': o['sp'], 'Reagents vendor value': o['rv'], 'Gain over vendoring reagents': o['gain'],
        'Vendor beats reagents?': o['vb'], 'Reagents w/o sell price': o['miss'],
        'Use chains?': 'Yes', 'Recipe ID': o['rid'], 'Created item': o['item'],
        'Profit vendoring': None if o['val'] is None else f'=IF({cp}="","",{vd}-{cp})',
        'Item quality': o['qual'], 'Item level': o['ilvl'], 'DE band': o['band'] or 'Not disenchantable', 'Breaks into': o['breaks'],
        'Key': o['key'],
        # AH exit: one name lookup per row (AH row), then two INDEXes
        'AH row': f'=IFERROR(MATCH({L["Created item"]},{PA},0),"")',
        'AH price (each)': f'=IFERROR(1/(1/INDEX({PT},{ar})),"")',
        'AH price source': f'=IF({ap_}="","",IF(INDEX({PF},{ar})<>"","Typed","Imported"))',
        'AH value per craft (after AH cut)': f'=IF({ap_}="","",{ap_}*{L["Qty made"]}*(1-Settings!$B$10))',
        'Profit selling on AH': f'=IF(OR({av}="",{cp}=""),"",{av}-{cp})',
        'AH beats reagents?': f'=IF({av}="","",IF({av}>{L["Reagents vendor value"]},"Yes","No"))'}
    # Exits that apply to this recipe: vendor if the item has a sell price, disenchant if it has a band, AH always
    exits = ([('Vendor', vd)] if o['val'] is not None else []) + ([('Disenchant', rr)] if de else []) + [('AH', av)]
    xv = ','.join(c for _, c in exits)
    pick = '"' + exits[-1][0] + '"'
    for lab, c in reversed(exits[:-1]): pick = f'IF(AND(ISNUMBER({c}),{c}=MAX({xv})),"{lab}",{pick})'  # ties go to the earlier exit
    unpriced = [(lab, c) for lab, c in exits if lab != 'Vendor']  # the vendor value is a build-time number, never unpriced
    tj = '_xlfn.TEXTJOIN(", ",TRUE,' + ','.join(f'IF({c}="","{"DE" if lab == "Disenchant" else lab}","")' for lab, c in unpriced) + ')'
    vals |= {'Best exit': f'=IF(COUNT({xv})=0,"No priced exit",{pick})&IF({tj}="",""," ("&{tj}&" unpriced)")',
             'Profit at best exit': f'=IF(OR({cp}="",COUNT({xv})=0),"",MAX({xv})-{cp})',
             'Beats reagents (any exit)?': f'=IF(OR(' + ','.join([f'{L["Vendor beats reagents?"]}="Yes"'] + ([f'{L["DE beats reagents?"]}="Yes"'] if de else [])
                                                   + [f'{L["AH beats reagents?"]}="Yes"']) + f'),"Yes",IF({tj}="","No","No ("&{tj}&" unpriced)"))'}
    if nr:  # reagent quantities and names are known at build time, so they are written as values; empty slots stay empty
        Q, PR, BP = rng('Qty', i, nr), rng('Price', i, nr), rng('Best price', i, nr)
        vals |= {'Your reagent cost (buy all)': f'=IF(COUNT({PR})<{nr},"",SUMPRODUCT({Q},{PR}))',
                 'Reagents priced': f'=COUNT({PR})&" of {nr}"',
                 'Reagent cost (cheapest path)': f'=IF(COUNT({BP})<{nr},"",SUMPRODUCT({Q},{BP}))'}
    craftable = [k for k in range(1, nr + 1) if o['rnames'][k - 1] in inter]
    if craftable:
        vals['Crafted inputs'] = '=_xlfn.TEXTJOIN(", ",TRUE,' + ','.join(
            f'IF({L[f"Source {k}"]}="Craft",{L[f"Reagent {k}"]},"")' for k in craftable) + ')'
    if de:  # one band lookup per row; the DE Table holds each band's value per disenchant
        vals |= {'DE row': f'=IFERROR(MATCH({L["DE band"]},{TA},0),"")',
                 'Expected DE value (after AH cut)': f'=IFERROR(IF(INDEX({TKC("Materials priced")},{dr})<INDEX({TKC("Materials with a chance")},{dr}),"",'
                                                     f'INDEX({TKC("Value per disenchant")},{dr})*{L["Qty made"]}*Settings!$B$9*(1-Settings!$B$10)),"")',
                 'DE materials priced': f'=IFERROR(INDEX({TKC("Materials priced")},{dr})&" of "&INDEX({TKC("Materials with a chance")},{dr}),"")',
                 'Profit disenchanting': f'=IF(OR({rr}="",{cp}=""),"",{rr}-{cp})',
                 'DE beats reagents?': f'=IF({rr}="","",IF({rr}>{L["Reagents vendor value"]},"Yes","No"))'}
    # not disenchantable: the DE columns stay blank (no formulas)
    uc = f'${C["Use chains?"]}{i}'
    for k in range(1, M + 1):
        if k > nr: continue
        sn = o['rnames'][k - 1]; nmc = L[f'Name {k}']; pk = L[f'Price {k}']
        vals[f'Reagent {k}'] = o['reag'][k - 1]
        vals[f'Qty {k}'] = int(o['reag'][k - 1].split('x ', 1)[0])
        vals[f'Name {k}'] = sn
        vals[f'Price {k}'] = f'=IFERROR(INDEX({PE},MATCH({nmc},{PA},0)),"")'
        if sn in inter:  # only craftable reagents need the Intermediates lookups
            vals[f'Best price {k}'] = f'=IF({uc}="No",{pk},IFERROR(INDEX({ICOL("Best cost (each)")},MATCH({nmc},{IA},0)),{pk}))'
            vals[f'Source {k}'] = f'=IF({uc}="No","",IFERROR(INDEX({ICOL("Source")},MATCH({nmc},{IA},0)),""))'
        else:
            vals[f'Best price {k}'] = f'={pk}'
    W.append([vals.get(h) for h in vis + helpers])
    for cell in W[i]: cell.font = A
    for h in GOLD_COLS: W[L[h]].number_format = G
    W[L['Qty made']].number_format = '0.##'
    W[L['Use chains?']].fill = Y
last = W.max_row
dvu = DataValidation(type='list', formula1='"Yes,No"', allow_blank=False); W.add_data_validation(dvu)
dvu.add(f'{C["Use chains?"]}2:{C["Use chains?"]}{last}')
for h in PROFIT_COLS:
    col = C[h]
    W.conditional_formatting.add(f'{col}2:{col}{last}', CellIsRule(operator='greaterThan', formula=['0'], font=Font(name='Arial', color='006100', bold=True), fill=GREENF))
    W.conditional_formatting.add(f'{col}2:{col}{last}', CellIsRule(operator='lessThan', formula=['0'], font=Font(name='Arial', color='9C0006', bold=True), fill=PatternFill('solid', start_color='FFC7CE')))
for h in helpers: W.column_dimensions[C[h]].hidden = True
# Collapsible column groups (saved expanded). Each group is followed by an ungrouped column (Profit vendoring, Expected DE value,
# AH value per craft), because adjacent groups at the same level merge into one.
grp = lambda a, b: [CL(k) for k in range(vis.index(a) + 1, vis.index(b) + 2)]
GROUPS = (('Vendor value per craft', 'Crafted inputs'), ('Item quality', 'Breaks into'), ('AH price (each)', 'AH price source'))
for a_, b_ in GROUPS:
    for c_ in grp(a_, b_): W.column_dimensions[c_].outline_level = 1
W.sheet_properties.outlinePr.summaryRight = True  # +/- button sits over Profit vendoring, Expected DE value and AH value per craft
W.freeze_panes = 'D2'; W.auto_filter.ref = f'A1:{CL(len(vis + helpers))}{last}'
RK = f"Recipes!${C['Key']}$2:${C['Key']}${last}"
def RCOL(h): return f"Recipes!${C[h]}$2:${C[h]}${last}"

# ---------- Chain view ----------
V = wb.create_sheet('Chain view')
for col, w in zip('ABCDEFGHI', [16, 34, 7, 7, 13, 13, 13, 9, 13]): V.column_dimensions[col].width = w
V.column_dimensions['Z'].hidden = True
keys = sorted({o['key'] for o in out}, key=str.lower)
for k, key in enumerate(keys, start=2): V[f'Z{k}'] = key
example = next((o for o in out if 'Bronze Bar' in o['rnames']), None) or next(  # a short, familiar chain to start from
    (o for o in out if o['val'] and any(rn in inter and depth[rn] >= 2 and inter[rn]['allow'] == 'Yes' for rn in o['rnames'])), out[0])
V['A1'] = 'Chain view'; V['A1'].font = Font(name='Arial', bold=True, size=14)
V['A2'] = 'Recipe'; V['A2'].font = Font(name='Arial', bold=True)
V['B2'] = example['key']; V['B2'].fill = Y; V['B2'].font = A
V['C2'] = 'Pick a recipe from the dropdown (yellow cell). Read-only otherwise: nothing else in the workbook depends on this tab.'; V['C2'].font = Font(name='Arial', italic=True, color='808080')
dvc = DataValidation(type='list', formula1=f'$Z$2:$Z${len(keys) + 1}', allow_blank=False, showErrorMessage=True, error='Pick a recipe from the list.')
V.add_data_validation(dvc); dvc.add('B2')
V['H2'] = f'=IFERROR(MATCH(B2,{RK},0),"")'; V['G2'] = 'Recipes row'; V['G2'].font = V['H2'].font = Font(name='Arial', color='808080')
summ = ['Profession', 'Qty made', 'Vendor value per craft', 'Expected DE value (after AH cut)', 'Breaks into', 'AH value per craft (after AH cut)',
        'Your reagent cost (buy all)', 'Use chains?', 'Reagent cost (cheapest path)', 'Crafted inputs', 'Best exit', 'Profit at best exit']
for k, h in enumerate(summ, start=4):
    V[f'A{k}'] = h; V[f'A{k}'].font = Font(name='Arial', bold=True)
    txt = '&""' if h in ('Profession', 'Breaks into', 'Use chains?', 'Crafted inputs', 'Best exit') else ''  # empty text cells would show 0
    V[f'B{k}'] = f'=IF($H$2="","",INDEX({RCOL(h)},$H$2){txt})'; V[f'B{k}'].font = A
    if h in GOLD_COLS: V[f'B{k}'].number_format = G
    if h == 'Qty made': V[f'B{k}'].number_format = '0.##'
CHK = 4 + len(summ)
V[f'A{CHK}'] = 'Check: sum of reagent totals'; V[f'A{CHK}'].font = Font(name='Arial', bold=True)
V[f'B{CHK}'].number_format = G
pv = f'B{4 + summ.index("Profit at best exit")}'
V.conditional_formatting.add(pv, CellIsRule(operator='greaterThan', formula=['0'], font=Font(name='Arial', color='006100', bold=True), fill=GREENF))
V.conditional_formatting.add(pv, CellIsRule(operator='lessThan', formula=['0'], font=Font(name='Arial', color='9C0006', bold=True), fill=PatternFill('solid', start_color='FFC7CE')))
H0 = CHK + 2
heads = ['Level', 'Item', 'Qty', 'Makes', 'Buy (each)', 'Craft (each)', 'Used (each)', 'Source', 'Total (Qty x Used)']
for k, h in enumerate(heads):
    c = V.cell(H0, k + 1, h); c.font = HB; c.fill = HF; c.alignment = Alignment(wrap_text=True, vertical='center')
V.row_dimensions[H0].height = 30
V.cell(H0 + 1, 1, 'Sub-reagent rows (↳) list what one craft of the reagent above uses; Makes is how many that craft produces, so Craft (each) = sum of their totals / Makes. Blue underlined items open their Intermediates row.').font = Font(name='Arial', italic=True, color='808080')
UCV = f'$B${4 + summ.index("Use chains?")}'
def tree_row(r, name_expr, qty_expr, label, top=False):
    # B holds the item (hyperlinked when it is an intermediate); other columns key off B
    m = f'MATCH({name_expr},{IA},0)'
    V[f'B{r}'] = f'=IF({name_expr}="","",IF(ISNUMBER({m}),{hlink(f"({m}+1)", name_expr)},{name_expr}))'
    V[f'A{r}'] = f'=IF(B{r}="","",{label})'
    V[f'C{r}'] = f'=IF(B{r}="","",{qty_expr})'
    mb = f'MATCH(B{r},{IA},0)'
    V[f'D{r}'] = f'=IF(B{r}="","",IFERROR(INDEX({ICOL("Qty made")},{mb}),""))'
    V[f'E{r}'] = f'=IF(B{r}="","",IFERROR(INDEX({PE},MATCH(B{r},{PA},0)),""))'
    V[f'F{r}'] = f'=IF(B{r}="","",IFERROR(INDEX({ICOL("Craft cost (each)")},{mb}),""))'
    off = f'{UCV}="No",' if top else 'FALSE,'  # a recipe with Use chains? = No buys every top-level reagent
    V[f'G{r}'] = f'=IF(B{r}="","",IF({off}E{r},IFERROR(INDEX({ICOL("Best cost (each)")},{mb}),E{r})))'
    V[f'H{r}'] = f'=IF(B{r}="","",IF({off}IF(E{r}<>"","Buy",""),IFERROR(INDEX({ICOL("Source")},{mb}),IF(E{r}<>"","Buy",""))))'
    V[f'I{r}'] = f'=IF(OR(B{r}="",G{r}=""),"",C{r}*G{r})'
    for col in 'ACDEFGHI': V[f'{col}{r}'].font = A
    V[f'B{r}'].font = LINK
    for col in 'EFGI': V[f'{col}{r}'].number_format = G
    V[f'C{r}'].number_format = V[f'D{r}'].number_format = '0.##'
r = H0 + 2; top = []
L1F = PatternFill('solid', start_color='DDEBF7')
for k in range(1, M + 1):
    name1 = f'IF($H$2="","",INDEX({RCOL(f"Name {k}")},$H$2)&"")'  # &"": empty reagent slots are truly empty and would show 0
    qty1 = f'INDEX({RCOL(f"Qty {k}")},$H$2)'
    tree_row(r, name1, qty1, f'"Reagent {k}"', top=True); top.append(r)
    for col in 'ABCDEFGHI': V[f'{col}{r}'].fill = L1F
    V[f'A{r}'].font = V[f'C{r}'].font = Font(name='Arial', bold=True)
    pr = r; r += 1
    for j in range(1, RI + 1):
        mp = f'MATCH(B{pr},{IA},0)'
        name2 = f'IF(OR(B{pr}="",D{pr}=""),"",IFERROR(INDEX({ICOL(f"Name {j}")},{mp})&"",""))'
        qty2 = f'INDEX({ICOL(f"Qty {j}")},{mp})'
        tree_row(r, name2, qty2, '"   ↳ from"'); r += 1
tot = ",".join(f"I{t}" for t in top); nonblank = "+".join(f'(B{t}<>"")' for t in top)
V[f'B{CHK}'] = f'=IF($H$2="","",IF(OR(COUNT({tot})=0,COUNT({tot})<{nonblank}),"",SUM({tot})))'  # blank unless every reagent is priced
V[f'C{CHK}'] = f'=IF(OR(B{CHK}="",B{4 + summ.index("Reagent cost (cheapest path)")}=""),"",IF(ABS(B{CHK}-B{4 + summ.index("Reagent cost (cheapest path)")})<0.5,"matches","MISMATCH"))'
V[f'C{CHK}'].font = Font(name='Arial', italic=True, color='808080')
V[f'B{CHK}'].font = A
V.conditional_formatting.add(f'H{H0 + 2}:H{r}', CellIsRule(operator='equal', formula=['"Craft"'], font=Font(name='Arial', color='006100', bold=True), fill=GREENF))
V.freeze_panes = f'A{H0 + 1}'

# ---------- Sorted view ----------
# One SORT(FILTER()) over the visible Recipes columns. Changing a dropdown re-sorts a block of values, which is fast;
# sorting Recipes itself moves and recalculates every row's formulas.
SV = wb.create_sheet('Sorted view')
SVH = 9; SV0 = SVH + 1  # header row, first result row
RV = f"Recipes!$A$2:${CL(len(vis))}${last}"
SVC = {h: CL(k + 1) for k, h in enumerate(vis)}
SV['A1'] = 'Sorted view'; SV['A1'].font = Font(name='Arial', bold=True, size=14)
SV['C1'] = 'Sort and filter here instead of on Recipes. Pick from the yellow cells; the list below updates. Read-only: change "Use chains?" on Recipes.'
SV['C1'].font = Font(name='Arial', italic=True, color='808080')
SORT_DEFAULT = 'Profit at best exit'
ctrls = [('Profession', 'All', 'All, or one profession.'),
         ('Sort by', SORT_DEFAULT, 'Any column in the header row below.'),
         ('Order', 'High to low', 'High to low or Low to high.'),
         ('Minimum profit at best exit (gold)', None, 'Optional. Blank = no minimum. E.g. 0.5 = at least 50 silver profit; 0 = only profitable recipes.'),
         ('Hide rows where the sort column is blank', 'Yes', 'Yes keeps unpriced rows (blank in the sort column) out of the way. No shows them too.')]
SVROW = {}
for k, (a, b, c) in enumerate(ctrls, start=3):
    SV[f'A{k}'] = a; SV[f'A{k}'].font = Font(name='Arial', bold=True); SV[f'A{k}'].alignment = Alignment(wrap_text=True, vertical='top')
    SV[f'B{k}'] = b; SV[f'B{k}'].fill = Y; SV[f'B{k}'].font = A
    SV[f'C{k}'] = c; SV[f'C{k}'].font = Font(name='Arial', italic=True, color='808080')
    SVROW[a] = f'$B${k}'
SVROW['Sort column #'] = '$H$4'
SV['G4'] = 'Sort column #'; SV['G4'].font = Font(name='Arial', color='808080')
SV['H4'] = f'=IFERROR(MATCH({SVROW["Sort by"]},$A${SVH}:${CL(len(vis))}${SVH},0),{vis.index(SORT_DEFAULT) + 1})'; SV['H4'].font = Font(name='Arial', color='808080')
SV['B6'].number_format = '0.00"g"'
SV.row_dimensions[6].height = SV.row_dimensions[7].height = 30
pros = ['All'] + [p.replace('_', ' ') for p in PROFS]
for f1, cell in ((f'"{",".join(pros)}"', 'B3'), (f'$A${SVH}:${CL(len(vis))}${SVH}', 'B4'), ('"High to low,Low to high"', 'B5'), ('"Yes,No"', 'B7')):
    d_ = DataValidation(type='list', formula1=f1, allow_blank=False, showErrorMessage=True, error='Pick from the list.'); SV.add_data_validation(d_); d_.add(cell)
d_ = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1='-100000', allow_blank=True, showErrorMessage=True,
                    error='Enter a number of gold, e.g. 0.5 for 50 silver, or leave blank.'); SV.add_data_validation(d_); d_.add('B6')
for k, h in enumerate(vis, start=1):
    c = SV.cell(SVH, k, h); c.font = HB; c.fill = HF; c.alignment = Alignment(wrap_text=True, vertical='center')
    SV.column_dimensions[CL(k)].width = (list(widths.values()) + [22] * M)[k - 1]
SV.column_dimensions['A'].width = 22
SV.row_dimensions[SVH].height = 45
colof = lambda h: f"Recipes!${C[h]}$2:${C[h]}${last}"
sortcol = f'INDEX({RV},0,{SVROW["Sort column #"]})'
pf = colof('Profit at best exit')
cond = (f'(({SVROW["Profession"]}="All")+({colof("Profession")}={SVROW["Profession"]})>0)'
        f'*(({SVROW["Minimum profit at best exit (gold)"]}="")+ISNUMBER({pf})*({pf}>={SVROW["Minimum profit at best exit (gold)"]}*10000)>0)'
        f'*(({SVROW["Hide rows where the sort column is blank"]}<>"Yes")+({sortcol}<>"")>0)')
# Written for Google Sheets (tested there): plain SORT/FILTER names, and the order argument is TRUE = ascending,
# FALSE = descending. (Excel would need _xlfn._xlws. prefixes and 1/-1, which Sheets does not accept.)
# IFNA, not IFERROR: only "FILTER found nothing" (#N/A) becomes the message; any other error stays visible.
SV_FORMULA = (f'IFNA(SORT(FILTER({RV},{cond}),{SVROW["Sort column #"]},{SVROW["Order"]}="Low to high"),'
              f'"No recipes match these settings")')
SV[f'A{SV0}'] = '=' + SV_FORMULA
SV[f'A{SV0}'].comment = Comment('This one formula fills the whole list. If it is ever deleted or overwritten, paste this back into this cell:\n=' + SV_FORMULA, 'Claude')
SVL = SV0 + last - 2  # last possible result row
for h in vis:
    col = SVC[h]
    if h in GOLD_COLS:
        for r_ in range(SV0, SVL + 1): SV[f'{col}{r_}'].number_format = G
    if h == 'Qty made':
        for r_ in range(SV0, SVL + 1): SV[f'{col}{r_}'].number_format = '0.##'
for h in PROFIT_COLS:
    col = SVC[h]
    SV.conditional_formatting.add(f'{col}{SV0}:{col}{SVL}', CellIsRule(operator='greaterThan', formula=['0'], font=Font(name='Arial', color='006100', bold=True), fill=GREENF))
    SV.conditional_formatting.add(f'{col}{SV0}:{col}{SVL}', CellIsRule(operator='lessThan', formula=['0'], font=Font(name='Arial', color='9C0006', bold=True), fill=PatternFill('solid', start_color='FFC7CE')))
SV.freeze_panes = f'D{SV0}'  # Profession, Recipe and Skill req stay visible, as on Recipes
for a_, b_ in GROUPS:  # same groups as Recipes
    for c_ in grp(a_, b_): SV.column_dimensions[c_].outline_level = 1
SV.sheet_properties.outlinePr.summaryRight = True
W['A1'].comment = Comment('Filtering this tab is fine. To sort, use the Sorted view tab: sorting here is slow because every row carries formulas that move and recalculate.', 'Claude')

# ---------- Imports ----------
I = wb.create_sheet('Imports')
hdr(I, ['Item ID', 'Item name (optional)', 'Price 1 (copper)', 'Price 2 (copper)', 'Price 3 (copper)', '', 'Instructions'], [10, 30, 14, 14, 14, 3, 90])
notes = ['Paste price data here starting at row 2. Prices must be in copper (1g = 10000), which is how TSM reports them.',
 'Matching uses Item ID first; if a row has no ID, it falls back to the exact item name in column B.',
 'Use up to three price columns (e.g. market value, min buyout, region average). Settings > "Imported price column to use" picks which one.',
 'Typed prices on Reagent Prices always override imports. Clear this tab and re-paste to refresh; nothing else needs changing.',
 'Rows below 20,001 are ignored. Columns F onward are not read.']
for k, t in enumerate(notes, start=2): I[f'G{k}'] = t; I[f'G{k}'].font = Font(name='Arial', italic=True); I[f'G{k}'].alignment = Alignment(wrap_text=True)
I.freeze_panes = 'A2'
wb._sheets = [wb['Sorted view'], wb['Recipes'], wb['Chain view'],wb['Intermediates'], wb['Reagent Prices'], wb['Imports'], wb['DE Table'], wb['Settings']]

# ---------- carry-over: write old edits into new workbook ----------
changes = []
if old:
    # Reagent Prices: typed G/S/C by item name
    if 'Reagent Prices' in old.sheetnames:
        op = old['Reagent Prices']; newrow = {P.cell(r, 1).value: r for r in range(2, NP + 1)}
        kept = 0; lost = []; kv = 0; oldnames = set()
        for r_ in op.iter_rows(min_row=2):
            name = r_[0].value; vals = [lit(r_[c].value) for c in (2, 3, 4)]
            if not name: continue
            oldnames.add(name)
            if name in newrow:
                ok_, nk = lit(r_[10].value), P[f'K{newrow[name]}'].value
                if ok_ in ('', None): ok_ = None
                if ok_ != nk: P[f'K{newrow[name]}'] = ok_; kv += 1
            if all(v in (None, '') for v in vals): continue
            if name in newrow:
                for c, v in zip('CDE', vals): P[f'{c}{newrow[name]}'] = v
                kept += 1
            else: lost.append(name)
        carry_log.append(f'Reagent Prices: {kept} typed price(s) carried over; {kv} vendor buy price edit(s) kept')
        if lost: carry_log.append(f'  Typed prices with no matching item in the new data (not carried): {", ".join(lost)}')
        newvb = [n for n, r in newrow.items() if n not in oldnames and P[f'K{r}'].value not in (None, '')]
        if newvb: carry_log.append(f'  New items with a Wowhead buy price; blank column K if not vendor-sold: {", ".join(sorted(newvb, key=str.lower))}')
    # Imports: all pasted rows, columns A-E
    if 'Imports' in old.sheetnames:
        oi = old['Imports']; n_imp = 0
        for r_ in oi.iter_rows(min_row=2, max_col=5, values_only=True):
            if all(v in (None, '') for v in r_): continue
            n_imp += 1
            for c, v in enumerate(r_, start=1): I.cell(n_imp + 1, c, v).font = A
        carry_log.append(f'Imports: {n_imp} row(s) carried over')
    # Settings: column B by setting name
    if 'Settings' in old.sheetnames:
        os_ = old['Settings']; newrow = {S.cell(r, 1).value: r for r in range(2, len(setrows) + 2)}; diff = []; seen = set()
        for r_ in os_.iter_rows(min_row=2, max_col=2):
            name, v = r_[0].value, r_[1].value
            name = RENAMED_SETTINGS.get(name, name)
            if name == GID_NAME: seen.add(name); continue  # Sheets tab IDs change with every upload
            if name in newrow:
                seen.add(name)
                tgt = S.cell(newrow[name], 2)
                v = lit(v)
                if v != tgt.value: diff.append(f'{name} = {v}')
                tgt.value = v
        carry_log.append('Settings: carried over' + (f' (non-default: {"; ".join(diff)})' if diff else ' (all defaults)'))
        new_set = [f'{a} = {b}' for a, b, _ in setrows if a not in seen and a != GID_NAME]
        if new_set: carry_log.append(f'  New setting(s) at default: {"; ".join(new_set)}')
    # Chain view: keep the selected recipe if it still exists
    if 'Chain view' in old.sheetnames:
        sel = old['Chain view']['B2'].value
        if sel in keys: V['B2'] = sel; carry_log.append(f'Chain view: kept selection ({sel})')
    # Sorted view: dropdown choices, by label
    if 'Sorted view' in old.sheetnames:
        osv = old['Sorted view']; kept_sv = []
        for r_ in range(3, 3 + len(ctrls)):
            a, v = osv[f'A{r_}'].value, lit(osv[f'B{r_}'].value)
            if a in SVROW and a != 'Sort column #':
                tgt = SV[SVROW[a].replace('$', '')]
                if v != tgt.value: tgt.value = v; kept_sv.append(f'{a} = {v}')
        carry_log.append('Sorted view: ' + (f'kept {"; ".join(kept_sv)}' if kept_sv else 'defaults'))
    # Intermediates: Allow crafting? by item name
    if 'Intermediates' in old.sheetnames:
        ox = old['Intermediates']; h = hdrmap(ox); kept = 0
        if 'Item' in h and 'Allow crafting?' in h:
            for r_ in ox.iter_rows(min_row=2):
                name, v = r_[h['Item'] - 1].value, lit(r_[h['Allow crafting?'] - 1].value)
                if name in irow and v in ('Yes', 'No') and v != X[f'{xF}{irow[name]}'].value:
                    X[f'{xF}{irow[name]}'] = v; kept += 1
        carry_log.append(f'Intermediates: {kept} "Allow crafting?" change(s) from default carried over')
    # Recipes: Use chains? by Recipe ID (exact); older workbooks without IDs fall back to profession + name, paired in order
    if 'Recipes' in old.sheetnames:
        orc = old['Recipes']; h = hdrmap(orc)
        if 'Use chains?' in h:
            ucol = C['Use chains?']; byid = {o['rid']: i for i, o in enumerate(out, start=2)}
            byname = defaultdict(list)
            for i, o in enumerate(out, start=2): byname[(o['prof'], o['name'])].append(i)
            kept = 0; unmatched = []; ambiguous = set()
            for r_ in orc.iter_rows(min_row=2):
                v = lit(r_[h['Use chains?'] - 1].value)
                if v != 'No': continue  # only non-default values need carrying
                key = (r_[0].value, r_[1].value)
                if 'Recipe ID' in h: tgt = byid.get(r_[h['Recipe ID'] - 1].value)
                else:
                    lst = byname.get(key, []); tgt = lst.pop(0) if lst else None
                    if sum(1 for o in out if (o['prof'], o['name']) == key) > 1: ambiguous.add(key)
                if tgt: W[f'{ucol}{tgt}'] = 'No'; kept += 1
                else: unmatched.append(f'{key[0]}: {key[1]}')
            carry_log.append(f'Recipes: {kept} "Use chains? = No" setting(s) carried over' + ('' if 'Recipe ID' in h else ' (matched by name: older workbook has no Recipe ID)'))
            if unmatched: carry_log.append(f'  Not found in the new data (not carried): {", ".join(unmatched)}')
            if ambiguous: carry_log.append(f'  Same-name recipes matched in page order, check these: {", ".join(f"{a}: {b}" for a, b in sorted(ambiguous))}')
    # Data change summary: Recipes static columns
    if 'Recipes' in old.sheetnames:
        orc = old['Recipes']; h = hdrmap(orc)
        cmp_cols = ['Skill req', 'Vendor value per craft', 'Qty made', 'Unit sell price', 'Reagents vendor value', 'Item quality', 'Item level', 'DE band']
        reag_cols = sorted([c for c in h if re.fullmatch(r'Reagent \d+', c)], key=lambda c: int(c.split()[1]))
        def oldrec(r_):
            g = lambda c: r_[h[c] - 1].value if c in h else None
            return {c: g(c) for c in cmp_cols} | {'Reagents': [g(c) for c in reag_cols if g(c)]}
        has_id = 'Recipe ID' in h  # match by recipe ID when the old workbook has it, else by profession + name
        O = defaultdict(list)
        for r_ in orc.iter_rows(min_row=2):
            if r_[0].value: O[(r_[0].value, r_[1].value) + ((r_[h['Recipe ID'] - 1].value,) if has_id else ())].append(oldrec(r_))
        N = defaultdict(list)
        for o in out:
            N[(o['prof'], o['name']) + ((o['rid'],) if has_id else ())].append({'Skill req': o['skill'], 'Vendor value per craft': o['val'], 'Qty made': o['q'], 'Unit sell price': o['sp'],
                'Reagents vendor value': o['rv'], 'Item quality': o['qual'], 'Item level': o['ilvl'], 'DE band': o['band'] or 'Not disenchantable', 'Reagents': o['reag']})
        same = lambda x, y: x == y or (isinstance(x, (int, float)) and isinstance(y, (int, float)) and abs(x - y) < 1e-9)
        eq = lambda a, b: all(same(a.get(c), b[c]) for c in b)
        added, removed, changed = [], [], []
        for k in sorted(set(N) | set(O)):
            ol, nl = list(O.get(k, [])), list(N.get(k, []))
            for n_ in list(nl):  # pair identical rows first (same-name recipes exist, e.g. two Lesser Arcane Elixirs)
                m_ = next((x for x in ol if eq(x, n_)), None)
                if m_ is not None: ol.remove(m_); nl.remove(n_)
            for o_, n_ in zip(ol, nl):
                changed.append(f'  ~ {k[0]}: {k[1]} | ' + '; '.join(f'{c}: {o_.get(c)} -> {n_[c]}' for c in n_ if not same(o_.get(c), n_[c])))
            added += [f'  + {k[0]}: {k[1]}'] * max(0, len(nl) - len(ol)); removed += [f'  - {k[0]}: {k[1]}'] * max(0, len(ol) - len(nl))
        changes.append(f'Recipes: {sum(map(len, O.values()))} before, {len(out)} after; {len(added)} added, {len(removed)} removed, {len(changed)} changed')
        changes += added + removed + changed
    if 'Reagent Prices' in old.sheetnames:
        oldn = {r_[0].value for r_ in old['Reagent Prices'].iter_rows(min_row=2) if r_[0].value}
        a = sorted(set(allnames) - oldn, key=str.lower); r = sorted(oldn - set(allnames), key=str.lower)
        a_prod = [n for n in a if n not in reagent_names and n not in demats]; a = [n for n in a if n not in a_prod]
        oldprod = any('Product' in str(r_[12].value or '') for r_ in old['Reagent Prices'].iter_rows(min_row=2))
        if a_prod and not oldprod: changes.append(f'Reagent Prices: {len(a_prod)} crafted products added (first build with the AH exit)')
        elif a_prod: changes.append(f'Reagent Prices products added: {", ".join(a_prod)}')
        if a: changes.append(f'Reagent Prices items added: {", ".join(a)}')
        if r: changes.append(f'Reagent Prices items removed: {", ".join(r)}')

os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
wb.save(args.out)

# openpyxl 3.1 drops sheetFormatPr outlineLevelCol, which Excel uses to draw the 1/2 level buttons on Recipes and Sorted view. Patch it in.
# openpyxl writes worksheets as sheet1.xml, sheet2.xml ... in tab order.
def set_outline_level(path, sheet_xmls, level=1):
    zin = zipfile.ZipFile(path); parts = [(i, zin.read(i.filename)) for i in zin.infolist()]; zin.close()
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zout:
        for i, data in parts:
            if i.filename in sheet_xmls:
                x = data.decode()
                if 'outlineLevelCol=' not in x: x = x.replace('<sheetFormatPr ', f'<sheetFormatPr outlineLevelCol="{level}" ', 1)
                data = x.encode()
            zout.writestr(i, data)
set_outline_level(args.out, [f'xl/worksheets/sheet{wb._sheets.index(ws_) + 1}.xml' for ws_ in (W, SV)])  # Recipes and Sorted view

print(len(out), 'rows', NP - 1, 'priced items', NT - 1, 'bands', 'M', M, sum(1 for o in out if o['band']), 'DE-able',
      '|', len(inter), 'intermediates, deepest chain', max(depth.values() or [0]), 'level(s),', sum(1 for v in inter.values() if v['allow'] == 'No'), 'excluded by default',
      '|', len(products), 'products,', sum(1 for o in out if o['val'] is None and not o['band']), 'AH-only recipes (no vendor price, not disenchantable)')
for section, lines in (('CARRY-OVER', carry_log), ('DATA CHANGES', changes), ('WARNINGS', sorted(set(warnings)))):
    if lines: print(f'\n== {section} =='); print('\n'.join(lines))
