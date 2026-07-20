// ADR-0048 device-emulation autonomous gate (`just dom-mirror-emulate-verify`): the emulate WRITE
// path + authoritative echo, deterministic, no simulator. Modeled on input-verify.mjs / scroll-verify.mjs.
//
// A real extension in a throwaway Chrome-for-Testing profile records a fixture; a fake host (standing
// in for DomBridgeServer.sendToBridge) sends `dom-emulate {mobile:true}` through the shim to the
// extension worker, which device-emulates the recorded tab via chrome.debugger and asks the recorder
// to resnapshot. The harness asserts, from the batches the fake host receives, that:
//   - after mobile, a fresh checkout batch reports meta.w ~= 390 (the emulated iPhone viewport, read by
//     the content script INSIDE the real page) and carries em:true (the authoritative echo);
//   - after desktop, a fresh checkout batch restores the original width and carries em:false.
// This covers shim -> worker -> chrome.debugger emulation + the resnapshot handshake + the em stamp;
// the host relay's em -> dom-status fan-out is unit-tested, and the on-phone toggle is the physical run.

import net from 'node:net';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionId } from './ext-id.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const EXT_DIR = join(REPO, 'chrome-extension');
const INSTALLER = join(REPO, 'dom-bridge', 'install.mjs');
// A viewport-meta (width=device-width) fixture, so mobile emulation drives window.innerWidth to the
// emulated device width (390); page.html has no viewport meta and would fall back to 980.
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'emulate-page.html'), 'utf8');
const TOKEN = 'emulate-verify-token';
const MOBILE_W = 390; // must match worker.js setDeviceMetricsOverride width

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const extId = extensionId();
const work = mkdtempSync(join(tmpdir(), 'dom-emulate-verify-'));
const socketPath = join(work, 'bridge.sock');
const tokenPath = join(work, 'token');
const userDataDir = join(work, 'chrome-profile');
const wrapperPath = join(work, 'dom-bridge');
writeFileSync(tokenPath, TOKEN + '\n');

const failures = [];
const check = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} - ${m}`); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake host: token-authed; records each dom-batch's checkout flag, em stamp, and meta.w (all present
// uncompressed on the batch line) so the harness can assert the emulated viewport + echo.
const host = { authed: false, batches: [], conn: null };
const hostServer = net.createServer((socket) => {
  host.conn = socket;
  let acc = '';
  socket.on('data', (chunk) => {
    acc += chunk.toString('utf8');
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl); acc = acc.slice(nl + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!host.authed) { host.authed = o.t === 'auth' && o.token === TOKEN; continue; }
      if (o.t === 'dom-batch') host.batches.push({ co: !!o.co, em: !!o.em, w: o.meta && o.meta.w });
    }
  });
  socket.on('error', () => {});
});
const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});

// Send a dom-emulate and wait for the resulting checkout batch (the resnapshot) that carries a meta.w.
// Returns that batch, or null on timeout.
async function toggleEmulate(mobile) {
  const from = host.batches.length;
  if (host.conn) host.conn.write(JSON.stringify({ t: 'dom-emulate', mobile }) + '\n');
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    const fresh = host.batches.slice(from).filter((b) => b.co && typeof b.w === 'number');
    if (fresh.length) return fresh[fresh.length - 1];
  }
  return null;
}

let ctx = null;
async function main() {
  await new Promise((r) => hostServer.listen(socketPath, r));
  await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
  const port = fixtureServer.address().port;

  mkdirSync(userDataDir, { recursive: true });
  const nmDir = join(userDataDir, 'NativeMessagingHosts');
  const install = spawnSync('node', [INSTALLER, '--ext-id', extId, '--nmdir', nmDir, '--socket', socketPath, '--token', tokenPath, '--wrapper', wrapperPath], { encoding: 'utf8' });
  if (install.status !== 0) { console.error(install.stdout, install.stderr); throw new Error('install failed'); }

  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--no-default-browser-check'],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/emulate-page.html`, { waitUntil: 'load' });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch {} }
  if (!sw) throw new Error('service worker not found; cannot start recording');
  await sw.evaluate(() => startBrowserProjection());

  // Wait for the first (desktop) checkout batch so we know the recorder is running and capture the
  // desktop width the page reports.
  let desktopW = null;
  for (let i = 0; i < 40 && desktopW == null; i++) {
    await sleep(250);
    const co = host.batches.filter((b) => b.co && typeof b.w === 'number');
    if (co.length) desktopW = co[co.length - 1].w;
  }
  check(host.authed, 'shim authenticated to the host');
  check(desktopW != null && desktopW > MOBILE_W, `recorder running; desktop viewport width ${desktopW} (> ${MOBILE_W})`);

  // Toggle Mobile: the real tab device-emulates and resnapshots; the checkout reports the iPhone width.
  const mobile = await toggleEmulate(true);
  check(!!mobile, 'mobile toggle produced a fresh resnapshot checkout batch');
  check(mobile && Math.abs(mobile.w - MOBILE_W) <= 8, `emulated viewport width ~= ${MOBILE_W} (got ${mobile && mobile.w})`);
  check(mobile && mobile.em === true, 'the emulated batch carries em:true (authoritative echo)');

  // Toggle Desktop: restored width, em:false.
  const desktop = await toggleEmulate(false);
  check(!!desktop, 'desktop toggle produced a fresh resnapshot checkout batch');
  check(desktop && desktop.w > MOBILE_W, `restored desktop viewport width (${desktop && desktop.w} > ${MOBILE_W})`);
  check(desktop && desktop.em === false, 'the restored batch carries em:false');
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { hostServer.close(); } catch {}
  try { fixtureServer.close(); } catch {}
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const watchdog = setTimeout(() => { console.error('dom-mirror-emulate-verify: TIMEOUT'); teardown().finally(() => process.exit(2)); }, 90000);
watchdog.unref();

main().then(async () => {
  await teardown(); clearTimeout(watchdog);
  if (failures.length) { console.error(`\ndom-mirror-emulate-verify: ${failures.length} FAILED`); process.exit(1); }
  console.log('\ndom-mirror-emulate-verify: all checks passed');
  process.exit(0);
}).catch(async (e) => { console.error('dom-mirror-emulate-verify: ERROR', e); await teardown(); process.exit(3); });
