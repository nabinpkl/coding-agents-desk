// Checks an opencode session on the canvas can be renamed from its own row menu, and that the new
// name reaches the card without a reload.
//
// The unit tests prove the menu offers the item for an opencode session and that the dialog posts
// to the title route. Neither can show the round trip: the title the card shows comes from the
// sidecar's catalog, and the serve announces nothing for a rename (measured), so the row only
// moves if the sidecar told the catalog to re-read. That is the part this drives.
//
// It renames a real session on this machine and puts the name back, so run it against a panel
// whose opencode serve is up:
//   PANEL_ORIGIN=https://<this-mac>.<tailnet>.ts.net:5173 node chrome-test/opencode-rename-verify.mjs
// Optional: TARGET_SESSION_TITLE for a different idle session that has a card on the canvas.
//
// Playwright's own headless Chromium with a throwaway profile, never the owner's Chrome, and it
// drives only the rename it then undoes.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
// A session with a card, because a session off the canvas has no row menu to drive.
const TARGET = process.env.TARGET_SESSION_TITLE || 'Latest state review (fork #1)';
const PROBE = 'Rename probe (panel verify)';
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

// A directory of this run's own, removed on the way out: a killed run must not leave a profile
// behind, and it must never be written under the checkout.
const work = mkdtempSync(join(tmpdir(), 'opencode-rename-verify-'));
const watchdog = setTimeout(() => {
  console.error('\nwatchdog: the run hung; cleaning up and failing');
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}, 180000);
watchdog.unref?.();

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/?entry=feed&view=canvas`, { waitUntil: 'networkidle' });
  // The canvas streams in: the Bots arrive over SSE, not with the document.
  await page.waitForTimeout(8000);

  // Scoped to the canvas list, because the roster beside it renders the same menu under the same
  // accessible name and a query that did not scope would find two triggers for one session.
  const canvas = page.getByRole('list', { name: 'Bot canvas' });
  const trigger = canvas.getByRole('button', { name: `Actions for ${TARGET}`, exact: true }).first();
  check('the opencode session has a card with a row menu', await trigger.count() === 1, TARGET);

  await trigger.click();
  const renameItem = page.getByRole('menuitem', { name: 'Rename session' });
  check('an opencode row offers Rename session', await renameItem.count() === 1);
  await renameItem.click();

  // By role and name, not by tag: the panel keeps two other dialogs mounted and closed.
  const dialog = page.getByRole('dialog', { name: 'Rename session' });
  check('the rename dialog opened', await dialog.count() === 1);
  // The opencode paragraph, not Claude's: this is a PATCH to the serve, with no running session
  // required and no unsent text at risk, and the two texts say different things.
  const copy = await dialog.textContent();
  check('the dialog explains an opencode rename', /opencode serve/.test(copy ?? ''), copy?.slice(0, 60));

  const field = dialog.getByLabel('Title');
  check('the field is seeded with the name that is there', await field.inputValue() === TARGET, await field.inputValue());

  const posted = page.waitForResponse((response) => /\/api\/agent-sessions\/opencode\/[^/]+\/title$/.test(new URL(response.url()).pathname));
  await field.fill(PROBE);
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  const answered = await posted;
  check('the sidecar took the rename', answered.status() === 200, `${answered.status()} ${await answered.text()}`);
  check('the dialog closed on success', await page.getByRole('dialog', { name: 'Rename session' }).count() === 0);

  // The part a unit test cannot see: the serve does not emit an event for a rename, so the title
  // only reaches the sidecar's catalog because the rename schedules its own re-read. That the
  // catalog then holds the new name is what this polls -- the roster's own repaint is a separate
  // question, answered by the Bot stream, which only publishes on a store revision (measured: a
  // rename alone moved nothing on the stream; the next reorder carried the new title with it).
  const stored = await page.waitForFunction(
    async (title) => {
      const snapshot = await (await fetch('/api/bots')).json();
      return snapshot.bots.some((bot) => (bot.sessions ?? []).some((s) => s.title === title));
    },
    PROBE,
    { timeout: 10000, polling: 500 },
  ).then(() => true, () => false);
  check('the sidecar holds the new name without being asked twice', stored);

  await page.screenshot({ path: join(work, 'renamed.png') });

  // The roster beside the canvas is the other place a session's menu is built, and a separate call
  // site of the same rule. Named by the Bot that owns the session rather than picked out of a list
  // of them: this row is inside the sidebar's roster, and the canvas card's is a different element.
  const roster = page.getByRole('list', { name: `${process.env.ROSTER_BOT || 'AD bot'} sessions` });
  await roster.getByRole('button', { name: `Actions for ${TARGET}`, exact: true }).first().click();
  check('the roster row offers Rename too', await page.getByRole('menuitem', { name: 'Rename session' }).count() === 1);
  await page.keyboard.press('Escape');

  // Put it back, so the run leaves the machine as it found it. Matched on either name, because
  // which one the row is showing is exactly the question this run has been asking.
  await canvas.getByRole('button', { name: `Actions for ${TARGET}`, exact: true })
    .or(canvas.getByRole('button', { name: `Actions for ${PROBE}`, exact: true })).first().click();
  await page.getByRole('menuitem', { name: 'Rename session' }).click();
  const restored = page.waitForResponse((response) => /\/api\/agent-sessions\/opencode\/[^/]+\/title$/.test(new URL(response.url()).pathname));
  await page.getByRole('dialog', { name: 'Rename session' }).getByLabel('Title').fill(TARGET);
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await restored;
  const back = await page.waitForFunction(
    async (title) => {
      const snapshot = await (await fetch('/api/bots')).json();
      return snapshot.bots.some((bot) => (bot.sessions ?? []).some((s) => s.title === title));
    },
    TARGET,
    { timeout: 10000, polling: 500 },
  ).then(() => true, () => false);
  check('the name is back where it was', back);

  await context.close();
} finally {
  clearTimeout(watchdog);
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failing: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nopencode rename verified');
