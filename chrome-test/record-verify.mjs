// Phase 2 autonomous gate (`just dom-mirror-record-verify`) AND the live-Chrome native-messaging
// manifest-path confirmation deferred from Phase 1.
//
// Real path exercised: real extension (rrweb in an isolated world, password masking ON) in a throwaway Chrome
// profile -> real connectNative -> real shim -> a protocol-faithful fake host. Asserts: a checkout
// batch arrives, events are non-trivial, the sentinel heading is present (capture works), and the
// ordinary content is PRESENT while the password secret is ABSENT. The real Swift DomBridgeServer is covered by unit
// tests; the shim<->real-host one-process integration is a Phase-3 gate.

import net from 'node:net';
import http from 'node:http';
import zlib from 'node:zlib';
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
const CAPTURE_MARKER = 'dommirror-capture-ok';        // stable data-attribute capture proof
const VISIBLE_TEXT = 'VISIBLE_BODY_SENTINEL_7C3A';    // visible text node -> must be present
const RRWEB_CLASS_TEXT = 'RRWEB_DEFAULT_CLASS_TEXT_VISIBLE_91B2'; // rrweb's default mask class must not redact
const USER_TEXT = 'alice-visible-USERTEXT';           // ordinary text-input value -> must be present
const SECRET = 'SUPERSECRET_PW_ZZZ99';                // password value -> must be masked (absent)
const DYNAMIC_SECRET = 'DYNAMIC_PASSWORD_SECRET_44';  // property + attribute mutation -> must stay masked
const ATTR_TEXT = 'VISIBLE_TITLE_ATTR_ZZ99';          // ordinary title attribute -> must be present
const TOKEN = 'record-verify-token';
// ADR-0044 Tier A: the fixture applies an adopted (constructable) stylesheet via a same-origin script
// (the CSP is script-src 'self', so an inline script would be blocked). The isolated recorder must
// read its rules and ship them in a compressed `cssz` line even though rrweb can't capture them.
const ADOPTED_MARKER = 'agentdesk-adopted-probe';     // selector in the adopted rule -> asserted PRESENT (post-inflate)
const ADOPTED_COLOR = 'rgb(7, 8, 9)';                 // its declaration -> asserted PRESENT (post-inflate)
const ADOPTED_SETUP_JS =
  `const s = new CSSStyleSheet(); s.replaceSync('.${ADOPTED_MARKER}{color:${ADOPTED_COLOR};}'); document.adoptedStyleSheets = [s];`;

const extId = extensionId();
const work = mkdtempSync(join(tmpdir(), 'dom-record-verify-'));
const socketPath = join(work, 'bridge.sock');
const tokenPath = join(work, 'token');
const userDataDir = join(work, 'chrome-profile');
// Wrapper goes inside the throwaway work dir, not the repo default (`dom-bridge/dom-bridge`), so a
// run here never writes over or deletes a live install's wrapper (the launcher real Chrome spawns).
const wrapperPath = join(work, 'dom-bridge');
writeFileSync(tokenPath, TOKEN + '\n');

const failures = [];
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`); if (!cond) failures.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ADR-0043 wire decode: reassemble chunked batches by cid, then zlib-inflate each batch's base64 ev
// (node's zlib reads fflate's zlibSync output) into the rrweb events array. Mirrors the webview sink.
function decodeBatchEvents(batches) {
  const chunks = {};
  const all = [];
  for (const b of batches) {
    if (b.enc !== 'deflate-b64') { if (Array.isArray(b.ev)) all.push(...b.ev); continue; }
    let b64 = b.ev || '';
    if (b.total > 1) {
      const slot = chunks[b.cid] || (chunks[b.cid] = { total: b.total, parts: [], count: 0 });
      if (slot.parts[b.seq] === undefined) { slot.parts[b.seq] = b64; slot.count++; }
      if (slot.count < slot.total) continue;
      delete chunks[b.cid];
      b64 = slot.parts.join('');
    }
    try { all.push(...JSON.parse(zlib.inflateSync(Buffer.from(b64, 'base64')).toString('utf8'))); }
    catch { /* skip a corrupt/partial batch */ }
  }
  return all;
}

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
// Serves the shared fixture with a same-origin <script> that applies an adopted stylesheet (ADR-0044
// Tier A). Injected here at serve-time so the on-disk fixture (also used by e2e/input) is untouched.
const fixtureServer = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/adopted-setup.js')) {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    res.end(ADOPTED_SETUP_JS);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE.replace('</body>', '<script src="adopted-setup.js"></script></body>'));
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
    '--socket', socketPath, '--token', tokenPath, '--wrapper', wrapperPath], { encoding: 'utf8' });
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
  await page.goto(`http://127.0.0.1:${port}/page.html`, { waitUntil: 'load' });

  // Invisibility guard (ADR-0042): install a page-context message spy BEFORE recording starts, so if
  // any rrweb batch ever reached the page window (the old MAIN-world postMessage leak) we catch it.
  await page.evaluate((channel) => {
    window.__agentdeskLeak = { batches: 0 };
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (d && d.__agentdesk === channel) window.__agentdeskLeak.batches++;
    });
  }, 'agentdesk-dom-mirror');

  // Start recording from the CHROME layer (no URL param): drive the service worker directly.
  // Playwright cannot click the toolbar action, but it can evaluate the worker's global functions.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch {} }
  if (!sw) throw new Error('service worker not found; cannot start recording');
  await sw.evaluate(() => startBrowserProjection());

  // Wait (bounded) for a checkout batch to reach the host through the whole real chain.
  for (let i = 0; i < 60 && !host.batches.some((b) => b.co); i++) await sleep(250);
  // The adopted-CSS (cssz) line is sent right after the checkout; give it a brief extra window.
  for (let i = 0; i < 20 && !host.batches.some((b) => b.cssz); i++) await sleep(100);

  // Exercise both property/input and attribute mutation paths after the initial snapshot. Passwords
  // must remain masked for incremental events, not only for the static checkout.
  await page.evaluate((value) => {
    const password = document.querySelector('input[type="password"]');
    password.value = value;
    password.setAttribute('value', value);
    password.dispatchEvent(new Event('input', { bubbles: true }));
  }, DYNAMIC_SECRET);
  await sleep(500);

  // --- diagnostics (printed always; the chain has many links) ---
  let swId = null, nativeProbe = null;
  try { swId = await sw.evaluate(() => chrome.runtime.id); } catch (e) { swId = 'eval-err:' + e.message; }
  try {
    nativeProbe = await sw.evaluate(() => new Promise((res) => {
      try {
        const p = chrome.runtime.connectNative('agentdesk.dom_bridge');
        let done = false;
        const finish = (v) => { if (!done) { done = true; res(v); } };
        p.onDisconnect.addListener(() => finish('disconnect:' + (chrome.runtime.lastError && chrome.runtime.lastError.message)));
        p.onMessage.addListener(() => finish('message'));
        setTimeout(() => finish('connected-no-event'), 2500);
      } catch (e) { res('throw:' + e.message); }
    }));
  } catch (e) { nativeProbe = 'probe-eval-err:' + e.message; }
  // Invisibility readout (ADR-0042): the page must see none of the recorder.
  const leak = await page.evaluate(() => ({
    rrweb: typeof window.rrweb !== 'undefined',
    started: typeof window.__agentdeskDomMirrorStarted !== 'undefined',
    batches: (window.__agentdeskLeak && window.__agentdeskLeak.batches) || 0,
  })).catch(() => ({ rrweb: true, started: true, batches: -1 }));
  console.log(`  ..  - SW present: ${!!sw}, ext id: ${swId} (expected ${extId})`);
  console.log(`  ..  - page-visible recorder globals: rrweb=${leak.rrweb} started=${leak.started}; page-received batches=${leak.batches}`);
  console.log(`  ..  - native connect probe: ${nativeProbe}`);

  // ADR-0043: the wire now carries compressed base64 events (enc:'deflate-b64'), reassembled by cid
  // for chunked batches. Inflate to the real rrweb events before the content/password assertions, so
  // ordinary-content-present + password-absent are checked on the DECOMPRESSED stream (a compressed
  // blob would trivially "not include" any plaintext and hide a password-masking regression).
  const allEvents = decodeBatchEvents(host.batches);
  const json = JSON.stringify(allEvents);
  const rawWire = JSON.stringify(host.batches);
  check(host.authed, 'shim authenticated to the host (manifest path + connectNative confirmed)');
  check(host.batches.length > 0, `host received DOM batches (${host.batches.length})`);
  check(host.batches.some((b) => b.co), 'received a checkout batch (full snapshot for late-join)');
  check(host.batches.every((b) => b.enc === 'deflate-b64' && (typeof b.ev === 'string' || typeof b.cssz === 'string')),
    'batches wire-encoded as compressed base64 (ADR-0043/0044), not raw JSON');
  check(!rawWire.includes(CAPTURE_MARKER),
    'raw wire is genuinely compressed (marker absent until inflated)');
  check(allEvents.length > 0, `batches carried rrweb events (${allEvents.length})`);
  check(json.includes(CAPTURE_MARKER), 'DOM structure captured (data-attribute marker present, post-inflate)');
  check(json.includes(VISIBLE_TEXT), 'visible body text PRESENT in stream');
  check(json.includes(RRWEB_CLASS_TEXT), 'ordinary text inside rrweb default mask class PRESENT in stream');
  check(json.includes(USER_TEXT), 'ordinary text-input value PRESENT in stream');
  check(!json.includes(SECRET), 'password value MASKED (absent from stream)');
  check(!json.includes(DYNAMIC_SECRET), 'incremental password value MASKED (absent from stream)');
  check(json.includes(ATTR_TEXT), 'ordinary attribute text (title) PRESENT in stream');

  // ADR-0044 Tier A: the isolated recorder read the adopted (constructable) stylesheet rrweb can't
  // capture, and shipped it in a compressed cssz line. Assert it arrived and decompresses to the rule.
  const cssBatch = host.batches.find((b) => typeof b.cssz === 'string');
  let adoptedCss = '';
  if (cssBatch) { try { adoptedCss = zlib.inflateSync(Buffer.from(cssBatch.cssz, 'base64')).toString('utf8'); } catch {} }
  check(!!cssBatch, 'received an adopted-stylesheet (cssz) line on checkout (ADR-0044 Tier A)');
  check(adoptedCss.includes(ADOPTED_MARKER) && adoptedCss.includes(ADOPTED_COLOR),
    'adopted-stylesheet CSS captured from the isolated world (post-inflate)');
  check(!rawWire.includes(ADOPTED_MARKER), 'adopted CSS is compressed on the wire (marker absent until inflated)');
  check(leak.rrweb === false, 'page context has NO window.rrweb (recorder invisible to page JS)');
  check(leak.started === false, 'page context has NO window.__agentdeskDomMirrorStarted');
  check(leak.batches === 0, 'page received ZERO agentdesk batches (no window.postMessage leak)');
  console.log(`  ..  - wire bytes received: ${(host.bytes / 1024).toFixed(1)} KB`);
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { hostServer.close(); } catch {}
  try { fixtureServer.close(); } catch {}
  // Everything this run generated (manifest, wrapper, socket, token, profile) lives inside `work`,
  // so a single recursive removal cleans up and no repo path is ever touched.
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
