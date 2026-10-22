# WoW Forever shuffle app

Finds profitable crafting shuffles in WoW Forever: every recipe's reagent cost against three exits for the crafted
item (vendor, disenchant, auction house). Successor to the Google Sheets shuffle workbook. Design rules and the
calculation model live in [CLAUDE.md](CLAUDE.md).

## First-time setup

You need Git, Python 3, Node.js (LTS) and Claude Code.

1. **Unzip this folder** somewhere permanent, e.g. `Documents/wow-forever-shuffle`.
2. **Install the tools** you don't already have:
   - Git: https://git-scm.com/downloads
   - Node.js LTS: https://nodejs.org
   - Claude Code (terminal): macOS/Linux `curl -fsSL https://claude.ai/install.sh | bash`;
     Windows PowerShell `irm https://claude.ai/install.ps1 | iex`. Then open a new terminal and run `claude --version`.
     See https://code.claude.com/docs/en/quickstart. The desktop app works too.
3. **Create an empty public repo on GitHub** named `wow-forever-shuffle` (no README, no .gitignore, no license).
4. **Push this folder** (in a terminal, inside the folder):
   ```
   git init -b main
   git add .
   git status            # data/private/ must NOT be listed
   git commit -m "Starter: parser, config, spec, sheet builder v2.5"
   git remote add origin https://github.com/<you>/wow-forever-shuffle.git
   git push -u origin main
   ```
5. **Turn on Pages:** repo Settings > Pages > Build and deployment > Source: **GitHub Actions**.
6. **Start Claude Code in the folder:** `cd` into it and run `claude`, then paste the first prompt below.

### First prompt for Claude Code

```
Read CLAUDE.md. Then build the first version of the app in app/: Vite + React + TypeScript + AG Grid Community.
Order of work: (1) the model module with Vitest parity tests against data/private/parity-v2.5.json using
data/private/edits-v2.5.json, and report every difference before moving on; (2) the Recipes grid; (3) edits in
localStorage with Export/Import, so I can import edits-v2.5.json; (4) the Auctionator zip drop; (5) the GitHub
Pages workflow. Show me a plan first, and stop after each step so I can check it.
```

## Routine updates

| What changed | What to do |
|---|---|
| New Wowhead pages (patch, recipe fixes) | Save each profession page into `data/private/pages/`, run `python3 tools/parse_pages.py`, read the printed changes, then commit and push `app/public/game-data.json`. |
| New prices | Zip `WTF/Account/<ACCOUNT>/SavedVariables/Auctionator.lua` after a scan and `/reload`, and drop the zip on the site. Nothing to commit. |
| A rule or UI tweak | Ask Claude Code; review the diff; push. The site redeploys on push. |

Your typed prices and settings are saved in your browser. Use **Export** now and then to keep a backup file.

## What's in here

- `tools/parse_pages.py`: saved Wowhead pages to `app/public/game-data.json` (game data only; never auction-house data)
- `tools/export_workbook_edits.py`, `tools/export_parity.py`: one-time migration from the workbook
- `tools/auctionator_to_imports.py`: Auctionator reader (reference for the in-app version)
- `tools/build_forever_shuffle_sheet.py`: the spreadsheet builder, kept until the app matches it
- `data/config/`: default disenchant table and settings
- `data/private/` (not committed): saved pages, workbooks, your exported edits, the parity reference
