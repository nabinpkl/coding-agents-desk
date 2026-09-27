// Checks the opencode composer footer shows the window and the model switcher, in a browser
// that actually lays pages out.
//
// Unit tests prove the button exists and the percent text renders; they cannot prove the footer
// row fits them without overlap or clipping on a narrow card. Run against the live panel:
// PANEL_ORIGIN=https://<this-mac>.<tailnet>.ts.net:5173 node chrome-test/opencode-footer-verify.mjs
// Uses Playwright's headless Chromium with an incognito-like context, never the owner's
// Chrome, and drives nothing -- it reads the footer and screenshots it.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) throw new Error('could not load playwright chromium from ' + PW_ROOT);

const failures = [];
function check(claim, held, detail) {
  console.log(`${held ? 'ok  ' : 'FAIL'} ${claim}${detail ? `  (${detail})` : ''}`);
  if (!held) failures.push(claim);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
const page = await context.newPage();
await page.goto(`${ORIGIN}/?entry=feed&view=canvas`, { waitUntil: 'networkidle' });
// The canvas streams in; the footer meter arrives with the first usage read.
await page.waitForTimeout(8000);
// Cards start closed: open the first opencode session so its composer renders.
const opened = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('button')];
  const target = rows.find((b) => /Latest state review/.test(b.textContent ?? ''));
  if (target) {
    target.click();
    return true;
  }
  return false;
});
check('an opencode session card opened', opened);
await page.waitForTimeout(5000);

const footer = await page.evaluate(() => {
  const switcher = document.querySelector('button[aria-label^="Switch model"]');
  const meter = document.querySelector('button[aria-label="Context and limits"] span[title]');
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    switcher: switcher ? { label: switcher.getAttribute('aria-label'), box: box(switcher) } : null,
    meter: meter
      ? { text: meter.textContent, title: meter.getAttribute('title'), box: box(meter.closest('button') ?? meter) }
      : null,
  };
});
check('model switcher button is on an opencode card', !!footer.switcher, footer.switcher?.label);
check(
  'meter reads count with percent once the window is known',
  !!footer.meter && /\(\d+%\)/.test(footer.meter.text ?? ''),
  footer.meter?.text,
);
check('meter tooltip names the window', !!footer.meter && /\//.test(footer.meter?.title ?? ''), footer.meter?.title);
// Overlap check: the two boxes must not paint over each other.
if (footer.switcher && footer.meter) {
  const a = footer.switcher.box, b = footer.meter.box;
  const overlap = !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
  check('switcher and meter do not overlap', !overlap);
}
await page.screenshot({ path: 'opencode-footer-verify.png' });
await browser.close();
if (failures.length > 0) {
  console.error(`\n${failures.length} failing: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nfooter verified');
