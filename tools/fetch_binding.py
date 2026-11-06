"""
Look up how each crafted product binds (Binds when picked up / equipped / used) from Wowhead's Forever item tooltips,
and write it into app/public/game-data.json as items[id].bind = "pickup" | "equip" | "use" | "none".

Game data only. A tooltip is the same text as the in-game item tooltip; only its bind line is read, nothing else is
kept (in particular no auction-house data, which tooltips don't carry anyway).

Source: https://nether.wowhead.com/forever/tooltip/item/<id>   (the Forever data environment, not plain Classic)
Cache:  data/private/binding.json  {"<id>": "pickup" | "equip" | "use" | "none"}; only new items are fetched.
        parse_pages.py reads this cache too, so re-parsing the pages keeps the bind field.

Run (after parse_pages.py):
  python3 tools/fetch_binding.py            fetch products not in the cache, then update game-data.json
  python3 tools/fetch_binding.py --refresh  fetch every product again (bind types rarely change)
  python3 tools/fetch_binding.py --selftest check the bind-line reader on sample tooltips, no network
A failed lookup is reported and left out (unknown, never guessed); run again to retry it.
"""
import argparse, json, os, re, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GAME = os.path.join(ROOT, 'app', 'public', 'game-data.json')
CACHE = os.path.join(ROOT, 'data', 'private', 'binding.json')
URL = 'https://nether.wowhead.com/forever/tooltip/item/{}'
DELAY = 0.25  # seconds between requests: about 4 a second

BIND_LINES = (('Binds when picked up', 'pickup'), ('Binds when equipped', 'equip'), ('Binds when used', 'use'))


def read_bind(tooltip_html):
    """The item's bind type from its tooltip HTML: 'pickup', 'equip', 'use', or 'none' when there is no bind line.
    Wowhead puts the bind line right after a <!--bo--> marker; only that spot is read, so a description that
    mentions binding can't be mistaken for it. No marker at all is an error (the item is left unknown)."""
    i = tooltip_html.find('<!--bo-->')
    if i < 0: raise ValueError('no bind marker in the tooltip')
    j = tooltip_html.find('<!--', i + 9)
    spot = tooltip_html[i + 9:j if j >= 0 else None]
    lines = [t.strip() for t in re.sub(r'<[^>]+>', '\n', spot).split('\n') if t.strip()]
    # The same spot can also hold a "Unique", "Unique (10)" or "Unique-Equipped" line; anything else is an error.
    binds = [code for t in lines for line, code in BIND_LINES if t == line]
    other = [t for t in lines if t not in dict(BIND_LINES) and not t.startswith('Unique')]
    if other or len(binds) > 1: raise ValueError(f'unrecognised bind line: {lines!r}')
    return binds[0] if binds else 'none'


def selftest():
    # Excerpts of real tooltips from the Forever endpoint (fetched 2026-11-05), plus two made-up edge cases.
    samples = {
        'Robe of Power (7054)': ('<table><tr><td><!--nstart--><b class="q3">Robe of Power</b><!--nend--><!--ndstart--><!--ndend-->'
                                 '<span class="q"><br>Item Level <!--ilvl-->38</span><!--bo--><br>Binds when picked up<!--ue-->'
                                 '<!--ue--><table width="100%"><tr><td>Chest</td>', 'pickup'),
        'Truefaith Gloves (7049)': ('<table><tr><td><!--nstart--><b class="q2">Truefaith Gloves</b><!--nend--><!--ndstart--><!--ndend-->'
                                    '<span class="q"><br>Item Level <!--ilvl-->30</span><!--bo--><br>Binds when equipped<!--ue-->'
                                    '<!--ue--><table width="100%"><tr><td>Hands</td>', 'equip'),
        'Runecloth Bag (14046)': ('<table><tr><td><!--nstart--><b class="q1">Runecloth Bag</b><!--nend--><!--ndstart--><!--ndend-->'
                                  '<span class="q"><br>Item Level <!--ilvl-->52</span><!--bo--><!--ue--><!--ue--><br />14 Slot Bag', 'none'),
        'made up: bind words in a description only': ('<b>X</b><!--bo--><!--ue--><br>"Makes an item that Binds when picked up"', 'none'),
        'made up: binds when used': ('<b>X</b><!--bo--><br>Binds when used<!--ue-->', 'use'),
        'Mechanical Dragonling (4396)': ('<span class="q"><br>Item Level <!--ilvl-->40</span><!--bo--><br>Binds when equipped'
                                         '<br>Unique-Equipped<!--ue--><!--ue--><table width="100%"><tr><td>Trinket</td>', 'equip'),
        'Heavy Leather Ball (18662)': ('<span class="q whtt-extra whtt-ilvl"><br>Item Level <!--ilvl-->1</span><!--bo--><br>'
                                       'Unique (10)<!--ue--><!--ue--><!--ebstats-->', 'none'),
    }
    bad = [(n, read_bind(t), want) for n, (t, want) in samples.items() if read_bind(t) != want]
    for n, got, want in bad: print(f'FAIL {n}: got {got}, want {want}')
    print('selftest:', 'FAILED' if bad else f'all {len(samples)} samples read correctly')
    return not bad


def fetch(item_id):
    req = urllib.request.Request(URL.format(item_id), headers={'User-Agent': 'wow-forever-shuffle bind lookup'})
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.load(r)
    if not isinstance(data, dict) or 'tooltip' not in data: raise ValueError('no tooltip in the reply')
    return data.get('name'), read_bind(data['tooltip'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()
    if not selftest(): sys.exit(1)
    if args.selftest: return

    game = json.load(open(GAME, encoding='utf8'))
    products = sorted({r['product'] for r in game['recipes']})
    cache = {} if args.refresh or not os.path.exists(CACHE) else json.load(open(CACHE, encoding='utf8'))
    todo = [i for i in products if str(i) not in cache]
    print(f'{len(products)} products, {len(products) - len(todo)} in the cache, {len(todo)} to fetch'
          f' (about {len(todo) * (DELAY + 0.15) / 60:.0f} min)', flush=True)

    failed, mismatched = [], []
    for n, i in enumerate(todo, 1):
        try:
            name, bind = fetch(i)
        except Exception as e:
            try:
                time.sleep(2); name, bind = fetch(i)
            except Exception as e2:
                failed.append((i, game['items'][str(i)]['name'], str(e2))); continue
        if name and name != game['items'][str(i)]['name']: mismatched.append((i, game['items'][str(i)]['name'], name))
        cache[str(i)] = bind
        if n % 100 == 0:
            print(f'  {n}/{len(todo)}', flush=True)
            json.dump(cache, open(CACHE, 'w', encoding='utf8'), sort_keys=True)  # keep progress if interrupted
        time.sleep(DELAY)
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(cache, open(CACHE, 'w', encoding='utf8'), sort_keys=True, indent=0)

    changed = 0
    for i in products:
        it = game['items'][str(i)]; b = cache.get(str(i))
        if it.get('bind') != b:
            changed += 1
            if b is None: it.pop('bind', None)
            else: it['bind'] = b
    json.dump(game, open(GAME, 'w'), separators=(',', ':'), sort_keys=True)

    counts = {}
    for i in products: counts[cache.get(str(i), 'unknown')] = counts.get(cache.get(str(i), 'unknown'), 0) + 1
    print(f'\nBind types of {len(products)} products: ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())))
    print(f'{changed} items changed in {os.path.relpath(GAME, ROOT)}')
    for i, ours, theirs in mismatched: print(f'NOTE: item {i} is "{ours}" in game-data but "{theirs}" in the tooltip')
    for i, name, err in failed: print(f'FAILED: {name} ({i}): {err}  (left unknown; run again to retry)')


if __name__ == '__main__':
    main()
