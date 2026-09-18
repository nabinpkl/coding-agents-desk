// Checks that the faces switch trades initials for generated faces on every ranked avatar,
// and back again.
//
// This exists because neither half can be settled anywhere else. The unit tests know the store
// flips and the arithmetic is stable; they cannot know that a real roster renders an svg into the
// disc, that two Bots get two different heads, that the canvas cards move with the roster, or
// that a reload keeps the choice. And the dangerous direction is the one that looks like nothing:
// a face silently not rendering leaves the initials' layout exactly as it was.
//
// Run it against a live panel: `just bot-faces-verify`. Playwright's Chrome for Testing with a
// throwaway context, never the owner's Chrome. It touches no session and opens no terminal, so it
// cannot disturb a live stream; the only write it makes is the preference itself, which it puts
// back the way it found it.

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

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

const teardown = async () => {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
};
const watchdog = setTimeout(() => {
  console.error('FAIL timed out');
  void teardown().then(() => process.exit(1));
}, 120_000);

// Avatar roots, wherever they are drawn: roster rows and card headers alike. A face stands alone
// as an svg; initials stand in their disc. `size-9` on a card and `size-10` in the sidebar; the
// session marks (`size-6`) are a different component and are not what this switch changes.
const discs = () => page.evaluate(() => [...document.querySelectorAll(
  'ul[aria-label="Bots"] :is(span.rounded-full:is(.size-9,.size-10), svg.bot-face:is(.size-9,.size-10)), [aria-label="Bot canvas"] :is(span.rounded-full:is(.size-9,.size-10), svg.bot-face:is(.size-9,.size-10))',
)].map((el) => {
  const face = el.tagName.toLowerCase() === 'svg';
  return {
    face,
    head: face ? el.querySelector('path')?.getAttribute('d') ?? null : null,
    text: face ? '' : (el.textContent ?? ''),
  };
}));

try {
  // The canvas, which is the surface the owner reads: the roster beside the strip draws the same
  // avatars the cards do.
  await page.goto(`${ORIGIN}/?entry=feed&view=canvas`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul[aria-label="Bots"]', { timeout: 30000 });
  await page.waitForTimeout(3000);

  const before = await discs();
  check('the roster has ranked avatars to judge', before.length > 0, `${before.length} discs`);
  if (before.length === 0) throw new Error('no Bot avatars rendered');
  check(
    'initials are what shows before the switch is touched',
    before.every((d) => !d.face && d.text.trim().length > 0),
    before.map((d) => d.text.trim()).slice(0, 4).join(','),
  );
  await page.screenshot({ path: '/tmp/bot-faces-initials.png' });

  await page.getByRole('button', { name: 'Show Bot faces instead of initials' }).click();
  await page.waitForTimeout(1000);
  const faced = await discs();
  check('every ranked disc draws a face after the press', faced.every((d) => d.face), `${faced.filter((d) => d.face).length}/${faced.length}`);
  const heads = new Set(faced.map((d) => d.head).filter(Boolean));
  check('two Bots do not wear the same head', heads.size > 1, `${heads.size} distinct heads over ${faced.length} discs`);
  // Roster and cards move together: the press reaches past the list it was pressed in.
  const cardFaces = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Bot canvas"] svg.bot-face')].length);
  const cards = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Bot canvas"] :is(span.rounded-full:is(.size-9,.size-10), svg.bot-face:is(.size-9,.size-10))')].length);
  check('the canvas cards wear faces too', cards === 0 || cardFaces === cards, `${cardFaces}/${cards} card discs`);
  await page.screenshot({ path: '/tmp/bot-faces-on.png' });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('ul[aria-label="Bots"]', { timeout: 30000 });
  await page.waitForTimeout(3000);
  const kept = await discs();
  check('a reload keeps the faces', kept.length > 0 && kept.every((d) => d.face), `${kept.filter((d) => d.face).length}/${kept.length}`);

  // Put the panel back the way it was found: initials are the default and this run chose faces.
  await page.getByRole('button', { name: 'Show Bot initials instead of faces' }).click();
  await page.waitForTimeout(1000);
  const restored = await discs();
  check('the switch trades back to initials', restored.every((d) => !d.face));

  await teardown();
  clearTimeout(watchdog);
  if (failures.length > 0) {
    console.error(`FAIL ${failures.length} checks failed`);
    process.exit(1);
  }
  console.log('bot-faces-verify: all checks passed');
} catch (error) {
  clearTimeout(watchdog);
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  await teardown();
  process.exit(1);
}
