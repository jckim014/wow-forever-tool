// WoW Forever auction collector. Runs in GitHub Actions (.github/workflows/collect.yml) every 20 minutes.
// Fetches every auction house's auctions and commodities from the Blizzard API, but only what changed since the
// last run (If-Modified-Since), checks them, and writes the raw responses (gzipped, unchanged) plus a manifest to
// OUT_DIR for the workflow to upload as a snapshot. State between runs (Last-Modified and listing counts per house,
// and the encrypted access token) lives in STATE_DIR, kept by the workflow's cache.
//
// Env: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET, TOKEN_CACHE_KEY (required); STATE_DIR, OUT_DIR (optional).
// Exit code 1 if anything needs attention; files and state are written first, so nothing fetched is lost.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {
  EXPECTED_HOUSES, KINDS, checkHouseList, checkHouseData, checkShrink, checkStale, snapshotId,
  tokenUsable, encryptJson, decryptJson, dailyCheckDue, waitingSnapshotsProblem,
} from './lib.mjs';

const API = 'https://us.api.blizzard.com';
const NAMESPACE = 'dynamic-forever-us';
const RULESET = 2; // every ruleset lists the same houses; 2 = Normal
const PAUSE_MS = 1000; // between requests
const RETRY_PAUSE_MS = 10000;

const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
};
const clientId = env('BLIZZARD_CLIENT_ID');
const clientSecret = env('BLIZZARD_CLIENT_SECRET');
const cacheKey = env('TOKEN_CACHE_KEY');
const stateDir = process.env.STATE_DIR || 'collector-state';
const outDir = process.env.OUT_DIR || 'collector-out';
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const notes = [];
let requests = 0;

// ---- state ----
const statePath = path.join(stateDir, 'state.json');
const tokenPath = path.join(stateDir, 'token.enc');
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
let state = { houses: {} };
try { state = JSON.parse(readText(statePath) ?? '') ?? state; } catch { notes.push('no previous state: fetching everything'); }
state.houses ??= {};

// ---- token ----
let token = decryptJson(readText(tokenPath) ?? '', cacheKey);
let tokenFetched = false;

async function newToken() {
  requests++;
  const res = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.access_token || !Number.isFinite(j.expires_in)) throw new Error('token response has no access_token/expires_in');
  token = { accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  tokenFetched = true;
  fs.writeFileSync(tokenPath, encryptJson(token, cacheKey));
}

/** GET with the token; on 401 gets one new token and retries once. Returns { status, headers, body (Buffer) }. */
async function apiGet(p, extraHeaders = {}) {
  let refreshed = false;
  for (;;) {
    await sleep(PAUSE_MS);
    requests++;
    const res = await fetch(`${API}${p}?locale=en_US`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Battlenet-Namespace': NAMESPACE, ...extraHeaders },
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.status === 401 && !refreshed) {
      notes.push('token rejected early: got a new one');
      await newToken();
      refreshed = true;
      continue;
    }
    return { status: res.status, headers: res.headers, body };
  }
}

/** apiGet with one retry after a pause on network errors and 5xx. 429 is never retried. */
async function apiGetRetry(p, extraHeaders) {
  try {
    const r = await apiGet(p, extraHeaders);
    if (r.status < 500) return r;
  } catch { /* retry below */ }
  await sleep(RETRY_PAUSE_MS);
  return apiGet(p, extraHeaders);
}

// ---- run ----
const SENTINEL_HOUSE = 111;
const rows = [];
const files = [];
const newFields = new Set();
let ifModifiedSinceWorks = null;

/** Conditional GET of one house; returns the response, or { status: 'error', error } on a network failure. */
async function fetchHouse(house, kind) {
  const prev = state.houses[house]?.[kind];
  const p = `/data/wow/ruleset/${RULESET}/auctions/${house}${kind === 'commodities' ? '/commodities' : ''}`;
  try {
    return await apiGetRetry(p, prev?.lastModified ? { 'If-Modified-Since': prev.lastModified } : {});
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

/** Checks and stores one house response. Returns 'new', 'unchanged', 'failed' or 'stop' (429). */
function handle(house, kind, r) {
  const prev = state.houses[house]?.[kind];
  const label = `house ${house} ${kind}`;
  if (r.status === 'error') {
    problems.push(`${label}: ${r.error}`);
    rows.push([house, kind, 'error', '', '', '']);
    return 'failed';
  }
  if (r.status === 429) {
    problems.push(`${label}: HTTP 429 (too many requests), stopped this run`);
    rows.push([house, kind, 'HTTP 429', '', '', '']);
    return 'stop';
  }
  if (r.status === 304) {
    ifModifiedSinceWorks = true;
    rows.push([house, kind, 'unchanged', prev.listings, '', prev.lastModified]);
    return 'unchanged';
  }
  if (r.status !== 200) {
    problems.push(`${label}: HTTP ${r.status}`);
    rows.push([house, kind, `HTTP ${r.status}`, '', '', '']);
    return 'failed';
  }
  const lastModified = r.headers.get('last-modified');
  if (!lastModified) problems.push(`${label}: no Last-Modified header`);
  if (prev?.lastModified && lastModified === prev.lastModified) {
    // Blizzard sent the same data again instead of 304: nothing new to keep.
    ifModifiedSinceWorks ??= false;
    rows.push([house, kind, 'unchanged (sent again)', prev.listings, '', lastModified]);
    return 'unchanged';
  }
  let json;
  try {
    json = JSON.parse(r.body.toString('utf8'));
  } catch {
    problems.push(`${label}: response is not JSON`);
    rows.push([house, kind, 'not JSON', '', '', lastModified]);
    return 'failed';
  }
  const check = checkHouseData(json, kind);
  for (const e of check.errors) problems.push(`${label}: ${e}`);
  for (const f of check.newFields) newFields.add(f);
  const shrink = checkShrink(prev?.listings, check.listings);
  if (shrink) problems.push(`${label}: ${shrink}`);

  const name = `house-${house}-${kind}.json.gz`;
  const gz = zlib.gzipSync(r.body);
  fs.writeFileSync(path.join(outDir, name), gz);
  files.push({
    file: name, house, kind, lastModified, listings: check.listings, items: check.items,
    bytes: r.body.length, gzBytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex'),
  });
  state.houses[house] ??= {};
  state.houses[house][kind] = { lastModified, listings: check.listings };
  rows.push([house, kind, 'new', check.listings, check.items, lastModified]);
  return 'new';
}

try {
  if (!tokenUsable(token, Date.now())) await newToken();

  // Sentinel: all houses refresh within seconds of each other (seen 2026-11-12), so if house 111's auctions are
  // unchanged, nothing is new and the run stops after this one request. Skipped when the state is incomplete.
  const complete = EXPECTED_HOUSES.every((h) => KINDS.every((k) => state.houses[h]?.[k]?.lastModified));
  let sentinel = null;
  let idle = false;
  if (complete) {
    sentinel = await fetchHouse(SENTINEL_HOUSE, 'auctions');
    if (sentinel.status === 304) {
      idle = true;
      rows.push([SENTINEL_HOUSE, 'auctions', 'unchanged: other houses not checked', state.houses[SENTINEL_HOUSE].auctions.listings, '', state.houses[SENTINEL_HOUSE].auctions.lastModified]);
    }
  }

  if (!idle && sentinel?.status !== 429) {
    const index = await apiGetRetry(`/data/wow/ruleset/${RULESET}/auctions/`);
    if (index.status !== 200) throw new Error(`house list: HTTP ${index.status}`);
    const listProblem = checkHouseList(JSON.parse(index.body.toString('utf8')));
    if (listProblem) problems.push(listProblem);

    const unchangedOthers = [];
    outer: for (const house of EXPECTED_HOUSES) {
      for (const kind of KINDS) {
        const isSentinel = house === SENTINEL_HOUSE && kind === 'auctions';
        const r = isSentinel && sentinel ? sentinel : await fetchHouse(house, kind);
        const status = handle(house, kind, r);
        if (status === 'stop') break outer;
        if (status === 'unchanged' && !isSentinel) unchangedOthers.push(`${house} ${kind}`);
      }
    }
    if (sentinel && unchangedOthers.length) {
      problems.push(`houses no longer refresh together (house ${SENTINEL_HOUSE} changed, these did not: ${unchangedOthers.join(', ')}); the one-house check may now miss data`);
    }
  } else if (sentinel?.status === 429) {
    handle(SENTINEL_HOUSE, 'auctions', sentinel);
  }

  const stale = checkStale(
    Object.values(state.houses).flatMap((h) => KINDS.map((k) => h[k]?.lastModified)).filter(Boolean),
    Date.now(),
  );
  if (stale) problems.push(stale);
} catch (e) {
  problems.push(`run stopped: ${e.message}`);
}

// Daily (first run after 17:00 UTC): snapshots waiting on GitHub for over 2 days mean the PC sync has stopped
// picking them up, and they are lost after 90 days. Fails this one run so GitHub emails. Needs GITHUB_TOKEN (actions: read).
let syncCheck = '';
if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY && (process.env.SYNC_CHECK_NOW === '1' || dailyCheckDue(state.syncCheckDay, Date.now()))) {
  try {
    const artifacts = [];
    for (let page = 1; page <= 10; page++) {
      const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!res.ok) throw new Error(`listing artifacts: HTTP ${res.status}`);
      const j = await res.json();
      artifacts.push(...j.artifacts);
      if (j.artifacts.length < 100) break;
    }
    const p = waitingSnapshotsProblem(artifacts, Date.now());
    if (p) problems.push(p);
    syncCheck = p ? 'problem (see above)' : `ok (${artifacts.filter((a) => a.name.startsWith('snapshot-') && !a.expired).length} snapshots waiting, none over 2 days)`;
  } catch (e) {
    problems.push(`daily sync check: ${e.message}`);
    syncCheck = 'failed';
  }
  state.syncCheckDay = new Date().toISOString().slice(0, 10);
}

if (newFields.size) notes.push(`new fields in the API data: ${[...newFields].join(', ')}`);
if (ifModifiedSinceWorks === false) notes.push('Blizzard ignored If-Modified-Since: unchanged data was downloaded again');

// ---- outputs ----
fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
let snapshot = '';
if (files.length) {
  snapshot = snapshotId(files.map((f) => f.lastModified).filter(Boolean));
  const manifest = {
    format: 'forever-auction-snapshot', version: 1, snapshot, region: 'us', namespace: NAMESPACE, ruleset: RULESET,
    collectedAt: new Date().toISOString(), files, newFields: [...newFields].sort(), problems, notes,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
}

const summary = [
  `## Auction collector ${snapshot ? `- snapshot ${snapshot}` : '- nothing new'}`,
  '',
  ...(syncCheck ? [`Daily PC sync check: ${syncCheck}.`, ''] : []),
  `Requests: ${requests} (token ${tokenFetched ? 'fetched' : tokenUsable(token, Date.now()) ? 'reused from cache' : 'not available'}).`,
  '',
  ...(problems.length ? ['### Problems', ...problems.map((p) => `- ${p}`), ''] : []),
  ...(notes.length ? ['### Notes', ...notes.map((n) => `- ${n}`), ''] : []),
  '| House | Kind | Status | Listings | Items | Last-Modified |',
  '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.join(' | ')} |`),
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `snapshot=${snapshot}\n`);
for (const p of problems) console.log(`::error::${p}`);
for (const n of notes) console.log(`::warning::${n}`);
process.exitCode = problems.length ? 1 : 0;
