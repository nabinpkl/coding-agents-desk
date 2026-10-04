// Checks the Desktop viewer's trackpad deck in a browser that lays pages out and delivers real
// touch: phone-sized, touch-emulated Chrome for Testing against the live panel.
//
// What reaches the Mac is the point of the deck, and also the thing this must not do to a desktop
// somebody is using. So every pointer input the page sends on the control channel is recorded and
// DROPPED in the page (`RTCDataChannel.prototype.send` is wrapped before the panel loads): the
// checks read what the deck would have sent, and the Mac sees nothing. Everything else on the
// channel (configure, focus queries) passes, so the stream comes up as it normally would.
//
// Dropping the inputs also means no `cursor-applied` ever comes back, which is how this checks the
// ghost: an unconfirmed cursor must turn grey after 250ms.
//
// Run with PANEL_ORIGIN set to the dev origin: `PANEL_ORIGIN=https://<mac>.<tailnet>.ts.net:5173
// node chrome-test/trackpad-deck-verify.mjs`. Throwaway context, never the owner's Chrome. It does
// open the Desktop surface, which asks the sidecar for one more encoder for as long as it runs.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
const OUT = process.env.TRACKPAD_VERIFY_OUT || mkdtempSync(join(tmpdir(), 'trackpad-deck-verify-'));

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
const watchdog = setTimeout(() => {
  console.error('trackpad-deck-verify: timed out');
  void browser.close().finally(() => process.exit(2));
}, 120_000);
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(() => {
  const POINTER = new Set(['pointer-move', 'pointer-warp', 'click', 'mouse-down', 'mouse-up', 'scroll']);
  window.__deckInputs = [];
  // A tap asks the Mac what is focused, and an editable answer raises the keyboard, which takes
  // the deck away for as long as it is up. Correct, and not what this is checking.
  localStorage.setItem('agentdesk.desktop-keyboard-auto.v2', 'false');
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    if (this.label === 'agentdesk-control-v2' && typeof data === 'string') {
      try {
        const input = JSON.parse(data);
        if (POINTER.has(input.type)) {
          window.__deckInputs.push({ ...input, at: performance.now() });
          return undefined;
        }
      } catch {
        // not ours to judge
      }
    }
    return send.call(this, data);
  };
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const inputs = () => page.evaluate(() => window.__deckInputs.splice(0));

async function touch(type, points) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id })),
  });
}
/** One finger from `from` to `to` in `steps` moves, `stepMs` apart. */
async function drag(from, to, { steps = 8, stepMs = 16, holdMs = 0 } = {}) {
  await touch('touchStart', [from]);
  if (holdMs) await page.waitForTimeout(holdMs);
  for (let step = 1; step <= steps; step += 1) {
    const x = from[0] + ((to[0] - from[0]) * step) / steps;
    const y = from[1] + ((to[1] - from[1]) * step) / steps;
    await touch('touchMove', [[x, y]]);
    await page.waitForTimeout(stepMs);
  }
  await touch('touchEnd', []);
}

try {
  await page.goto(`${ORIGIN}/?entry=desktop`, { waitUntil: 'domcontentloaded' });
  check('the page sees a touch device', await page.evaluate(() => matchMedia('(pointer: coarse)').matches));
  const toggle = page.getByRole('button', { name: 'Trackpad', exact: true });
  await toggle.waitFor({ timeout: 30_000 });
  await toggle.click();
  const deck = page.getByTestId('trackpad-deck');
  await deck.waitFor();
  await page.getByRole('button', { name: 'Right click' }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('[data-testid="trackpad-deck"]')?.getAttribute('aria-disabled')
    || document.querySelector('[data-testid="trackpad-deck"]')?.getAttribute('aria-disabled') === 'false', null, { timeout: 30_000 });

  const layout = await page.evaluate(() => {
    const rect = (id) => document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
    const video = rect('desktop-video-box');
    const deckBox = rect('trackpad-deck');
    const pad = rect('trackpad-pad');
    const strip = rect('trackpad-scroll-strip');
    return {
      videoBottom: video.bottom, deckTop: deckBox.top, deckBottom: deckBox.bottom,
      pad: { left: pad.left, right: pad.right, top: pad.top, bottom: pad.bottom },
      strip: { left: strip.left, right: strip.right, top: strip.top, bottom: strip.bottom, width: strip.width },
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      innerWidth: window.innerWidth,
    };
  });
  await page.screenshot({ path: join(OUT, 'deck.png') });
  check('the picture ends where the deck begins', Math.abs(layout.videoBottom - layout.deckTop) <= 1,
    `video ${layout.videoBottom} deck ${layout.deckTop}`);
  check('the strip is 60px and right of the pad', Math.round(layout.strip.width) === 60 && layout.strip.left > layout.pad.right,
    JSON.stringify(layout.strip));
  check('the deck fits the phone with no sideways scroll', !layout.overflowX && layout.strip.right <= layout.innerWidth);

  const padMid = [(layout.pad.left + layout.pad.right) / 2, (layout.pad.top + layout.pad.bottom) / 2];
  const stripMid = [(layout.strip.left + layout.strip.right) / 2, (layout.strip.top + layout.strip.bottom) / 2];
  await inputs();

  // In Trackpad mode the picture is looked at, not driven: a finger pans it and sends nothing,
  // and the pad's cursor is still drawn on it.
  const picture = [layout.pad.left + 120, layout.videoBottom - 120];
  await drag(picture, [picture[0] - 60, picture[1] - 40], { steps: 6, stepMs: 16 });
  await touch('touchStart', [picture]);
  await touch('touchEnd', []);
  await page.waitForTimeout(400);
  const onPicture = await inputs();
  check('a finger on the picture sends the Mac nothing', onPicture.length === 0, JSON.stringify(onPicture));
  check('the cursor is drawn on the picture',
    await page.evaluate(() => document.querySelector('[data-testid="client-cursor-overlay"]')?.hidden === false));

  // A tap on the pad is a left click where the pointer is.
  await touch('touchStart', [padMid]);
  await page.waitForTimeout(40);
  await touch('touchEnd', []);
  await page.waitForTimeout(50);
  const tap = await inputs();
  check('a tap on the pad is one left click', tap.length === 1 && tap[0].type === 'click' && tap[0].button === 'left',
    JSON.stringify(tap));

  // A drag on the pad moves the pointer, numbered, accelerated, and is not a click.
  await drag(padMid, [padMid[0] + 60, padMid[1]], { steps: 6, stepMs: 16 });
  await page.waitForTimeout(80);
  const moves = await inputs();
  const pointerMoves = moves.filter((input) => input.type === 'pointer-move');
  const travelled = pointerMoves.reduce((sum, input) => sum + input.dx, 0);
  check('a pad drag sends numbered pointer moves', pointerMoves.length > 0
    && pointerMoves.every((input, index, all) => index === 0 || input.revision > all[index - 1].revision));
  check('a pad drag is accelerated past the finger travel', travelled > 60, `sent dx ${travelled.toFixed(1)} for 60px`);
  check('a pad drag is not a click', !moves.some((input) => input.type === 'click'));
  check('an unconfirmed cursor is drawn as a ghost',
    await page.evaluate(() => document.querySelector('[data-testid="client-cursor-overlay"]')?.dataset.confidence) === 'ghost');

  // Held still for 250ms, the pad presses; the drag after it is 1:1; the lift lets go.
  await drag(padMid, [padMid[0] + 40, padMid[1]], { steps: 4, stepMs: 16, holdMs: 320 });
  await page.waitForTimeout(80);
  const held = await inputs();
  const heldMoves = held.filter((input) => input.type === 'pointer-move');
  check('a held pad presses, carries 1:1, and lets go', held[0]?.type === 'mouse-down'
    && held.at(-1)?.type === 'mouse-up'
    && Math.abs(heldMoves.reduce((sum, input) => sum + input.dx, 0) - 40) < 1.5,
  JSON.stringify(held.map((input) => input.type === 'pointer-move' ? input.dx.toFixed(1) : input.type)));

  // The strip scrolls on one axis from touch-down, and ends its phase on lift.
  // Slow enough to stay under the 200 pt/s throw, so it ends without a coast.
  await drag(stripMid, [stripMid[0] + 4, stripMid[1] + 90], { steps: 18, stepMs: 40 });
  await page.waitForTimeout(80);
  await page.waitForTimeout(80);
  const strip = (await inputs()).filter((input) => input.type === 'scroll');
  const stripPhases = strip.map((input) => input.phase);
  check('a slow strip drag scrolls vertically only, began to ended', stripPhases[0] === 'began'
    && stripPhases.at(-1) === 'ended' && strip.every((input) => input.dx === 0)
    && strip.some((input) => input.dy > 0), stripPhases.join(','));

  // A throw on the strip coasts, and a new touch ends the coast.
  await drag(stripMid, [stripMid[0], stripMid[1] - 160], { steps: 4, stepMs: 8 });
  await page.waitForTimeout(200);
  await touch('touchStart', [stripMid]);
  await page.waitForTimeout(30);
  await touch('touchEnd', []);
  await page.waitForTimeout(50);
  const thrown = (await inputs()).filter((input) => input.type === 'scroll').map((input) => input.phase);
  check('a strip throw coasts and a touch ends the coast', thrown.includes('momentumBegan')
    && thrown.includes('momentumEnded'), thrown.join(','));

  await page.getByRole('button', { name: 'Right click' }).click();
  await page.waitForTimeout(50);
  const right = await inputs();
  check('Right click sends a right click', right.some((input) => input.type === 'click' && input.button === 'right'));
} finally {
  clearTimeout(watchdog);
  await browser.close();
  if (!process.env.TRACKPAD_VERIFY_OUT) console.log(`screenshot: ${join(OUT, 'deck.png')}`);
}

if (failures.length > 0) {
  console.error(`trackpad-deck-verify: ${failures.length} failed`);
  process.exit(1);
}
console.log('trackpad-deck-verify: all checks held');
