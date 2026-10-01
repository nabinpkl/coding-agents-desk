// Checks the IDE's two searches on the real panel: double Shift opens quick open, which finds and
// opens a file; Cmd+Shift+F opens Search, and a result lands on its line, marked and selected.
//
// The unit tests drive both through a fake transport and jsdom, which measures nothing -- so they
// cannot see that `rg` really answered, that the viewer really scrolled, or that the line band sits
// on the line. Everything below is the live sidecar and real layout.
//
// Run against a live panel (`PANEL_ORIGIN=https://<mac>.<tailnet>.ts.net:5173 node
// chrome-test/ide-search-verify.mjs`). Playwright's Chrome for Testing with a throwaway context,
// never the owner's Chrome. It works in whichever workspace the IDE resolves first and needs one
// holding this repository's panel sources. Opening files is shared state, so every tab it opens
// that was not already open is closed again before it exits.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
// Test-only, as in the other verifiers: the dev origin's certificate names the tailnet host.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const work = mkdtempSync(join(tmpdir(), 'ide-search-verify-'));
const shots = process.env.SHOTS_DIR || work;
const failures = [];
function check(claim, held, detail) {
  console.log(`${held ? 'ok  ' : 'FAIL'} ${claim}${detail ? `  (${detail})` : ''}`);
  if (!held) failures.push(claim);
}

const browser = await chromium.launch({ headless: false });
const watchdog = setTimeout(() => {
  console.error('FAIL watchdog: the run hung');
  void browser.close().finally(() => process.exit(2));
}, 120_000);

const tabNames = (page) => page.$$eval('[role="tablist"][aria-label="Open files"] [role="tab"]',
  (tabs) => tabs.map((tab) => tab.getAttribute('aria-label')));
let opened = [];
let page;

try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  await page.goto(`${ORIGIN}/?entry=ide`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role="tree"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const before = await tabNames(page);

  // Quick open, by double Shift.
  await page.keyboard.press('Shift');
  await page.keyboard.press('Shift');
  const dialog = page.getByRole('dialog', { name: 'Go to file' });
  await dialog.waitFor({ timeout: 5000 });
  check('double Shift opens quick open', true);
  await page.waitForSelector('[role="dialog"] [role="option"]', { timeout: 10000 });
  await page.keyboard.type('fuzzymatch');
  await page.waitForTimeout(300);
  const first = await dialog.locator('[role="option"]').first().innerText();
  check('the fuzzy match puts fuzzyMatch.ts first', /fuzzyMatch\.ts/.test(first), first.replace(/\s+/g, ' '));
  const marked = await dialog.locator('[role="option"]').first().locator('mark').count();
  check('the matched characters are marked', marked > 0, `${marked} marks`);
  await page.screenshot({ path: join(shots, 'quick-open.png') });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const afterQuick = await tabNames(page);
  check('Enter opens the file as a tab', afterQuick.some((name) => /fuzzyMatch\.ts/.test(name ?? '')));

  // Text search, by Cmd+Shift+F.
  await page.keyboard.press('Meta+Shift+F');
  const field = page.getByRole('searchbox', { name: 'Search in files' });
  await field.waitFor({ timeout: 5000 });
  check('Cmd+Shift+F opens Search with the caret in it', await field.evaluate((el) => el === document.activeElement));
  await page.keyboard.type('AUTOSAVE_DELAY_MS');
  await page.waitForSelector('button[aria-label^="Open "][aria-label*=" at line "]', { timeout: 15000 });
  const status = await page.locator('[role="status"]').filter({ hasText: /result/ }).first().innerText();
  check('the sidecar answers with results', /result/.test(status), status);
  const result = page.locator('button[aria-label*="useWorkspaceIdeWriting.ts at line"]').last();
  const label = await result.getAttribute('aria-label');
  const line = Number(/line (\d+)/.exec(label ?? '')?.[1]);
  await result.click();
  await page.waitForTimeout(2000);

  const viewer = await page.evaluate(() => {
    const area = document.querySelector('main textarea');
    if (!area) return null;
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    const lineOfCaret = area.value.slice(0, area.selectionStart).split('\n').length;
    const band = area.parentElement?.querySelector('div.bg-primary\\/15');
    const bandBox = band?.getBoundingClientRect();
    const areaBox = area.getBoundingClientRect();
    return {
      selected,
      lineOfCaret,
      scrollTop: area.scrollTop,
      bandShown: Boolean(band) && getComputedStyle(band).display !== 'none',
      bandInView: bandBox ? bandBox.top >= areaBox.top && bandBox.bottom <= areaBox.bottom : false,
    };
  });
  check('the result opens the file in the viewer', viewer !== null);
  if (viewer) {
    check('the match is selected', viewer.selected === 'AUTOSAVE_DELAY_MS', JSON.stringify(viewer.selected));
    check('the caret is on the result line', viewer.lineOfCaret === line, `${viewer.lineOfCaret} vs ${line}`);
    check('the line band is shown and on screen', viewer.bandShown && viewer.bandInView);
  }
  const previewTab = await page.$$eval('[role="tab"] span.italic', (spans) => spans.map((span) => span.textContent));
  check('the result opened as the italic preview tab', previewTab.includes('useWorkspaceIdeWriting.ts'), previewTab.join(','));
  await page.screenshot({ path: join(shots, 'search-result.png') });

  // A phone's width: the toolbar button is its way in.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'Go to file' }).click();
  await dialog.waitFor({ timeout: 5000 });
  const box = await dialog.boundingBox();
  check('quick open fits a phone screen', box !== null && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  await page.screenshot({ path: join(shots, 'quick-open-phone.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1400, height: 900 });

  opened = (await tabNames(page)).filter((name) => !before.includes(name));
} catch (error) {
  check(`the run completed: ${error instanceof Error ? error.message : String(error)}`, false);
} finally {
  // Put the shared tabs back as they were.
  if (page) {
    for (const name of opened) {
      const file = (name ?? '').replace(/^Open /, '').replace(/, preview$/, '');
      await page.locator(`button[aria-label="Close ${file}"]`).first().click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  clearTimeout(watchdog);
  await browser.close();
  if (!process.env.SHOTS_DIR) rmSync(work, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nall checks held' : `\n${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
