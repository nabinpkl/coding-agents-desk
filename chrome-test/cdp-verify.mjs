// ADR-0044 Tier B autonomous gate (`just dom-mirror-cdp-verify`).
//
// Proves the CDP high-fidelity path: capture a REAL DOMSnapshot.captureSnapshot (which pierces shadow
// boundaries) on a page with a CLOSED shadow root, run it through the SAME reconstructProjectionHtml the
// service worker uses (chrome-extension/cdp-reconstruct.js), and assert (a) the closed-shadow subtree
// is captured, (b) ordinary content is preserved, and (c) password values are masked. Password
// parity with rrweb is the security requirement for this tier. Uses Playwright's own CDP
// session (page.context().newCDPSession) + Chrome for Testing; the extension is not involved here.

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Per RUN, not per script, and outside the checkout. Chrome holds a SingletonLock in its
// user-data-dir, so a fixed path means a second agent running this at the same time either drives
// this browser or fails to start one; a fixed path inside the repo also leaves a profile in the
// working tree whenever a run is killed before teardown.
const work = mkdtempSync(join(tmpdir(), 'dom-mirror-cdp-verify-'));
const { reconstructProjectionHtml, CDP_STYLE_PROPS } = require(join(__dirname, '..', 'chrome-extension', 'cdp-reconstruct.js'));

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) throw new Error('could not load playwright chromium from ' + PW_ROOT);

// Sentinels: ordinary values must survive reconstruction, password values must not.
const SHADOW_MARKER = 'cdpshadowok';
const VISIBLE_VALUES = ['SHADOW_TEXT_VISIBLE', 'SHADOW_INPUT_VISIBLE', 'SHADOW_TITLE_VISIBLE', 'LIGHT_TEXT_VISIBLE', 'LIGHT_INPUT_VISIBLE', 'LIGHT_TITLE_VISIBLE'];
const PASSWORDS = ['SHADOW_PASSWORD_SECRET', 'LIGHT_PASSWORD_SECRET'];
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<style>#host p { color: rgb(1,2,3); }</style></head><body>
<div id="host"></div>
<p title="LIGHT_TITLE_VISIBLE">LIGHT_TEXT_VISIBLE</p>
<input value="LIGHT_INPUT_VISIBLE">
<input type="password" value="LIGHT_PASSWORD_SECRET">
<script>
  var sr = document.getElementById('host').attachShadow({ mode: 'closed' });
  sr.innerHTML = '<p data-shadow-marker="${SHADOW_MARKER}" title="SHADOW_TITLE_VISIBLE">SHADOW_TEXT_VISIBLE</p>'
    + '<input value="SHADOW_INPUT_VISIBLE"><input type="password" value="SHADOW_PASSWORD_SECRET">';
</script>
</body></html>`;

const failures = [];
const check = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} - ${msg}`); if (!cond) failures.push(msg); };

// Synthetic defense-in-depth check (no Chrome): a crafted snapshot whose tag/attribute NAMES carry
// HTML metacharacters must not break out of quoting or inject markup in the reconstructed string.
function checkNameInjection() {
  const strings = ['', 'div', 'x" onmouseover="evil()', 'y', 'p><script>alert(1)</script', 'hi'];
  const snap = { strings, documents: [{
    nodes: {
      parentIndex: [-1, 0, 1],
      nodeType:    [ 9, 1, 1],  // doc > div(malicious attr) > <p><script...>(malicious tag)
      nodeName:    [ 0, 1, 4],
      nodeValue:   [ 0, 0, 0],
      attributes:  [[], [2, 3], []], // div has attr name = 'x" onmouseover="evil()'
    },
    layout: { nodeIndex: [], styles: [] },
  }]};
  const html = reconstructProjectionHtml(snap);
  check(!/onmouseover/i.test(html), 'malformed attribute name dropped (no attribute-quote breakout)');
  check(!/<script/i.test(html), 'malformed tag name flattened (no injected element)');
}

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); });
let ctx = null;
async function main() {
  checkNameInjection(); // hermetic; runs before any browser work
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  ctx = await chromium.launchPersistentContext(join(work, 'chrome-profile'), {
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });

  // Sanity: the closed shadow root is NOT reachable from page JS (proves it's genuinely closed).
  const closedFromPage = await page.evaluate(() => document.getElementById('host').shadowRoot === null);
  check(closedFromPage, 'shadow root is closed (unreadable from page JS)');

  const client = await ctx.newCDPSession(page);
  const snap = await client.send('DOMSnapshot.captureSnapshot', { computedStyles: CDP_STYLE_PROPS });
  const html = reconstructProjectionHtml(snap);

  check(html.includes(SHADOW_MARKER), 'closed shadow DOM captured via CDP (data-marker present after pierce)');
  check(/<input/i.test(html) && /<p/i.test(html), 'structure reconstructed (elements present)');
  check(html.includes('style="'), 'computed styles inlined (renders without external CSS)');
  for (const value of VISIBLE_VALUES) check(html.includes(value), `ordinary content PRESENT in CDP HTML: ${value}`);
  for (const password of PASSWORDS) check(!html.includes(password), `password value MASKED in CDP HTML: ${password}`);
  console.log(`  ..  - reconstructed HTML ${(html.length / 1024).toFixed(1)} KB`);
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { server.close(); } catch {}
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const watchdog = setTimeout(() => { console.error('dom-mirror-cdp-verify: TIMEOUT'); teardown().finally(() => process.exit(2)); }, 60000);
watchdog.unref();

main()
  .then(async () => {
    await teardown();
    clearTimeout(watchdog);
    if (failures.length) { console.error(`\ndom-mirror-cdp-verify: ${failures.length} FAILED`); process.exit(1); }
    console.log('\ndom-mirror-cdp-verify: all checks passed');
    process.exit(0);
  })
  .catch(async (e) => { console.error('dom-mirror-cdp-verify: ERROR', e); await teardown(); process.exit(3); });
