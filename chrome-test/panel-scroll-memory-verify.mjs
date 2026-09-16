// Checks that the panel comes back to where it was being read, in a browser that actually lays
// pages out.
//
// This exists because the unit tests cannot see the failure it guards. jsdom measures nothing: a
// row reports a height only as its element mounts, so a transcript's layout is settled from the
// first commit there. In a real browser it is not -- the restore jumps into a list of estimates,
// and every row that then reports its real height moves the line it jumped to. The version that
// shipped first wrote one offset and stopped, and landed a couple of hundred lines late, close
// enough to the end to read as never having restored at all.
//
// Run it against a live panel, which means `just host-run` is up: `just panel-scroll-memory-verify`.
// It talks to loopback, because none of this is about transport and the tailnet leg has its own
// check; PANEL_ORIGIN overrides that. Uses Playwright's Chrome for Testing with a throwaway
// profile, never the owner's Chrome, and stays off the Desktop surface so it cannot make the
// sidecar cycle an encoder underneath somebody's live stream.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');

// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a
// name mismatch every time. Test-only, and the browser side says the same thing through
// `ignoreHTTPSErrors`; what is being checked here is on the far side of the connection.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) throw new Error('could not load playwright chromium from ' + PW_ROOT);

/** The busiest session in this repo's own project, which is the one with rows enough to scroll. */
async function busiestSession() {
  const projectPath = process.env.PANEL_PROJECT || process.cwd();
  const url = `${ORIGIN}/api/sessions?projectPath=${encodeURIComponent(projectPath)}`;
  const answer = await fetch(url).then((r) => r.json());
  const session = (answer.sessions ?? [])[0];
  if (!session) throw new Error(`no sessions for ${projectPath}`);
  return { projectPath, source: session.source, sessionId: session.sessionId };
}

const failures = [];
function check(claim, held, detail) {
  console.log(`${held ? 'ok  ' : 'FAIL'} ${claim}${detail ? `  (${detail})` : ''}`);
  if (!held) failures.push(claim);
}

const session = await busiestSession();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
await context.addInitScript((sel) => {
  localStorage.setItem('agent-panel.selection', JSON.stringify(sel));
}, session);
const page = await context.newPage();

// ---------------------------------------------------------------------------
// A session's transcript
// ---------------------------------------------------------------------------

/** The line at the top of the viewport, which is the thing that has to survive a reload. */
const topLine = () => page.evaluate(() => {
  const el = document.querySelector('div.h-full.overflow-y-auto');
  const row = [...document.querySelectorAll('[data-index]')].find((r) => {
    const at = /translateY\((-?[\d.]+)px\)/.exec(r.style.transform);
    return at && Number(at[1]) + r.offsetHeight > (el ? el.scrollTop : 0);
  });
  return {
    text: row ? row.innerText.slice(0, 60).replace(/\s+/g, ' ') : null,
    stored: localStorage.getItem('agent-panel.transcript-scroll'),
    detached: !!document.querySelector('[aria-label="scroll to bottom"]'),
  };
});

await page.goto(`${ORIGIN}/?entry=feed`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('div.h-full.overflow-y-auto', { timeout: 30000 });
await page.waitForTimeout(4000);

// A real wheel gesture, because only an input can say the reader meant to leave the tail.
await page.mouse.move(640, 500);
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -900); await page.waitForTimeout(60); }
await page.waitForTimeout(1200);
const left = await topLine();
check('scrolling up records the line being read', left.stored !== null, left.stored ?? 'nothing stored');
check('scrolling up leaves the tail', left.detached);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('div.h-full.overflow-y-auto', { timeout: 30000 });
await page.waitForTimeout(5000);
const back = await topLine();
check('the reload comes back to the same line', back.text === left.text, `${left.text} -> ${back.text}`);
check('the reload does not overwrite the line it restored', back.stored === left.stored,
  `${left.stored} -> ${back.stored}`);

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** Which card the strip is scrolled to, which is what an offset into it stands for. */
const firstCard = () => page.evaluate(() => {
  const list = document.querySelector('ul[aria-label="Bot canvas"]');
  // The scrolling ancestor, not the immediate parent. The canvas's zoom mode keeps a wrapper
  // between the two -- `display: contents` while the mode is off, a sized box while it is on --
  // and reading the wrapper's scrollLeft would report 0 forever and pass for the wrong reason.
  const el = list && list.closest('.overflow-auto');
  if (!list || !el) return { card: null, stored: null };
  return {
    card: [...list.children].findIndex((c) => c.offsetLeft + c.offsetWidth > el.scrollLeft),
    stored: localStorage.getItem('agent-panel.bot-canvas.scroll'),
  };
});

await page.goto(`${ORIGIN}/?entry=feed&view=canvas`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('ul[aria-label="Bot canvas"]', { timeout: 30000 });
await page.waitForTimeout(4000);
await page.mouse.move(550, 450);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(700, 0); await page.waitForTimeout(70); }
await page.waitForTimeout(1000);
const along = await firstCard();
check('scrolling the canvas records how far along it is', along.stored !== null, along.stored ?? 'nothing stored');

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('ul[aria-label="Bot canvas"]', { timeout: 30000 });
await page.waitForTimeout(5000);
const cameBack = await firstCard();
check('the reload comes back to the same card', cameBack.card === along.card && along.card > 0,
  `card ${along.card} -> card ${cameBack.card}`);
// The ratchet. A card that mounts open finishes filling in after the restore has fired, so the
// strip is narrower at that moment than it ends up (measured here: 4569px then 4911px), the
// browser clamps the assignment to what it reaches, and the settle write then made that clamped
// offset the new remembered one -- walking the reader further off the place they left on every
// single reload, with nothing that ever walked it back.
check('the reload does not overwrite the place it restored', cameBack.stored === along.stored,
  `${along.stored} -> ${cameBack.stored}`);

await browser.close();
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\npanel scroll memory: OK');
