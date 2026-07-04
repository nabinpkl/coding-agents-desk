// Phase 2 autonomous gate (`just dom-mirror-record-verify`) AND the live-Chrome native-messaging
// manifest-path confirmation deferred from Phase 1.
//
// Real path exercised: real extension (rrweb, MAIN-world, masking ON) in a throwaway Chrome
// profile -> real connectNative -> real shim -> a protocol-faithful fake host. Asserts: a checkout
// batch arrives, events are non-trivial, the sentinel heading is present (capture works), and the
// password secret is ABSENT (masking works). The real Swift DomBridgeServer is covered by unit
// tests; the shim<->real-host one-process integration is a Phase-3 gate.

import net from 'node:net';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionId } from './ext-id.mjs';

// Playwright is installed globally, not in a local node_modules; ESM `import` ignores NODE_PATH,
// so resolve it from the global root at runtime (env override for unusual setups).
const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) throw new Error('could not load playwright chromium from ' + PW_ROOT);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const EXT_DIR = join(REPO, 'chrome-extension');
const INSTALLER = join(REPO, 'dom-bridge', 'install.mjs');
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'page.html'), 'utf8');
const CAPTURE_MARKER = 'dommirror-capture-ok';       // data-attribute value: survives masking -> capture proof
const VISIBLE_TEXT = 'VISIBLE_BODY_SENTINEL_7C3A';    // visible text node -> must be masked (absent)
const USER_TEXT = 'alice-visible-USERTEXT';           // text-input value -> must be masked (absent)
const SECRET = 'SUPERSECRET_PW_ZZZ99';                // password value -> must be masked (absent)
const TOKEN = 'record-verify-token';

const extId = extensionId();
const work = mkdtempSync(join(tmpdir(), 'dom-record-verify-'));
const socketPath = join(work, 'bridge.sock');
const tokenPath = join(work, 'token');
const userDataDir = join(work, 'chrome-profile');
writeFileSync(tokenPath, TOKEN + '\n');

const failures = [];
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`); if (!cond) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- fake host on the temp socket (token auth + newline JSON), records batches ---
const host = { authed: false, batches: [], bytes: 0 };
const hostServer = net.createServer((socket) => {
  let acc = '';
  socket.on('data', (chunk) => {
    host.bytes += chunk.length;
    acc += chunk.toString('utf8');
    let nl;
    while ((nl = acc.indexOf('\n')) >= 0) {
      const line = acc.slice(0, nl); acc = acc.slice(nl + 1);
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      if (!host.authed) host.authed = obj.t === 'auth' && obj.token === TOKEN;
      else if (obj.t === 'dom-batch') host.batches.push(obj);
    }
  });
  socket.on('error', () => {});
});

// --- static server for the CSP-strict fixture ---
const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});

let ctx = null;
async function main() {
  await new Promise((r) => hostServer.listen(socketPath, r));
  await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
  const port = fixtureServer.address().port;

  // Chrome for Testing reads native-messaging manifests from <user-data-dir>/NativeMessagingHosts/,
  // so install there: the manifest lives entirely inside the throwaway profile and touches no real
  // Chrome config. The shim is pointed at our temp socket/token via the wrapper env.
  mkdirSync(userDataDir, { recursive: true });
  const nmDir = join(userDataDir, 'NativeMessagingHosts');
  const install = spawnSync('node', [INSTALLER, '--ext-id', extId, '--nmdir', nmDir,
    '--socket', socketPath, '--token', tokenPath], { encoding: 'utf8' });
  if (install.status !== 0) { console.error(install.stdout, install.stderr); throw new Error('install failed'); }
  console.log(`  ..  - installed NM manifest for ext ${extId} into the throwaway profile`);

  // Playwright's bundled Chromium (Google Chrome for Testing) honors --load-extension, which stable
  // Chrome 137+ disabled. That's why the harness uses it rather than the system Chrome channel.
  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/page.html?agentdesk_record=1`, { waitUntil: 'load' });

  // Wait (bounded) for a checkout batch to reach the host through the whole real chain.
  for (let i = 0; i < 60 && !host.batches.some((b) => b.co); i++) await sleep(250);

  // --- diagnostics (printed always; the chain has many links) ---
  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch {} }
  let swId = null, nativeProbe = null;
  if (sw) {
    try { swId = await sw.evaluate(() => chrome.runtime.id); } catch (e) { swId = 'eval-err:' + e.message; }
    try {
      nativeProbe = await sw.evaluate(() => new Promise((res) => {
        try {
          const p = chrome.runtime.connectNative('com.example.agentdesk.agentdesk.dom_bridge');
          let done = false;
          const finish = (v) => { if (!done) { done = true; res(v); } };
          p.onDisconnect.addListener(() => finish('disconnect:' + (chrome.runtime.lastError && chrome.runtime.lastError.message)));
          p.onMessage.addListener(() => finish('message'));
          setTimeout(() => finish('connected-no-event'), 2500);
        } catch (e) { res('throw:' + e.message); }
      }));
    } catch (e) { nativeProbe = 'probe-eval-err:' + e.message; }
  }
  const pageStarted = await page.evaluate(() => !!window.__agentdeskDomMirrorStarted).catch(() => 'err');
  console.log(`  ..  - SW present: ${!!sw}, ext id: ${swId} (expected ${extId})`);
  console.log(`  ..  - recorder started on page (MAIN world flag): ${pageStarted}`);
  console.log(`  ..  - native connect probe: ${nativeProbe}`);

  const allEvents = host.batches.flatMap((b) => b.ev || []);
  const json = JSON.stringify(host.batches);
  check(host.authed, 'shim authenticated to the host (manifest path + connectNative confirmed)');
  check(host.batches.length > 0, `host received DOM batches (${host.batches.length})`);
  check(host.batches.some((b) => b.co), 'received a checkout batch (full snapshot for late-join)');
  check(allEvents.length > 0, `batches carried rrweb events (${allEvents.length})`);
  check(json.includes(CAPTURE_MARKER), 'DOM structure captured (data-attribute marker present)');
  check(!json.includes(VISIBLE_TEXT), 'visible body text MASKED (absent from stream)');
  check(!json.includes(USER_TEXT), 'text-input value MASKED (absent from stream)');
  check(!json.includes(SECRET), 'password value MASKED (absent from stream)');
  console.log(`  ..  - wire bytes received: ${(host.bytes / 1024).toFixed(1)} KB`);
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { hostServer.close(); } catch {}
  try { fixtureServer.close(); } catch {}
  // The manifest lives inside the throwaway profile (removed with `work`); just clean the
  // generated wrapper in the repo so nothing is left behind.
  try { rmSync(join(REPO, 'dom-bridge', 'dom-bridge'), { force: true }); } catch {}
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const watchdog = setTimeout(() => { console.error('dom-mirror-record-verify: TIMEOUT'); teardown().finally(() => process.exit(2)); }, 60000);
watchdog.unref();

main()
  .then(async () => {
    await teardown();
    clearTimeout(watchdog);
    if (failures.length) { console.error(`\ndom-mirror-record-verify: ${failures.length} FAILED`); process.exit(1); }
    console.log('\ndom-mirror-record-verify: all checks passed');
    process.exit(0);
  })
  .catch(async (e) => { console.error('dom-mirror-record-verify: ERROR', e); await teardown(); process.exit(3); });
