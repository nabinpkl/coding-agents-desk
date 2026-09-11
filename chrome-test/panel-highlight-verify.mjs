// Does the panel actually PAINT syntax colours, on both surfaces that highlight?
//
// This exists because the bug it guards was invisible to everything else. Shiki emits its tokens
// with `--shiki-light` / `--shiki-dark` custom properties and no concrete colour, so a stylesheet
// has to read them. The rule that did lived under the activity feed's own code-block class, and
// the workspace IDE renders the same markup somewhere else entirely -- so the editor emitted
// fifteen thousand perfectly tokenised spans, every one of them inheriting the page's foreground,
// and every probe short of a computed style agreed it was working. Counting spans, counting
// distinct `style` attributes, reading the HTML: all green, all measuring markup, and markup was
// never the thing in doubt.
//
// So the assertion here is computed colour, on a rendered page, and nothing else.
//
// Run against a live panel: `just panel-highlight-verify`.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
const WORKSPACE = process.env.PANEL_WORKSPACE || 'agent-desk';

// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a
// name mismatch every time. Test-only; what is being checked is on the far side of the connection.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) throw new Error('could not load playwright chromium from ' + PW_ROOT);

const failures = [];
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 950 } });
const page = await context.newPage();

/** Every distinct colour actually painted on the tokens under `selector`. */
const paintedColours = (selector) => page.evaluate((sel) => {
  const root = document.querySelector(sel);
  if (!root) return null;
  const seen = new Set();
  for (const span of root.querySelectorAll('span')) {
    if (span.textContent.trim()) seen.add(getComputedStyle(span).color);
  }
  return [...seen];
}, selector);

await page.goto(`${ORIGIN}/?entry=ide`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('select[aria-label="Select workspace"]', { timeout: 30000 });
const options = await page.$$eval('select[aria-label="Select workspace"] option',
  (els) => els.map((e) => ({ value: e.value, label: e.textContent })));
const chosen = options.find((o) => o.label === WORKSPACE);
if (!chosen) throw new Error(`no workspace called ${WORKSPACE}; set PANEL_WORKSPACE`);
await page.selectOption('select[aria-label="Select workspace"]', chosen.value);
await page.waitForTimeout(2500);

// A file whose NAME is its type, so this covers the resolver as well as the paint: an
// extension-only resolver asks for no grammar at all here and the file comes back one colour.
for (const file of ['Justfile', 'AGENTS.md']) {
  const row = page.locator(`button[aria-label="Open ${file}"]`).first();
  if (!(await row.count())) {
    failures.push(`${file}: not in the explorer`);
    continue;
  }
  await row.click();
  await page.waitForTimeout(2500);
  const colours = await paintedColours('main pre .shiki');
  if (!colours) failures.push(`${file}: the editor painted no Shiki layer at all`);
  else if (colours.length < 3) {
    failures.push(`${file}: ${colours.length} painted colour(s), so the tokens are not coloured`);
  } else console.log(`editor  ${file}: ${colours.length} painted colours`);
}

// The feed's own block, through a markdown preview so the fence is one this repo controls.
await page.locator('button[aria-label="Open AGENTS.md"]').first().click();
await page.waitForTimeout(1500);
await page.locator('button[aria-label="Show file preview"]').click();
await page.waitForTimeout(4000);
const fence = await paintedColours('.agent-panel-code__body .shiki');
if (!fence) failures.push('markdown fence: no Shiki layer rendered');
else if (fence.length < 3) failures.push(`markdown fence: ${fence.length} painted colour(s)`);
else console.log(`fence   AGENTS.md: ${fence.length} painted colours`);

await browser.close();
if (failures.length > 0) {
  console.error('panel-highlight-verify FAILED');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log('panel-highlight-verify: OK');
