// Opens Forever Market: starts the local server if it isn't running (hidden, detached; it stops by itself 10 minutes
// after the last tab closes), waits until it answers, then opens http://localhost:<port>/ in the default browser.
// Run by the forever-market:// link (install.ps1 registers it; Chrome bookmark "forever-market://open").
// FOREVER_MARKET_NO_BROWSER=1 skips opening the browser (for tests).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FOREVER_MARKET_PORT) || 5310;
const URL = `http://localhost:${PORT}/`;
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function alive() {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/api/heartbeat`, { method: 'POST' })).status === 204;
  } catch {
    return false;
  }
}

if (!(await alive())) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(here, 'server.mjs')], {
    detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
  });
  child.unref();
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) { await sleep(250); ok = await alive(); }
  if (!ok) { console.error('Forever Market did not start within 10 s'); process.exit(1); }
}
if (process.env.FOREVER_MARKET_NO_BROWSER !== '1') {
  spawn('cmd.exe', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
console.log(`Forever Market: ${URL}`);
