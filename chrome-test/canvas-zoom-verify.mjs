// Checks the Bot canvas's zoom mode in a browser that actually lays pages out.
//
// This exists because the unit tests cannot see any of it. jsdom measures nothing -- every
// `getBoundingClientRect` is zeros and every `offsetWidth` is zero -- so the hook never learns a
// size, never produces a scale, and a test asserting that a pinch holds its focal point would pass
// against an implementation that ignored the pointer entirely. Everything below needs real layout.
//
// Two things here cannot be settled by reading the code at all. Whether `touch-action: pan-x pan-y`
// really leaves both touch points reaching the listeners while one finger still scrolls natively,
// and whether a card drawn at a fifth of its size is still hit-tested and still answers a press.
// Both are browser behaviour, and both are load-bearing for the mode.
//
// Run it against a live panel, which means `just host-run` is up: `just canvas-zoom-verify`.
// Loopback, because none of this is about transport and the tailnet leg has its own check;
// PANEL_ORIGIN overrides. Playwright's Chrome for Testing with a throwaway profile in a throwaway
// directory, never the owner's Chrome, and it stays off the Desktop surface so it cannot make the
// sidecar cycle an encoder underneath somebody's live stream.

import { execFileSync } from 'node:child_process';
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

// Nothing here names a profile directory, and that is the point rather than an omission: several
// agents share this machine, and Chrome keeps a SingletonLock in its user-data-dir, so any fixed
// path means a second run either attaches to somebody else's browser or refuses to start.
// `chromium.launch` mints a unique throwaway profile per run and removes it on close, which is
// what the shared-machine rule wants; `panel-scroll-memory-verify.mjs` does the same.

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
  // The wrapper is always in the tree; it is SIZED only while the mode draws small, and carries
  // `display: contents` otherwise so it generates no box at all.
  const wrapper = strip.parentElement;
  const sized = wrapper && wrapper.style.width !== '' ? wrapper : null;
  const scroller = wrapper.parentElement;
  const drawn = strip.getBoundingClientRect().width / strip.offsetWidth;
  const first = strip.children[0];
  const box = scroller.getBoundingClientRect();
  return {
    scale: strip.offsetWidth > 0 ? drawn : 1,
    transform: strip.style.transform,
    hasSizer: sized !== null,
    sizerWidth: sized ? parseFloat(sized.style.width) : null,
    wrapperDisplay: wrapper.style.display,
    // The strip must be the SAME element after a toggle. A remount would silently tear down and
    // stand up every open session card inside it, and every stream they hold.
    stripStamp: strip.dataset.zoomStamp || null,
    touchAction: scroller.style.touchAction,
    naturalWidth: strip.offsetWidth,
    scrollWidth: scroller.scrollWidth,
    clientWidth: scroller.clientWidth,
    scrollLeft: scroller.scrollLeft,
    scrollerLeft: box.left,
    cards: strip.children.length,
    // Where the first card is on screen, which is what a focal point has to hold still.
    firstCardLeft: first ? first.getBoundingClientRect().left - box.left : null,
  };
});

let browser;
try {
  browser = await chromium.launch({ headless: true });
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
  check('mode off leaves touch-action alone', off.touchAction === '', off.touchAction || 'unset');
  check('mode off gives the sizer no box of its own', off.wrapperDisplay === 'contents',
    off.wrapperDisplay || 'unset');

  // -------------------------------------------------------------------------
  // The mode on, at fit
  // -------------------------------------------------------------------------

  await page.evaluate((key) => localStorage.setItem(key, 'on'), ZOOM_MODE_KEY);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(STRIP, { timeout: 30000 });
  await page.waitForTimeout(4000);

  const fit = await canvas(page);
  check('the mode draws the canvas smaller than its own size', fit.scale < 0.99, `scale ${fit.scale.toFixed(3)}`);
  check('the mode gives the sizer a box the size of what is drawn', fit.hasSizer,
    fit.sizerWidth === null ? 'no width' : `${fit.sizerWidth}px`);

  // Stamped now, while the mode is on at fit, and read back at the end of this same page life.
  // Every scale change below resizes the sizer, and if the wrapper were rendered conditionally
  // that would move the strip in the tree -- remounting it, and with it every open session card
  // and every stream those hold. The stamp is how that shows up as a failure rather than silently.
  await page.evaluate(() => {
    document.querySelector('ul[aria-label="Bot canvas"]').dataset.zoomStamp = 'alive';
  });
  // The whole reason the sizer exists: without it the scroller keeps the untransformed range and
  // most of it is empty, so the canvas pans into nothing.
  check('the scroll range matches what is drawn, not what is laid out',
    Math.abs(fit.scrollWidth - fit.naturalWidth * fit.scale) < Math.max(4, fit.naturalWidth * 0.02),
    `scrollWidth ${fit.scrollWidth} vs drawn ${Math.round(fit.naturalWidth * fit.scale)}`);
  check('the whole canvas is inside the panel at fit', fit.scrollWidth <= 1280 + 4,
    `${fit.scrollWidth} wide`);
  check('the mode takes the browser pinch but leaves it scrolling', fit.touchAction === 'pan-x pan-y',
    fit.touchAction || 'unset');

  /** Back to a known state: fit, freshly loaded. Anything below would otherwise inherit a scale. */
  async function backToFit() {
    await page.evaluate(() => localStorage.setItem('agent-panel.bot-canvas.zoom-scale', '0.02'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(STRIP, { timeout: 30000 });
    await page.waitForTimeout(4000);
    return canvas(page);
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
  // The scale just changed, which resized the sizer. A wrapper rendered conditionally would have
  // moved the strip in the tree at that moment, remounting it and every open session inside it.
  check('changing the scale does not remount the strip', pinched.stripStamp === 'alive',
    pinched.stripStamp === null ? 'the strip was replaced' : 'same element');

  // The focal rule: whatever was between the fingers is still between them. Checked by asking
  // where the content under the midpoint sits afterwards, in the strip's own coordinates.
  const held = await page.evaluate(({ x, y, was }) => {
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    const sized = strip.parentElement;
    const scroller = sized.style.width !== '' ? sized.parentElement : sized;
    const box = scroller.getBoundingClientRect();
    const scale = strip.getBoundingClientRect().width / strip.offsetWidth;
    return { content: (scroller.scrollLeft + (x - box.left)) / scale, was };
  }, { x: midX, y: midY, was: (before.scrollLeft + (midX - before.scrollerLeft)) / before.scale });
  check('the pinch holds whatever was between the fingers',
    Math.abs(held.content - held.was) < 60,
    `content ${Math.round(held.content)} vs ${Math.round(held.was)}`);

  // -------------------------------------------------------------------------
  // The cards are live at every scale, and the canvas around them is the way in and out
  // -------------------------------------------------------------------------

  let atFit = await backToFit();
  const onCard = await page.evaluate(() => {
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    const box = strip.children[Math.min(1, strip.children.length - 1)].getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });
  // `elementFromPoint` is the browser's own hit test. The mode used to take the strip out of it
  // below a threshold, so a press at fit reached the canvas underneath; the cards are the
  // reader's at every scale now, and whether that survives being drawn at a fifth of their size
  // is browser behaviour rather than something the code can be read for.
  const lands = await page.evaluate(({ x, y }) => {
    const hit = document.elementFromPoint(x, y);
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    // Which CARD it landed in, not merely which tag. The strip is a `ul` and so is the session
    // list inside every card, so a bare tag name cannot tell a hit on a card from a hit on the
    // strip itself -- and a log line a reader can misread is how a check passes for the wrong
    // reason. An index means an `li` of the strip genuinely took the press.
    const card = hit && hit !== strip ? hit.closest('ul[aria-label="Bot canvas"] > li') : null;
    return {
      card: card ? [...strip.children].indexOf(card) : -1,
      tag: hit ? hit.tagName : null,
      named: card ? (card.textContent || '').trim().slice(0, 30) : null,
    };
  }, onCard);
  check('a card is hit-tested at fit, however small it is drawn', lands.card >= 0,
    `scale ${atFit.scale.toFixed(3)}, landed on ${lands.tag} in card ${lands.card} (${lands.named})`);

  // And it answers. A control's own `aria-expanded` changing is the only thing that says the
  // press arrived at the card rather than merely near it -- at this scale the button is a handful
  // of pixels across, which is the cost of the mode being live rather than a picture.
  const probe = await page.evaluate(() => {
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    const button = strip.querySelector('button[aria-expanded]');
    if (!button) return null;
    button.dataset.zoomProbe = '1';
    const box = button.getBoundingClientRect();
    return {
      was: button.getAttribute('aria-expanded'),
      label: (button.getAttribute('aria-label') || button.textContent || '').trim().slice(0, 40),
      width: Math.round(box.width),
      x: Math.round(box.left + box.width / 2),
      y: Math.round(box.top + box.height / 2),
    };
  });
  if (probe) {
    await page.mouse.click(probe.x, probe.y);
    await page.waitForTimeout(700);
    const now = await page.evaluate(() => {
      const button = document.querySelector('[data-zoom-probe]');
      return button ? button.getAttribute('aria-expanded') : null;
    });
    check('a control inside a card answers a press at fit', now !== null && now !== probe.was,
      `${probe.label || 'a card control'}, ${probe.width}px wide: ${probe.was} -> ${now}`);
  } else {
    check('a control inside a card answers a press at fit', false, 'no aria-expanded control found');
  }

  // Press-to-zoom is what the canvas AROUND the strip is left with, and it is enough to get in and
  // out of a surface carrying no chrome of its own: a press below a card goes to that card at 1:1,
  // and a press on the empty canvas at 1:1 comes back out to fit.
  atFit = await backToFit();
  const under = await page.evaluate(() => {
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    const scroller = strip.parentElement.parentElement;
    const box = scroller.getBoundingClientRect();
    const card = strip.children[Math.min(1, strip.children.length - 1)].getBoundingClientRect();
    const below = strip.getBoundingClientRect().bottom;
    return {
      x: Math.round(card.left + card.width / 2),
      y: Math.round(Math.min(box.bottom - 20, below + 40)),
    };
  });
  await page.mouse.click(under.x, under.y);
  await page.waitForTimeout(700);
  const zoomed = await canvas(page);
  check('a press on the canvas under a card zooms to that card at its own size', zoomed.scale > 0.99,
    `${atFit.scale.toFixed(3)} -> ${zoomed.scale.toFixed(3)}`);

  // And back out. Pressed well below the strip, which at 1:1 is only as tall as its tallest card.
  const empty = await page.evaluate(() => {
    const strip = document.querySelector('ul[aria-label="Bot canvas"]');
    const scroller = strip.parentElement.parentElement;
    const box = scroller.getBoundingClientRect();
    const below = strip.getBoundingClientRect().bottom;
    return { x: Math.round(box.left + 40), y: Math.round(Math.min(box.bottom - 20, below + 60)) };
  });
  await page.mouse.click(empty.x, empty.y);
  await page.waitForTimeout(700);
  const back = await canvas(page);
  check('a press on the empty canvas returns to fit', back.scale < 0.99,
    `scale ${back.scale.toFixed(3)}`);

  // -------------------------------------------------------------------------
  // One finger still pans natively
  // -------------------------------------------------------------------------

  await backToFit();
  // Pinched in first. At fit the whole canvas is inside the panel by definition, so there is
  // nothing to scroll and the check would pass without exercising anything -- and a check that
  // cannot fail reads as evidence in the log while proving nothing.
  await touch('touchStart', 60);
  for (const spread of [120, 200, 280]) {
    await touch('touchMove', spread);
    await page.waitForTimeout(60);
  }
  await touch('touchEnd', 280);
  await page.waitForTimeout(400);
  const panStart = await canvas(page);
  const panFrom = panStart.scrollLeft;
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
  // Stated separately, so a canvas with nothing to scroll fails loudly here rather than letting
  // the claim below pass for having had nothing to do.
  const room = panStart.scrollWidth - panStart.clientWidth;
  check('the pinch left the canvas with room to pan', room > 1, `${Math.round(room)}px of range`);
  check('one finger still scrolls the canvas, so the pinch did not take panning with it',
    panned.scrollLeft !== panFrom, `scrollLeft ${panFrom} -> ${panned.scrollLeft}`);
} finally {
  if (browser) await browser.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\ncanvas zoom: OK');
