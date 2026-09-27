// Checks the Bot file viewer keeps a long markdown file inside its modal.
//
// This exists because the unit tests cannot see any of it. jsdom measures nothing, so a grid
// whose row sizes to its content lays out exactly like one that fills its dialog, and an
// assertion about clipping would pass against the implementation that shipped it: an auto row
// plus `min-width: auto` columns, which let one long document push the file column to 736px
// inside a 382px modal on a phone. Everything below needs real layout.
//
// Run it against a live panel with the AD bot present (`just bot-code-dialog-verify`): it
// opens that Bot's code dialog on AGENTS.md, a document long enough to overflow at any height,
// and asserts the scroller is bounded, stays inside the modal, and really scrolls -- at desktop
// width and at a phone width. Playwright's Chrome for Testing with a throwaway context, never
// the owner's Chrome. It touches no session and opens no terminal, so it cannot disturb a live
// stream; the only thing it opens is a read-only file dialog, which it leaves open for the run
// and closes with the browser.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');

// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a
// name mismatch every time. Test-only, and the browser side says the same through
// `ignoreHTTPSErrors`.
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

// The code dialog, not whichever dialog the app has open: at narrow widths a second,
// unlabelled dialog shares the page, and `dialog[open]` would match that one first.
const DIALOG = 'dialog[aria-labelledby="bot-code-title"]';

async function openCodeDialog(page) {
  await page.goto(`${ORIGIN}/?entry=feed&view=canvas`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul[aria-label="Bot canvas"]', { timeout: 30000 });
  await page.waitForTimeout(4000);
  await page.click('button[aria-label="Browse the code in AD bot"]');
  await page.waitForSelector(DIALOG, { timeout: 15000 });
  await page.waitForTimeout(2000);
  const opener = page.locator(`${DIALOG} button[aria-label="Open AGENTS.md"]`);
  await opener.waitFor({ timeout: 15000 });
  await opener.click();
  await page.waitForTimeout(2500);
}

/** Everything the assertions ask about the open file, read in one pass so it is one instant. */
const measure = (page) => page.evaluate(() => {
  const dialog = document.querySelector('dialog[aria-labelledby="bot-code-title"]');
  const frame = dialog?.querySelector(':scope > div');
  const section = dialog?.querySelector('section[aria-label="File"]');
  const scroller = section?.querySelector('div[class*="overflow-hidden"] div.overflow-auto');
  if (!dialog || !frame || !section || !scroller) return null;
  const fr = frame.getBoundingClientRect();
  const sr = section.getBoundingClientRect();
  const cr = scroller.getBoundingClientRect();
  const scrollable = (() => { scroller.scrollTop = 50; return scroller.scrollTop > 0; })();
  return {
    frameBottom: fr.bottom, frameRight: fr.right,
    sectionRight: sr.right, scrollerBottom: cr.bottom,
    clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight,
    scrollable,
  };
});

function checkBounds(label, m) {
  check(`${label}: dialog laid out`, m !== null);
  if (!m) return;
  check(`${label}: scroller is bounded (content overflows inside it)`,
    m.scrollHeight > m.clientHeight, `client=${m.clientHeight} scroll=${m.scrollHeight}`);
  check(`${label}: scroller bottom stays inside the modal`,
    m.scrollerBottom <= m.frameBottom + 1,
    `scroller=${Math.round(m.scrollerBottom)} frame=${Math.round(m.frameBottom)}`);
  check(`${label}: file column stays inside the modal`,
    m.sectionRight <= m.frameRight + 1,
    `section=${Math.round(m.sectionRight)} frame=${Math.round(m.frameRight)}`);
  check(`${label}: long document actually scrolls`, m.scrollable === true);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await openCodeDialog(page);
  checkBounds('desktop', await measure(page));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1200);
  checkBounds('narrow', await measure(page));
} finally {
  await browser?.close();
}
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nfile viewer bounded');
