// Verifies the Arena's terminals mode end to end against a live panel and sidecar: a run started
// from the tab's form in the Terminals mode gives each contestant a pane, each lane joins that
// pane with the panel's own terminal, the contestants wait at `starting` / `ready` until every
// one can take the prompt, and then the one prompt closes in each.
//
// Claude asks whether to trust a new folder before its composer appears, and each contestant's
// worktree is a new folder. The run waits for a reader to answer that, so this answers it the way
// a reader would, in that lane's terminal: the question opens on "No, exit", so Down, then Enter.
// That is also the check that the lane's terminal takes typing.
//
//   PANEL_ORIGIN=https://<this-mac>.<tailnet>.ts.net:5173 node chrome-test/arena-terminals-verify.mjs
//
// The repository is a throwaway this script makes and deletes, and the run is deleted at the end,
// which ends its panes; ARENA_KEEP_RUN=1 keeps the run (and the repository) to sweep it. Uses Playwright's Chrome for Testing with a throwaway profile.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel origin');
const LINEUP = (process.env.ARENA_LINEUP ?? 'opencode,claude').split(',').map((one) => one.trim());
const LABEL = { opencode: 'OpenCode', claude: 'Claude' };
const PROMPT = 'Reply with exactly the first line of README.md and nothing else';
const TMUX = process.env.AGENT_FEED_TMUX_PATH ?? '/opt/homebrew/bin/tmux';

async function playwrightRoot() {
  const told = process.env.AGENTDESK_PLAYWRIGHT_ROOT;
  if (told) return told;
  const fromNpm = join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
  try {
    await import(`${fromNpm}/index.mjs`);
    return fromNpm;
  } catch {
    const shim = execFileSync('cat', ['/Users/dev/Library/pnpm/bin/playwright']).toString();
    const target = /cmd-shim-target=(.*)\/cli\.js/.exec(shim)?.[1];
    if (!target) throw new Error('no global playwright found: set AGENTDESK_PLAYWRIGHT_ROOT');
    return target;
  }
}
const { chromium } = await import(`${await playwrightRoot()}/index.mjs`);

const work = mkdtempSync(join(tmpdir(), 'arena-terminals-'));
const repo = join(work, 'repo');
execFileSync('git', ['init', '-q', repo]);
writeFileSync(join(repo, 'README.md'), 'alder grove\n\nA throwaway repository for an arena check.\n');
execFileSync('git', ['-C', repo, 'add', 'README.md']);
execFileSync('git', ['-C', repo, '-c', 'user.name=arena', '-c', 'user.email=arena@localhost', 'commit', '-qm', 'readme']);

const shots = process.env.ARENA_SHOTS ?? work;
let failed = true;
let runId = null;
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  headless: true,
  args: ['--no-first-run'],
  ignoreHTTPSErrors: true,
  viewport: { width: 1600, height: 1000 },
});
const api = async (path, init) => {
  const response = await context.request.fetch(`${ORIGIN}${path}`, init);
  return { status: response.status(), body: await response.json().catch(() => null) };
};
const contestants = async () => (await api(`/api/arena/runs/${runId}`)).body?.contestants ?? [];
const paneText = (pane) => {
  try {
    return execFileSync(TMUX, ['capture-pane', '-p', '-t', pane], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch {
    return '';
  }
};

try {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  const modes = await api('/api/arena/modes');
  if (modes.body?.modes?.[0] !== 'terminals') throw new Error(`this machine does not offer terminals first: ${JSON.stringify(modes.body)}`);

  await page.goto(`${ORIGIN}/?entry=arena`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Arena' }).waitFor({ timeout: 15_000 });
  const terminals = page.getByRole('radiogroup', { name: 'How the contestants are driven' }).getByRole('radio', { name: 'Terminals' });
  await terminals.waitFor({ timeout: 10_000 });
  if (await terminals.isDisabled()) problems.push('the Terminals mode is offered disabled');
  await terminals.click();
  if (await terminals.getAttribute('aria-checked') !== 'true') problems.push('the Terminals mode did not take');

  await page.getByLabel('Prompt every contestant gets').fill(PROMPT);
  await page.getByLabel('Repository the contestants work in').fill(repo);
  while (await page.getByLabel('Remove contestant 1').count() > 0) await page.getByLabel('Remove contestant 1').click();
  for (const [index, source] of LINEUP.entries()) {
    if (index > 0) await page.getByLabel('Add a contestant').click();
    await page.getByRole('radiogroup', { name: `Contestant ${index + 1} harness` }).getByRole('radio', { name: LABEL[source] }).click();
  }
  await page.getByRole('button', { name: /Start run/ }).click();
  await page.getByRole('tablist', { name: 'Compare by' }).waitFor({ timeout: 20_000 });
  runId = (await api('/api/arena/runs')).body?.runs?.[0]?.runId ?? null;
  if (!runId) throw new Error('no run was listed after starting one');
  const run = (await api(`/api/arena/runs/${runId}`)).body;
  if (run?.mode !== 'terminals') problems.push(`the run was made in mode ${run?.mode}`);

  // Every contestant gets a pane, and its lane joins it.
  const deadline = Date.now() + 60_000;
  while ((await contestants()).some((c) => !c.tmuxSession && c.status !== 'failed') && Date.now() < deadline) {
    await page.waitForTimeout(500);
  }
  for (const [index, source] of LINEUP.entries()) {
    const lane = page.getByRole('region', { name: `c${index + 1} ${LABEL[source]} session` });
    await lane.locator('.xterm').first().waitFor({ timeout: 20_000 }).catch(() => problems.push(`c${index + 1}'s lane has no terminal`));
  }
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(shots, 'arena-terminals-starting.png') });
  console.log('statuses after the panes:', (await contestants()).map((c) => `${c.contestantId}=${c.status}`).join(' '));

  // Answer each Claude contestant's folder-trust question in its own lane, as a reader would.
  const answered = new Set();
  const closeBy = Date.now() + 240_000;
  while (Date.now() < closeBy) {
    const now = await contestants();
    if (now.every((c) => c.status === 'closed' || c.status === 'failed')) break;
    for (const [index, c] of now.entries()) {
      if (c.source !== 'claude' || c.status !== 'starting' || !c.tmuxSession || answered.has(c.contestantId)) continue;
      if (!/trust/i.test(paneText(c.tmuxSession))) continue;
      const lane = page.getByRole('region', { name: `c${index + 1} ${LABEL[c.source]} session` });
      await lane.locator('.xterm').first().click();
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      answered.add(c.contestantId);
      console.log(`answered ${c.contestantId}'s folder-trust question in its lane`);
    }
    await page.waitForTimeout(1000);
  }

  const final = await contestants();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(shots, 'arena-terminals-closed.png') });
  for (const c of final) {
    if (c.status !== 'closed') problems.push(`${c.contestantId} (${c.source}) ended ${c.status}: ${c.error ?? ''}`);
    if (!c.tmuxSession) problems.push(`${c.contestantId} has no pane on its record`);
    else if (!paneText(c.tmuxSession)) problems.push(`${c.contestantId}'s pane ${c.tmuxSession} is gone before the run was deleted`);
    if (c.startedAt === null || c.durationMs === null) problems.push(`${c.contestantId} has no clock`);
  }
  const starts = final.map((c) => c.startedAt).filter((t) => t !== null);
  if (starts.length > 1 && Math.max(...starts) - Math.min(...starts) > 3000) {
    problems.push(`the prompts did not go in together: starts ${starts.join(', ')}`);
  }
  console.log(final.map((c) => `${c.contestantId} ${c.source}: ${c.status} in ${c.durationMs}ms, pane ${c.tmuxSession}, wrote ${c.filesWritten.length} read ${c.filesRead.length}`).join('\n'));

  if (problems.length > 0) {
    console.error(problems.join('\n'));
    throw new Error(`arena terminals verify found ${problems.length} problem(s)`);
  }
  console.log(`arena terminals verify OK; screenshots in ${shots}`);
  failed = false;
} finally {
  if (runId && process.env.ARENA_KEEP_RUN) {
    console.log(`kept run ${runId} and its panes; delete it from the Arena tab when done`);
  } else if (runId) {
    // Deleting the run ends its panes and removes its worktrees; a live one is refused, so give a
    // failed check's contestants nothing more to wait for first.
    const deleted = await api(`/api/arena/runs/${runId}`, { method: 'DELETE' }).catch(() => null);
    if (deleted?.status !== 200) console.error(`the run could not be deleted (${deleted?.status}); delete ${runId} by hand`);
  }
  await context.close().catch(() => {});
  if (!process.env.ARENA_SHOTS && !process.env.ARENA_KEEP_RUN) rmSync(work, { recursive: true, force: true });
  else rmSync(join(work, 'profile'), { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
