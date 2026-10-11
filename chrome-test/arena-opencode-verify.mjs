// Verifies the Arena tab end to end against a live panel and sidecar: a run created from the
// tab's own form fans a prompt out to opencode contestants, the stream moves their statuses to
// the page without a reload, and the facts each contestant left -- duration, files read, the
// diff -- arrive on the run's detail once they close.
//
// Run it against an arena sidecar and its panel origin:
//   PANEL_ORIGIN=http://127.0.0.1:5174 ARENA_REPO=/path/to/a/git/repo node chrome-test/arena-opencode-verify.mjs
//
// The repo the run duels in is a throwaway by requirement: contestants write worktrees under
// the sidecar's arena root, and a run against a real checkout would duel it. Uses Playwright's
// Chrome for Testing with a throwaway profile, never the owner's Chrome, and stays off every
// other surface so nothing it does can disturb a live stream.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel origin the arena sidecar is behind');
const REPO = process.env.ARENA_REPO;
if (!REPO) throw new Error('set ARENA_REPO to the throwaway git repo the run duels in');
const PROMPT = process.env.ARENA_PROMPT
  ?? 'Read README.md in this repository and reply with its exact first line';

/** Where this machine's global playwright lives, checked rather than assumed. */
async function playwrightRoot() {
  const told = process.env.AGENTDESK_PLAYWRIGHT_ROOT;
  if (told) return told;
  const fromNpm = join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
  try {
    await import(`${fromNpm}/index.mjs`);
    return fromNpm;
  } catch {
    // This machine's global is pnpm's; its store path is behind the bin shim's own words.
    const shim = execFileSync('cat', ['/Users/dev/Library/pnpm/bin/playwright']).toString();
    const target = /cmd-shim-target=(.*)\/cli\.js/.exec(shim)?.[1];
    if (!target) throw new Error('no global playwright found: set AGENTDESK_PLAYWRIGHT_ROOT');
    return target;
  }
}
const { chromium } = await import(`${await playwrightRoot()}/index.mjs`);

const work = mkdtempSync(join(tmpdir(), 'arena-verify-'));
let failed = true;
// Launch persistent, not `launch` + a context: the throwaway profile is the whole point, and
// `launch` refuses a `userDataDir` outright on this Playwright.
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  headless: true,
  args: ['--no-first-run'],
});
try {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto(`${ORIGIN}/?entry=arena`, { waitUntil: 'domcontentloaded' });

  // The tab is one of the bar's surfaces; landing on `?entry=arena` selects it, and the bar
  // says which one is selected. Both are the assertions: the tab exists, and the reader is on it.
  await page.getByRole('tab', { name: 'Arena' }).waitFor({ timeout: 15_000 });
  const selected = await page.getByRole('tab', { name: 'Arena' }).getAttribute('aria-selected');
  if (selected !== 'true') problems.push(`the Arena tab is not selected (aria-selected=${selected})`);

  await page.getByLabel('Prompt every contestant gets').fill(PROMPT);
  await page.getByLabel('Repository the contestants work in').fill(REPO);
  await page.getByText('Start run', { exact: true }).click();

  // The run appears in the list, selected, and the stream moves its statuses without a reload.
  // A contestant that closes under this reader is the whole point of the tab. The row is the
  // newest: earlier runs may share a prompt's head, and the list is newest-first.
  const row = page.getByRole('button', { name: new RegExp(PROMPT.slice(0, 24)) }).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  const contestant = page.locator('article', { hasText: 'c1' });
  await contestant.getByText('closed', { exact: true }).waitFor({ timeout: 120_000 });

  // The facts: a duration, the file the prompt asked for, and a diff affordance that opens.
  const facts = await contestant.locator('p').first().innerText();
  if (!/\d+(\.\d+)?s/.test(facts)) problems.push(`no duration in the facts line: "${facts}"`);
  if (!facts.includes('read')) problems.push(`no read count in the facts line: "${facts}"`);

  // The files ride a closed <details>, and closed-details content is display:none -- excluded
  // from the role tree in Chromium. Open it, then read the list it was hiding.
  const readSummary = contestant.getByText(/^Read \d+$/);
  if (await readSummary.count() === 0) {
    problems.push('no read-files affordance: the run recorded no files read');
  } else {
    await readSummary.click();
    const files = contestant.getByRole('listitem');
    const fileCount = await files.count();
    if (fileCount === 0) {
      problems.push('the read files list opened empty: the run recorded no files read');
    } else {
      const first = await files.first().innerText();
      if (!first.includes('README.md')) {
        problems.push(`README.md is not among the files read (first: "${first}")`);
      }
    }
  }

  const diff = contestant.getByText('Diff', { exact: true });
  if (await diff.count() > 0) {
    await diff.click();
    await contestant.locator('pre').waitFor({ timeout: 5_000 });
  }

  // The contestant's session is an ordinary session: it exists on this sidecar's catalog, so
  // the panel's session surfaces can list it. Read through the sidecar the panel talks to.
  const sid = await contestant.locator('p').nth(1).innerText();
  const listed = await context.request.get(`${ORIGIN}/api/arena/runs`);
  if (!listed.ok()) problems.push(`GET /api/arena/runs answered ${listed.status()}`);

  if (problems.length > 0) {
    // The card as the browser read it, beside the run as the sidecar holds it: the two halves
    // of a facts disagreement are worth more than either alone.
    console.error('--- the card as rendered ---');
    console.error(await contestant.innerText().catch(() => '(the card was gone)'));
    console.error('--- the run as the sidecar holds it ---');
    const shown = await page.evaluate(() => window.location.href);
    console.error(`page: ${shown}`);
    console.error(problems.join('\n'));
    throw new Error(`arena verify found ${problems.length} problem(s)`);
  }
  console.log(`arena verify OK: run closed on the tab, facts read (${facts.trim()}), session ${sid.trim()}`);
  failed = false;
} finally {
  await context.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}