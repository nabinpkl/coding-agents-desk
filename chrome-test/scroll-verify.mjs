// ADR-0047 scroll-drive-back autonomous gate (`just dom-mirror-scroll-verify`): the WRITE path,
// deterministic, no simulator. Modeled on input-verify.mjs.
//
// A real extension in a throwaway Chrome-for-Testing profile records a TALL fixture (so the projection
// session has one recorded tab), then a fake host (standing in for DomBridgeServer.sendToBridge) sends a
// `dom-scroll` command through the shim to the extension worker, which drives the REAL tab to scroll
// as a trusted CDP mouse-wheel event (Input.dispatchMouseEvent{mouseWheel}) via chrome.debugger. The harness observes
// window.scrollY (page.evaluate, from the harness side) to confirm the live page actually scrolled,
// and in the direction the sign convention promises: dx/dy are the phone's FINGER delta (positive dy
// = finger down); the worker negates them so content follows the finger, i.e. finger UP (dy<0)
// scrolls the page DOWN (scrollY increases). This covers shim -> worker -> chrome.debugger (the risky
// new piece); the host-side DomScrollCommand decode/forward is unit-tested, and the phone-drag
// round-trip is confirmed at the physical run.

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
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'scroll-page.html'), 'utf8');
const TOKEN = 'scroll-verify-token';
// The gesture anchor (page CSS px) must land over the scrollable body. dy is the FINGER delta.
const ANCHOR_X = 200, ANCHOR_Y = 300;
const FINGER_UP_DY = -600;   // finger drags up -> page scrolls DOWN (scrollY increases)
const FINGER_DOWN_DY = 600;  // finger drags down -> page scrolls UP (scrollY decreases)

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const extId = extensionId();
const work = mkdtempSync(join(tmpdir(), 'dom-scroll-verify-'));
const socketPath = join(work, 'bridge.sock');
const tokenPath = join(work, 'token');
const userDataDir = join(work, 'chrome-profile');
// Wrapper goes inside the throwaway work dir, not the repo default, so a run here never writes over
// or deletes a live install's wrapper (the launcher real Chrome spawns).
const wrapperPath = join(work, 'dom-bridge');
writeFileSync(tokenPath, TOKEN + '\n');

const failures = [];
const check = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} - ${m}`); if (!c) failures.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake host: token-authed, counts batches (to know recording started), and can send a dom-scroll.
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

// Send a dom-scroll (as the host's sendToBridge would) and return the SETTLED scrollY change.
// A wheel event applies instantly, but Chrome may smooth-animate a large single delta, so we still
// poll until scrollY is stable across consecutive samples rather than reading once.
async function driveScroll(page, dy) {
  const before = await page.evaluate(() => window.scrollY);
  if (host.conn) host.conn.write(JSON.stringify({ t: 'dom-scroll', x: ANCHOR_X, y: ANCHOR_Y, dx: 0, dy }) + '\n');
  let last = before, stable = 0;
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    const now = await page.evaluate(() => window.scrollY);
    if (Math.abs(now - last) < 1) { stable++; if (stable >= 3 && i >= 5) break; } else stable = 0;
    last = now;
  }
  return { before, after: last, delta: last - before };
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
  await page.goto(`http://127.0.0.1:${port}/scroll-page.html`, { waitUntil: 'load' });

  // Sanity: the fixture is actually tall enough to scroll.
  const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  check(scrollable > 500, `fixture is scrollable (scrollHeight - viewport = ${scrollable}px)`);

  // Start recording from the CHROME layer (ADR-0042): drive the service worker, which sets the
  // worker's authoritative recorded tab, the precondition for ADR-0047 scroll dispatch. No URL param.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch {} }
  if (!sw) throw new Error('service worker not found; cannot start recording');
  await sw.evaluate(() => startBrowserProjection());

  // Wait until a batch proves that the projection session's recorder is running.
  for (let i = 0; i < 40 && host.batches === 0; i++) await sleep(250);
  check(host.authed, 'shim authenticated to the host');
  check(host.batches > 0, 'projection session has one recorded tab');

  // Finger drags UP -> the live page scrolls DOWN (scrollY increases).
  const down = await driveScroll(page, FINGER_UP_DY);
  check(down.delta > 50, `finger-up gesture scrolled the live page DOWN (scrollY ${down.before} -> ${down.after})`);

  // Finger drags DOWN -> the page scrolls back UP (scrollY decreases). Proves the sign both ways.
  const up = await driveScroll(page, FINGER_DOWN_DY);
  check(up.delta < -50, `finger-down gesture scrolled the live page UP (scrollY ${up.before} -> ${up.after})`);
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { hostServer.close(); } catch {}
  try { fixtureServer.close(); } catch {}
  // Everything this run generated (manifest, wrapper, socket, token, profile) lives inside `work`,
  // so a single recursive removal cleans up and no repo path is ever touched.
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const watchdog = setTimeout(() => { console.error('dom-mirror-scroll-verify: TIMEOUT'); teardown().finally(() => process.exit(2)); }, 90000);
watchdog.unref();

main().then(async () => {
  await teardown(); clearTimeout(watchdog);
  if (failures.length) { console.error(`\ndom-mirror-scroll-verify: ${failures.length} FAILED`); process.exit(1); }
  console.log('\ndom-mirror-scroll-verify: all checks passed');
  process.exit(0);
}).catch(async (e) => { console.error('dom-mirror-scroll-verify: ERROR', e); await teardown(); process.exit(3); });
