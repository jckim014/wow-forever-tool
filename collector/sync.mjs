// PC side of the auction collector. Task Scheduler runs it at logon and hourly (install-task.ps1, via the hidden
// launcher sync-hidden.vbs). It downloads new snapshot artifacts from GitHub to the data folder, verifies them against
// their manifest, writes a per-item summary, deletes the artifact from GitHub, and raises Windows notifications for
// anything wrong (see CLAUDE.md, Collector).
//
// Data:  FOREVER_DATA_ROOT (default F:\ForeverAuctionData)
//          raw\YYYY\MM\DD\<snapshot>\house-<id>-<kind>.json.gz + manifest.json   (API responses, unchanged)
//          summary\YYYY\MM\DD\<snapshot>.json.gz                                  (per house, per item figures)
//          sync.log
// State: %LOCALAPPDATA%\ForeverAuctionSync\ (sync-state.json, lock; and sync.log when the data folder is missing)
// Token: data/private/github-token.txt (fine-grained, this repo only, Actions read/write)
//
// Flags: --dry-run (download and verify, write nothing, delete nothing), --test-notification
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readZip, summarizeHouse, SUMMARY_COLUMNS, snapshotDate, snapshotDayParts, updateAlerts, parseTokenExpiry,
} from './syncLib.mjs';

const REPO = 'jckim014/wow-forever-tool';
const WORKFLOW = 'collect.yml';
const ACTIONS_URL = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;
const STALE_MS = 3 * 60 * 60 * 1000;
const BACKUP_RUN_AFTER_MS = 70 * 60 * 1000; // no collector run for this long: start one from here
const TOKEN_WARN_MS = 14 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const dataRoot = process.env.FOREVER_DATA_ROOT || 'F:\\ForeverAuctionData';
const localDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ForeverAuctionSync');
const dryRun = process.argv.includes('--dry-run');

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not fatal */ }
fs.mkdirSync(localDir, { recursive: true });

// ---- log ----
let logFile = path.join(localDir, 'sync.log');
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line);
  } catch { /* logging must never stop the sync */ }
}

// ---- notifications (Windows toast through Windows PowerShell; click opens `url`) ----
function toast(title, message, url) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const xml = `<toast activationType="protocol" launch="${esc(url)}" duration="long"><visual><binding template="ToastGeneric">`
    + `<text>${esc(title)}</text><text>${esc(message)}</text></binding></visual></toast>`;
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 });
  if (r.status !== 0) log(`notification failed: ${String(r.stderr || r.error || '').trim().slice(0, 300)}`);
}

if (process.argv.includes('--test-notification')) {
  toast('Auction sync: test', 'This is how sync problems will look. Click to open the collector on GitHub.', ACTIONS_URL);
  process.exit(0);
}

// ---- lock (logon and hourly runs can coincide) ----
const lockPath = path.join(localDir, 'lock');
try {
  const t = fs.statSync(lockPath).mtimeMs;
  if (Date.now() - t < LOCK_STALE_MS) { log('another sync is running: skipped'); process.exit(0); }
} catch { /* no lock */ }
fs.writeFileSync(lockPath, String(process.pid));

const statePath = path.join(localDir, 'sync-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
state.alerts ??= {};
state.seenNotes ??= [];
state.githubFailures ??= 0;

const conditions = {}; // lasting problems: key -> message
const events = []; // one-off notices: { title, message, url }

// ---- GitHub API ----
let token = '';
try { token = fs.readFileSync(path.join(repoRoot, 'data/private/github-token.txt'), 'utf8').trim(); } catch { /* checked below */ }
let tokenExpiry = null;

async function gh(p, { method = 'GET', raw = false, body } = {}) {
  const res = await fetch(`https://api.github.com${p}`, {
    method,
    redirect: raw ? 'manual' : 'follow',
    body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'forever-auction-sync' },
  });
  tokenExpiry = parseTokenExpiry(res.headers.get('github-authentication-token-expiration')) ?? tokenExpiry;
  if (res.status === 401) throw new Error('GitHub rejected the token (expired or revoked?): make a new one, see CLAUDE.md');
  if (raw) return res;
  if (method !== 'GET') {
    if (res.status !== 204) throw new Error(`GitHub ${method} ${p}: HTTP ${res.status}`);
    return null;
  }
  if (!res.ok) throw new Error(`GitHub ${p}: HTTP ${res.status}`);
  return res.json();
}

async function downloadArtifact(id) {
  const res = await gh(`/repos/${REPO}/actions/artifacts/${id}/zip`, { raw: true });
  if (res.status !== 302) throw new Error(`artifact ${id}: expected a redirect, got HTTP ${res.status}`);
  const blob = await fetch(res.headers.get('location')); // signed URL: no token sent to the storage host
  if (!blob.ok) throw new Error(`artifact ${id}: download HTTP ${blob.status}`);
  return Buffer.from(await blob.arrayBuffer());
}

// ---- one snapshot ----
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Verifies and stores one artifact's files. Returns the snapshot id. Throws (artifact kept) on any mismatch. */
function storeSnapshot(artifactName, files) {
  const manifestBuf = files.get('manifest.json');
  if (!manifestBuf) throw new Error(`${artifactName}: no manifest.json`);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  if (manifest.format !== 'forever-auction-snapshot' || manifest.version !== 1) throw new Error(`${artifactName}: unknown manifest format`);
  const id = manifest.snapshot;
  if (!snapshotDate(id)) throw new Error(`${artifactName}: bad snapshot id ${id}`);
  for (const f of manifest.files) {
    const b = files.get(f.file);
    if (!b) throw new Error(`${id}: ${f.file} missing from the artifact`);
    if (sha256(b) !== f.sha256) throw new Error(`${id}: ${f.file} checksum mismatch`);
  }

  // Summary per house in this snapshot
  const byHouse = new Map();
  for (const f of manifest.files) {
    const json = JSON.parse(zlib.gunzipSync(files.get(f.file)).toString('utf8'));
    const h = byHouse.get(f.house) ?? { lastModified: {} };
    h[f.kind] = json;
    h.lastModified[f.kind] = f.lastModified;
    byHouse.set(f.house, h);
  }
  const houses = {};
  for (const [house, h] of [...byHouse].sort((a, b) => a[0] - b[0])) {
    houses[house] = { lastModified: h.lastModified, ...summarizeHouse(h.auctions ?? null, h.commodities ?? null) };
  }
  const summary = {
    format: 'forever-auction-summary', version: 1, snapshot: id, collectedAt: manifest.collectedAt,
    note: 'Per house: per item ID [lowest, median, cheapest15, units, listings], copper per unit; auctions and commodities merged, bid-only left out. Houses missing here did not change in this snapshot.',
    columns: SUMMARY_COLUMNS, houses,
  };

  if (!dryRun) {
    const day = snapshotDayParts(id);
    const rawDir = path.join(dataRoot, 'raw', ...day, id);
    const partial = rawDir + '.partial';
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    if (fs.existsSync(rawDir)) {
      // Same snapshot id from another run (same data times): keep what is there, add what is new.
      for (const name of fs.readdirSync(rawDir)) fs.copyFileSync(path.join(rawDir, name), path.join(partial, name));
    }
    for (const f of manifest.files) fs.writeFileSync(path.join(partial, f.file), files.get(f.file));
    fs.writeFileSync(path.join(partial, manifest.files.length && fs.existsSync(path.join(rawDir, 'manifest.json')) ? `manifest-${artifactName}.json` : 'manifest.json'), manifestBuf);
    for (const f of manifest.files) {
      if (sha256(fs.readFileSync(path.join(partial, f.file))) !== f.sha256) throw new Error(`${id}: ${f.file} differs after writing to disk`);
    }
    fs.rmSync(rawDir, { recursive: true, force: true });
    fs.renameSync(partial, rawDir);

    const sumDir = path.join(dataRoot, 'summary', ...day);
    fs.mkdirSync(sumDir, { recursive: true });
    const sumPath = path.join(sumDir, `${id}.json.gz`);
    let merged = summary;
    if (fs.existsSync(sumPath)) {
      const old = JSON.parse(zlib.gunzipSync(fs.readFileSync(sumPath)).toString('utf8'));
      merged = { ...summary, houses: { ...old.houses, ...summary.houses } };
    }
    fs.writeFileSync(sumPath + '.tmp', zlib.gzipSync(JSON.stringify(merged)));
    fs.renameSync(sumPath + '.tmp', sumPath);
  }

  for (const n of [...(manifest.notes ?? []), ...(manifest.problems ?? [])]) {
    if (n.startsWith('no previous state')) continue;
    if (!state.seenNotes.includes(n)) {
      state.seenNotes.push(n);
      events.push({ title: 'Auction collector reported something', message: n, url: ACTIONS_URL });
    }
  }
  state.seenNotes = state.seenNotes.slice(-200);
  return id;
}

// ---- run ----
const started = Date.now();
let stored = 0;
try {
  // Data folder
  let driveOk = true;
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.accessSync(dataRoot, fs.constants.W_OK);
    logFile = path.join(dataRoot, 'sync.log');
  } catch (e) {
    driveOk = false;
    conditions.drive = `Can't write to ${dataRoot} (${e.code || e.message}). Snapshots wait on GitHub (90 days).`;
  }

  if (!token || token.startsWith('PASTE_')) throw new Error('no GitHub token in data/private/github-token.txt');

  try {
    // Collector health
    const wf = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}`);
    if (wf.state !== 'active') conditions.schedule = `The collector's schedule is "${wf.state}" on GitHub. Re-enable it on the Actions page.`;

    const runs = (await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=50`)).workflow_runs ?? [];
    const lastSeen = state.lastSeenRunId ?? 0;
    const failed = runs.filter((r) => r.id > lastSeen && r.status === 'completed' && !['success', 'skipped'].includes(r.conclusion));
    if (failed.length && state.lastSeenRunId != null) {
      events.push({
        title: `Auction collector: ${failed.length} failed run${failed.length > 1 ? 's' : ''}`,
        message: `Latest: ${failed[0].conclusion} at ${failed[0].created_at}. Click to see what went wrong.`,
        url: failed[0].html_url,
      });
    }
    const done = runs.filter((r) => r.status === 'completed').map((r) => r.id);
    if (done.length) state.lastSeenRunId = Math.max(lastSeen, ...done);

    // Backup for the Google Apps Script timer (collector/apps-script-timer.gs, every 15 min; GitHub's own schedule
    // never fires in this repo): if the collector hasn't run for 70 min, start a run from here and alert, since the
    // timer must have stopped. The alert clears at the first sync that doesn't need to step in.
    const lastRunAt = runs.length ? Math.max(...runs.map((r) => Date.parse(r.created_at))) : 0;
    const running = runs.some((r) => r.status !== 'completed');
    if (wf.state === 'active' && !running && Date.now() - lastRunAt > BACKUP_RUN_AFTER_MS) {
      if (dryRun) log('(dry run) would start a collector run');
      else {
        await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: 'main' } });
        log(`no collector run for ${((Date.now() - lastRunAt) / 60000).toFixed(0)} min: started one`);
        state.backupStartedAt = Date.now();
      }
    } else if (state.backupStartedAt && lastRunAt > state.backupStartedAt + 2 * 60 * 1000) {
      delete state.backupStartedAt; // a run this PC didn't start: the timer is back
    }
    if (state.backupStartedAt) {
      conditions.timer = `Collector runs are only being started by this PC (since ${new Date(state.backupStartedAt).toLocaleTimeString()}). The Google Apps Script timer may have stopped: script.google.com > Forever auction timer > Executions.`;
    }

    // Snapshots waiting on GitHub
    let artifacts = [];
    for (let page = 1; page <= 10; page++) {
      const r = await gh(`/repos/${REPO}/actions/artifacts?per_page=100&page=${page}`);
      artifacts.push(...r.artifacts);
      if (r.artifacts.length < 100) break;
    }
    artifacts = artifacts.filter((a) => a.name.startsWith('snapshot-') && !a.expired).sort((a, b) => a.name.localeCompare(b.name));
    let newestOnGitHub = 0;
    for (const a of artifacts) newestOnGitHub = Math.max(newestOnGitHub, snapshotDate(a.name.slice(9))?.getTime() ?? 0);
    log(`${artifacts.length} snapshot(s) waiting on GitHub${dryRun ? ' (dry run)' : ''}`);

    if (driveOk) {
      for (const a of artifacts) {
        try {
          const t0 = Date.now();
          const files = readZip(await downloadArtifact(a.id));
          const id = storeSnapshot(a.name, files);
          if (!dryRun) await gh(`/repos/${REPO}/actions/artifacts/${a.id}`, { method: 'DELETE' });
          state.newestStored = Math.max(state.newestStored ?? 0, snapshotDate(id).getTime());
          stored++;
          log(`${dryRun ? 'checked' : 'stored'} ${id} (${(a.size_in_bytes / 1e6).toFixed(1)} MB, ${Date.now() - t0} ms)`);
        } catch (e) {
          events.push({ title: 'Auction sync: a snapshot could not be stored', message: `${a.name}: ${e.message}. It stays on GitHub and is retried next hour.`, url: ACTIONS_URL });
          log(`failed ${a.name}: ${e.message}`);
        }
      }
    }

    // Fresh data?
    const newest = Math.max(state.newestStored ?? 0, newestOnGitHub);
    if (Date.now() - newest > STALE_MS) {
      conditions.stale = newest
        ? `Newest auction data is from ${new Date(newest).toLocaleString()} (${((Date.now() - newest) / 3600000).toFixed(1)} h ago). The collector may have stopped.`
        : 'No auction data found yet.';
    }
    if (tokenExpiry && tokenExpiry - Date.now() < TOKEN_WARN_MS) {
      conditions.token = `The GitHub token for the sync expires ${new Date(tokenExpiry).toLocaleDateString()}. Make a new one (CLAUDE.md, Collector).`;
    }
    state.githubFailures = 0;
  } catch (e) {
    state.githubFailures++;
    log(`GitHub: ${e.message}`);
    // A single failure is often just the network not being up yet at logon.
    if (state.githubFailures >= 2 || /token/.test(e.message)) conditions.github = `Can't reach GitHub: ${e.message}`;
    else if (state.alerts.github) conditions.github = state.alerts.github.message;
  }
} catch (e) {
  conditions.crash = e.message;
  log(`error: ${e.stack || e.message}`);
}

// ---- alerts ----
if (!dryRun) {
  const { notify, state: alerts } = updateAlerts(conditions, state.alerts, Date.now());
  state.alerts = alerts;
  for (const n of notify) { log(`notify: ${n.title}: ${n.message}`); toast(n.title, n.message, ACTIONS_URL); }
  for (const e of events) { log(`notify: ${e.title}: ${e.message}`); toast(e.title, e.message, e.url); }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
} else {
  for (const [k, m] of Object.entries(conditions)) log(`(dry run) would alert ${k}: ${m}`);
  for (const e of events) log(`(dry run) would notify: ${e.title}: ${e.message}`);
}
log(`done: ${stored} snapshot(s) in ${((Date.now() - started) / 1000).toFixed(1)} s, peak memory ${Math.round(process.resourceUsage().maxRSS / 1024)} MB, ${Object.keys(conditions).length} problem(s)`);
fs.rmSync(lockPath, { force: true });
