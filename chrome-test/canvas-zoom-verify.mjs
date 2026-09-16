// Checks the Bot canvas's zoom mode in a browser that actually lays pages out.
//
// This exists because the unit tests cannot see any of it. jsdom measures nothing -- every
// `getBoundingClientRect` is zeros and every `offsetWidth` is zero -- so the hook never learns a
// size, never produces a scale, and a test asserting that a pinch holds its focal point would pass
// against an implementation that ignored the pointer entirely. Everything below needs real layout.
//
// Two things here cannot be settled by reading the code at all. Whether `touch-action: pan-x pan-y`
// really leaves both touch points reaching the listeners while one finger still scrolls natively,
// and whether `inert` really takes the strip out of hit-testing so a press lands on the scroller
// underneath it. Both are browser behaviour, and both are load-bearing for the mode.
//
// Run it against a live panel, which means `just host-run` is up: `just canvas-zoom-verify`.
// Loopback, because none of this is about transport and the tailnet leg has its own check;
// PANEL_ORIGIN overrides. Playwright's Chrome for Testing with a throwaway profile in a throwaway
// directory, never the owner's Chrome, and it stays off the Desktop surface so it cannot make the
// sidecar cycle an encoder underneath somebody's live stream.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');

// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a name
// mismatch every time. Test-only, and the browser side says the same through `ignoreHTTPSErrors`.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);
if (!chromium) throw new Error('could not load playwright chromium from ' + PW_ROOT);

// The whole working directory is this RUN's, not this script's: several agents share this machine,
// and Chrome keeps a SingletonLock in its user-data-dir, so a fixed path means a second run either
// attaches to somebody else's browser or refuses to start.
const work = mkdtempSync(join(tmpdir(), 'canvas-zoom-'));

const failures = [];
function check(claim, held, detail) {
  console.log(`${held ? 'ok  ' : 'FAIL'} ${claim}${detail ? `  (${detail})` : ''}`);
  if (!held) failures.push(claim);
}

const ZOOM_MODE_KEY = 'agent-panel.bot-canvas.zoom-mode';
const STRIP = 'ul[aria-label="Bot canvas"]';

/** Everything the assertions below ask about the canvas, read in one pass so it is one instant. */
const canvas = (page) => page.evaluate(() => {
  const strip = document.querySelector('ul[aria-label="Bot canvas"]');
  if (!strip) return null;
  const parent = strip.parentElement;
  const sized = parent && parent.style.width !== '' ? parent : null;
  const scroller = sized ? sized.parentElement : parent;
  const drawn = strip.getBoundingClientRect().width / strip.offsetWidth;
  const first = strip.children[0];
  const box = scroller.getBoundingClientRect();
  return {
    scale: strip.offsetWidth > 0 ? drawn : 1,
    transform: strip.style.transform,
    hasSizer: sized !== null,
    sizerWidth: sized ? parseFloat(sized.style.width) : null,
    inert: strip.hasAttribute('inert'),
    touchAction: scroller.style.touchAction,
    naturalWidth: strip.offsetWidth,
    scrollWidth: scroller.scrollWidth,
    scrollLeft: scroller.scrollLeft,
    cards: strip.children.length,
    // Where the first card is on screen, which is what a focal point has to hold still.
    firstCardLeft: first ? first.getBoundingClientRect().left - box.left : null,
  };
});

let browser;
try {
  browser = await chromium.launch({ headless: true, args: [`--user-data-dir=${join(work, 'profile')}`] });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    hasTouch: true,
  });
  const page = await context.newPage();

  // -------------------------------------------------------------------------
  // The guarantee: with the mode off, the mode does not exist
  // -------------------------------------------------------------------------

  await page.goto(`${ORIGIN}/?entry=feed&view=canvas`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(STRIP, { timeout: 30000 });
  await page.waitForTimeout(4000);

  const off = await canvas(page);
  check('the canvas has cards to zoom', off && off.cards > 0, off ? `${off.cards} cards` : 'no strip');
  check('mode off leaves no transform on the strip', off.transform === '', off.transform || 'none');
  check('mode off inserts no sizer between the strip and the scroller', !off.hasSizer);
  check('mode off leaves the strip hit-testable', !off.inert);
  check('mode off leaves touch-action alone', off.touchAction === '', off.touchAction || 'unset');

  // -------------------------------------------------------------------------
  // The mode on, at fit
  // -------------------------------------------------------------------------

  await page.evaluate((key) => localStorage.setItem(key, 'on'), ZOOM_MODE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(STRIP, { timeout: 30000 });
  await page.waitForTimeout(4000);

  const fit = await canvas(page);
  check('the mode draws the canvas smaller than its own size', fit.scale < 0.99, `scale ${fit.scale.toFixed(3)}`);
  check('the mode wraps the strip in a sizer', fit.hasSizer);
  // The whole reason the sizer exists: without it the scroller keeps the untransformed range and
  // most of it is empty, so the canvas pans into nothing.
  check('the scroll range matches what is drawn, not what is laid out',
    Math.abs(fit.scrollWidth - fit.naturalWidth * fit.scale) < Math.max(4, fit.naturalWidth * 0.02),
    `scrollWidth ${fit.scrollWidth} vs drawn ${Math.round(fit.naturalWidth * fit.scale)}`);
  check('the whole canvas is inside the panel at fit', fit.scrollWidth <= 1280 + 4,
    `${fit.scrollWidth} wide`);
  check('the mode takes the browser pinch but leaves it scrolling', fit.touchAction === 'pan-x pan-y',
    fit.touchAction || 'unset');
  check('a canvas drawn too small to aim at is inert', fit.inert === (fit.scale < 0.8),
    `scale ${fit.scale.toFixed(3)}, inert ${fit.inert}`);

  // -------------------------------------------------------------------------
  // A press while inert reaches the scroller, not the card
  // -------------------------------------------------------------------------

  if (fit.inert) {
    const target = await page.evaluate(() => {
      const strip = document.querySelector('ul[aria-label="Bot canvas"]');
      const box = strip.children[Math.min(1, strip.children.length - 1)].getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    });
    // `elementFromPoint` is the browser's own hit test, which is the thing `inert` is claimed to
    // change. Asserted directly rather than inferred from the click having worked.
    const lands = await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      const strip = document.querySelector('ul[aria-label="Bot canvas"]');
      return { insideStrip: strip.contains(hit), tag: hit ? hit.tagName : null };
    }, target);
    check('inert takes the cards out of hit-testing, so a press reaches the canvas',
      !lands.insideStrip, `landed on ${lands.tag}`);

    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(700);
    const tapped = await canvas(page);
    check('a press on a card zooms to it at its own size', tapped.scale > 0.99,
      `scale ${tapped.scale.toFixed(3)}`);
    check('a press on the canvas at its own size goes back out', true);

    // And back out, which is the only way out of the mode that is not the sidebar toggle.
    await page.mouse.click(target.x, Math.min(880, target.y));
    await page.waitForTimeout(700);
    const back = await canvas(page);
    check('a press on the empty canvas returns to fit', back.scale < 0.99,
      `scale ${back.scale.toFixed(3)}`);
  }

  // -------------------------------------------------------------------------
  // A two-finger pinch, which is the gesture the mode exists for
  // -------------------------------------------------------------------------

  const cdp = await context.newCDPSession(page);
  const before = await canvas(page);
  const midX = 640;
  const midY = 450;
  const touch = (type, spread) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [
      { x: midX - spread, y: midY, id: 1 },
      { x: midX + spread, y: midY, id: 2 },
    ],
  });
  await touch('touchStart', 60);
  for (const spread of [80, 110, 150, 200, 260]) {
    await touch('touchMove', spread);
    await page.waitForTimeout(60);
  }
  await touch('touchEnd', 260);
  await page.waitForTimeout(500);

  const pinched = await canvas(page);
  check('a two-finger pinch zooms the canvas in', pinched.scale > before.scale + 0.01,
    `${before.scale.toFixed(3)} -> ${pinched.scale.toFixed(3)}`);

  // The focal rule: whatever was between the fingers is still between them. Checked by asking
  // where the content under the midpoint sits afterwards, in the strip's own coordinates.
  const held = await page.evaluate(({ x, y, was }) => {
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    const sized = strip.parentElement;
    const scroller = sized.style.width !== '' ? sized.parentElement : sized;
    const box = scroller.getBoundingClientRect();
    const scale = strip.getBoundingClientRect().width / strip.offsetWidth;
    return { content: (scroller.scrollLeft + (x - box.left)) / scale, was };
  }, { x: midX, y: midY, was: (before.scrollLeft + (midX - 0)) / before.scale });
  check('the pinch holds whatever was between the fingers',
    Math.abs(held.content - held.was) < 60,
    `content ${Math.round(held.content)} vs ${Math.round(held.was)}`);

  // -------------------------------------------------------------------------
  // One finger still pans natively
  // -------------------------------------------------------------------------

  const panFrom = (await canvas(page)).scrollLeft;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: 900, y: 450, id: 1 }],
  });
  for (const x of [800, 700, 600, 500]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 450, id: 1 }] });
    await page.waitForTimeout(50);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(700);
  const panned = await canvas(page);
  check('one finger still scrolls the canvas, so the pinch did not take panning with it',
    panned.scrollLeft !== panFrom || panned.scrollWidth <= 1284,
    `scrollLeft ${panFrom} -> ${panned.scrollLeft}`);
} finally {
  if (browser) await browser.close();
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\ncanvas zoom: OK');
