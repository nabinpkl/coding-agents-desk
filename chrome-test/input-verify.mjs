// Phase 5 autonomous gate (`just dom-mirror-input-verify`): the WRITE path, deterministic, no sim.
//
// Real extension in a throwaway Chrome-for-Testing profile records the fixture (so the worker's
// recordingTabId is set), then a fake host (standing in for DomBridgeServer.sendToBridge) sends a
// `dom-input` command through the shim to the extension worker, which dispatches it as TRUSTED input
// via chrome.debugger. The click is observed by a listener the HARNESS injects into the fixture via
// Playwright (page.evaluate bypasses the page CSP and coexists with the extension's chrome.debugger),
// so no test instrumentation ships in the extension. This covers shim -> worker -> chrome.debugger
// (the risky new piece); the host-side DomInputCommand decode + forward is unit-tested, and the
// phone-tap round-trip is confirmed at the physical run.

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
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'page.html'), 'utf8');
const TOKEN = 'input-verify-token';
const TAP_X = 100, TAP_Y = 60;

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const extId = extensionId();
const work = mkdtempSync(join(tmpdir(), 'dom-input-verify-'));
const socketPath = join(work, 'bridge.sock');
const tokenPath = join(work, 'token');
const userDataDir = join(work, 'chrome-profile');
// Wrapper goes inside the throwaway work dir, not the repo default (`dom-bridge/dom-bridge`), so a
// run here never writes over or deletes a live install's wrapper (the launcher real Chrome spawns).
const wrapperPath = join(work, 'dom-bridge');
writeFileSync(tokenPath, TOKEN + '\n');

const failures = [];
const check = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} - ${m}`); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake host: token-authed, counts batches (to know recording started), and can send a dom-input.
const host = { authed: false, batches: 0, conn: null };
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
      if (!host.authed) host.authed = o.t === 'auth' && o.token === TOKEN;
      else if (o.t === 'dom-batch') host.batches++;
    }
  });
  socket.on('error', () => {});
});
const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});

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
  await page.goto(`http://127.0.0.1:${port}/page.html`, { waitUntil: 'load' });

  // Observe clicks from the harness side (bypasses page CSP; coexists with the extension's
  // chrome.debugger). Capture phase so it sees the click first.
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener('click', (e) => window.__clicks.push({ x: e.clientX, y: e.clientY, trusted: e.isTrusted }), true);
  });

  // Start recording from the CHROME layer (ADR-0042): drive the service worker, which sets the
  // worker's recordingTabId -- the precondition for ADR-0040 tap dispatch. No URL param.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch {} }
  if (!sw) throw new Error('service worker not found; cannot start recording');
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true });
    await startTabRecording(t.id);
  });

  // Wait until the recorder is running (a batch arrived) so the worker's recordingTabId is set.
  for (let i = 0; i < 40 && host.batches === 0; i++) await sleep(250);
  check(host.authed, 'shim authenticated to the host');
  check(host.batches > 0, 'recorder running (recordingTabId set on the worker)');

  // Send a dom-input command down to the shim (as the host's sendToBridge would).
  if (host.conn) host.conn.write(JSON.stringify({ t: 'dom-input', k: 'mouse', x: TAP_X, y: TAP_Y }) + '\n');

  // Wait for the extension to dispatch a trusted click, observed by the injected listener.
  let clicks = [];
  for (let i = 0; i < 40 && clicks.length === 0; i++) { await sleep(250); clicks = await page.evaluate(() => window.__clicks); }
  const click = clicks[0];
  check(!!click, 'extension dispatched a click (chrome.debugger)');
  check(click && click.trusted === true, 'the click was isTrusted:true (real gesture, not synthetic)');
  check(click && Math.abs(click.x - TAP_X) <= 2 && Math.abs(click.y - TAP_Y) <= 2,
    `click landed at the mapped coordinate (~${TAP_X},${TAP_Y}) -> got (${click && click.x},${click && click.y})`);
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { hostServer.close(); } catch {}
  try { fixtureServer.close(); } catch {}
  // Everything this run generated (manifest, wrapper, socket, token, profile) lives inside `work`,
  // so a single recursive removal cleans up and no repo path is ever touched.
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const watchdog = setTimeout(() => { console.error('dom-mirror-input-verify: TIMEOUT'); teardown().finally(() => process.exit(2)); }, 60000);
watchdog.unref();

main().then(async () => {
  await teardown(); clearTimeout(watchdog);
  if (failures.length) { console.error(`\ndom-mirror-input-verify: ${failures.length} FAILED`); process.exit(1); }
  console.log('\ndom-mirror-input-verify: all checks passed');
  process.exit(0);
}).catch(async (e) => { console.error('dom-mirror-input-verify: ERROR', e); await teardown(); process.exit(3); });
