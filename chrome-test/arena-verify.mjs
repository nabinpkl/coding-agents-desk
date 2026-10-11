// Verifies the Arena tab end to end against a live panel and sidecar: a run created from the
// tab's own form fans a prompt out to the lineup the form was given, the stream moves each
// contestant's status to the page without a reload, and the facts each one left -- duration,
// files read, the diff -- arrive on the run's detail once it closes; a contestant expected to
// fail shows the reason it failed.
//
// Run it against an arena sidecar and its panel origin:
//   PANEL_ORIGIN=http://127.0.0.1:5174 ARENA_REPO=/path/to/a/git/repo \
//   ARENA_LINEUP=opencode,claude ARENA_EXPECT=closed,closed node chrome-test/arena-verify.mjs
//
// ARENA_LINEUP is the harness of each slot, in order (default `opencode`). ARENA_EXPECT is how
// each slot should end, `closed` or `failed` (default all `closed`): a provider that is out of
// quota fails its contestant, and the card saying why is then the thing to verify.
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
const LINEUP = (process.env.ARENA_LINEUP ?? 'opencode').split(',').map((one) => one.trim());
const EXPECT = (process.env.ARENA_EXPECT ?? LINEUP.map(() => 'closed').join(','))
  .split(',').map((one) => one.trim());
if (EXPECT.length !== LINEUP.length) throw new Error('ARENA_EXPECT names one end state per lineup slot');
const LABEL = { opencode: 'OpenCode', claude: 'Claude' };

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

  // The lineup, through the form's own controls: shrink to one slot, then add and set each.
  while (await page.getByLabel('Remove contestant 1').count() > 0) {
    await page.getByLabel('Remove contestant 1').click();
  }
  for (const [index, source] of LINEUP.entries()) {
    if (index > 0) await page.getByLabel('Add a contestant').click();
    await page.getByLabel(`Contestant ${index + 1} harness`).selectOption(source);
  }
  await page.getByText('Start run', { exact: true }).click();

  // The run appears in the list, selected, and the stream moves its statuses without a reload.
  // A contestant that closes under this reader is the whole point of the tab. The row is the
  // newest: earlier runs may share a prompt's head, and the list is newest-first.
  const row = page.getByRole('button', { name: new RegExp(PROMPT.slice(0, 24)) }).first();
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  const summaries = [];
  const cards = [];
  for (const [index, source] of LINEUP.entries()) {
    const id = `c${index + 1}`;
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: new RegExp(`^${id}\\b`) }) });
    cards.push(card);
    const heading = await card.getByRole('heading').innerText({ timeout: 20_000 });
    if (!heading.includes(LABEL[source])) problems.push(`${id}'s card names "${heading}", not ${LABEL[source]}`);

    const end = EXPECT[index];
    // The status reads as its word, with a mark in front of the states that carry one.
    await card.getByText(new RegExp(`^\\W*${end}$`)).waitFor({ timeout: 180_000 }).catch(async () => {
      problems.push(`${id} did not end ${end}: "${await card.innerText().catch(() => '(gone)')}"`);
    });
    const facts = await card.locator('p').first().innerText();
    if (!/\d+(\.\d+)?s/.test(facts)) problems.push(`${id}: no duration in the facts line: "${facts}"`);

    if (end === 'failed') {
      // A failure is a fact about the contestant, and the card is where its reason belongs.
      const said = await card.locator('p.text-destructive').innerText().catch(() => '');
      if (!said.trim()) problems.push(`${id} failed with no reason on its card`);
      summaries.push(`${id} ${source} failed: ${said.trim()}`);
      continue;
    }

    // The files ride a closed <details>, and closed-details content is display:none -- excluded
    // from the role tree in Chromium. Open it, then read the list it was hiding.
    const readSummary = card.getByText(/^Read \d+$/);
    if (await readSummary.count() === 0) {
      problems.push(`${id}: no read-files affordance, the run recorded no files read`);
    } else {
      await readSummary.click();
      const files = (await card.getByRole('listitem').allInnerTexts()).join('\n');
      if (!files.includes('README.md')) problems.push(`${id}: README.md is not among the files read`);
    }
    const diff = card.getByText('Diff', { exact: true });
    if (await diff.count() > 0) {
      await diff.click();
      await card.locator('pre').waitFor({ timeout: 5_000 });
    }
    summaries.push(`${id} ${source} closed (${facts.trim()})`);
  }

  const listed = await context.request.get(`${ORIGIN}/api/arena/runs`);
  if (!listed.ok()) problems.push(`GET /api/arena/runs answered ${listed.status()}`);
  if (process.env.ARENA_SCREENSHOT) {
    await page.screenshot({ path: process.env.ARENA_SCREENSHOT, fullPage: true });
  }

  if (problems.length > 0) {
    // The card as the browser read it, beside the run as the sidecar holds it: the two halves
    // of a facts disagreement are worth more than either alone.
    console.error('--- the cards as rendered ---');
    for (const card of cards) console.error(await card.innerText().catch(() => '(the card was gone)'));
    console.error('--- the run as the sidecar holds it ---');
    const shown = await page.evaluate(() => window.location.href);
    console.error(`page: ${shown}`);
    console.error(problems.join('\n'));
    throw new Error(`arena verify found ${problems.length} problem(s)`);
  }
  console.log(`arena verify OK:\n  ${summaries.join('\n  ')}`);
  failed = false;
} finally {
  await context.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}