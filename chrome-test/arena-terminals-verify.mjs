// Verifies the Arena's terminals mode end to end against a live panel and sidecar, the way a
// reader uses it: Open lanes from a blank form -- no name, no repository, no prompt -- so the run
// takes the next "arena run N" and a new repository of its own in the arena home; each contestant
// gets a pane that its lane's session view shows above its composer, the feed empty until the
// session's first turn, every lane
// comes up to `ready`, and only then is the one prompt typed on the run -- which closes in each
// lane. Deleting the run at the end must take its folder, repository and all.
//
// Claude asks whether to trust a new folder before its composer appears, and each contestant's
// worktree is a new folder. The run waits for a reader to answer that, so this answers it the way
// a reader would, in that lane's terminal: the question opens on "No, exit", so Down, then Enter.
// That is also the check that the lane's terminal takes typing.
//
//   PANEL_ORIGIN=https://<this-mac>.<tailnet>.ts.net:5173 node chrome-test/arena-terminals-verify.mjs
//
// The run is deleted at the end, which ends its panes and removes its folder; ARENA_KEEP_RUN=1
// keeps it to sweep it. Uses Playwright's Chrome for Testing with a throwaway profile.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel origin');
const LINEUP = (process.env.ARENA_LINEUP ?? 'opencode,claude').split(',').map((one) => one.trim());
const LABEL = { opencode: 'OpenCode', claude: 'Claude' };
const PROMPT = 'Reply with exactly the word alder and nothing else';
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
const tmuxSessions = () => {
  try {
    return execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
// Each lane holds exactly one terminal: its pane, above the composer. Two would be a lane showing
// the same pane twice.
const oneTerminalPerLane = async (page, problems, when) => {
  for (const [index, source] of LINEUP.entries()) {
    const count = await page.getByRole('region', { name: `c${index + 1} ${LABEL[source]} session` }).locator('.xterm').count();
    if (count !== 1) problems.push(`c${index + 1}'s lane holds ${count} terminals ${when}`);
  }
};
// Every lane is the whole session view from the moment its pane is up, a Claude lane before its
// first turn included: the composer with its attach control, and its terminal control showing the
// pane, the same as any session the panel shows.
const sessionViewPerLane = async (page, problems, when) => {
  for (const [index, source] of LINEUP.entries()) {
    const lane = page.getByRole('region', { name: `c${index + 1} ${LABEL[source]} session` });
    if (await lane.getByRole('button', { name: /Add an image/ }).count() !== 1) problems.push(`c${index + 1}'s lane has no attach control ${when}`);
    if (await lane.getByRole('button', { name: 'Hide the terminal' }).count() !== 1) problems.push(`c${index + 1}'s lane has no terminal control showing its pane ${when}`);
  }
};
// The lanes take the room under the facts, so every composer, and the pane above it, is on screen
// without scrolling the page: an empty feed is the part that gives way.
const composersOnScreen = async (page, problems, when) => {
  const { innerHeight } = await page.evaluate(() => ({ innerHeight: window.innerHeight }));
  for (const [index, source] of LINEUP.entries()) {
    const lane = page.getByRole('region', { name: `c${index + 1} ${LABEL[source]} session` });
    const field = await lane.getByRole('button', { name: /Add an image/ }).boundingBox();
    if (!field || field.y + field.height > innerHeight) problems.push(`c${index + 1}'s composer is below the window ${when} (bottom ${field ? Math.round(field.y + field.height) : 'none'} of ${innerHeight})`);
  }
};
// What each lane's pane shows is the contestant's own harness, not a shell of its own in the
// worktree, which looks alike in a screenshot: the harness's footer is on its screen, and a shell's
// is not. Read from the rows actually in view, because the pane is a peek at a taller screen, and
// the footer being somewhere in it says nothing about whether a reader can see it -- Claude draws
// near the top of its pane, and a peek at the bottom showed only the blank rows under its box.
const HARNESS_FOOTER = { opencode: /ctrl\+p commands/, claude: /don't ask on/ };
const harnessInView = async (page, problems, when) => {
  for (const [index, source] of LINEUP.entries()) {
    const shown = await page.getByRole('region', { name: `c${index + 1} ${LABEL[source]} session` }).locator('.xterm').first()
      .evaluate((node) => {
        const port = node.parentElement.getBoundingClientRect();
        return [...(node.querySelector('.xterm-rows')?.children ?? [])]
          .filter((row) => {
            const box = row.getBoundingClientRect();
            return box.top >= port.top - 1 && box.bottom <= port.bottom + 1;
          })
          .map((row) => row.textContent)
          .join('\n');
      });
    if (!HARNESS_FOOTER[source].test(shown)) problems.push(`c${index + 1}'s pane does not show ${LABEL[source]}'s footer ${when}: ${JSON.stringify(shown.replace(/\s+/g, ' ').slice(-120))}`);
  }
};
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

  const defaults = (await api('/api/arena/new-run')).body;
  if (defaults?.modes?.[0] !== 'terminals') throw new Error(`this machine does not offer terminals first: ${JSON.stringify(defaults)}`);

  await page.goto(`${ORIGIN}/?entry=arena`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Arena' }).waitFor({ timeout: 15_000 });
  const terminals = page.getByRole('radiogroup', { name: 'How the contestants are driven' }).getByRole('radio', { name: 'Terminals' });
  await terminals.waitFor({ timeout: 10_000 });
  if (await terminals.isDisabled()) problems.push('the Terminals mode is offered disabled');
  await terminals.click();
  if (await terminals.getAttribute('aria-checked') !== 'true') problems.push('the Terminals mode did not take');

  // A blank form: the name and the repository are left to their defaults, which the form shows.
  await page.getByLabel('Run name').fill('');
  await page.getByLabel('Repository the contestants work in').fill('');
  const shownName = await page.getByLabel('Run name').getAttribute('placeholder');
  if (shownName !== defaults.nextName) problems.push(`the form offers the name "${shownName}", the sidecar "${defaults.nextName}"`);
  while (await page.getByLabel('Remove contestant 1').count() > 0) await page.getByLabel('Remove contestant 1').click();
  for (const [index, source] of LINEUP.entries()) {
    if (index > 0) await page.getByLabel('Add a contestant').click();
    await page.getByRole('radiogroup', { name: `Contestant ${index + 1} harness` }).getByRole('radio', { name: LABEL[source] }).click();
  }
  const sessionsBefore = new Set(tmuxSessions());
  await page.getByRole('button', { name: /Open lanes/ }).click();
  await page.getByRole('tablist', { name: 'Compare by' }).waitFor({ timeout: 20_000 });
  runId = (await api('/api/arena/runs')).body?.runs?.[0]?.runId ?? null;
  if (!runId) throw new Error('no run was listed after starting one');
  // The run is in the address, so a reload comes back to it rather than to the form.
  if (new URL(page.url()).searchParams.get('run') !== runId) problems.push(`the address does not name the run: ${page.url()}`);
  const run = (await api(`/api/arena/runs/${runId}`)).body;
  if (run?.mode !== 'terminals') problems.push(`the run was made in mode ${run?.mode}`);
  if (run?.prompt !== '') problems.push(`lanes opened without a prompt carry one: "${run?.prompt}"`);
  if (run?.name !== defaults.nextName) problems.push(`the run is named "${run?.name}", not the offered "${defaults.nextName}"`);
  const folder = run?.repoPath;
  if (!run?.repoCreated || !folder?.startsWith(`${defaults.arenaHome}/`)) {
    problems.push(`the run did not get a repository of its own in ${defaults.arenaHome}: ${folder} (repoCreated ${run?.repoCreated})`);
  } else if (!existsSync(join(folder, '.git')) || !run.contestants.every((c) => c.worktreePath.startsWith(`${folder}/`))) {
    problems.push(`${folder} is not a repository holding the contestants' worktrees`);
  }

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

  // Answer each Claude contestant's folder-trust question in its own lane, as a reader would, and
  // wait for every lane to be ready before there is any prompt at all.
  const answered = new Set();
  const answerTrust = async () => {
    for (const [index, c] of (await contestants()).entries()) {
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
  };
  const readyBy = Date.now() + 120_000;
  while (Date.now() < readyBy && !(await contestants()).every((c) => c.status === 'ready' || c.status === 'failed')) {
    await answerTrust();
    await page.waitForTimeout(1000);
  }
  const atLine = await contestants();
  if (!atLine.every((c) => c.status === 'ready')) {
    problems.push(`not every lane came up ready: ${atLine.map((c) => `${c.contestantId}=${c.status} ${c.error ?? ''}`).join(', ')}`);
  }
  if (atLine.some((c) => c.startedAt !== null)) problems.push('a lane started its clock before there was a prompt');
  await page.waitForTimeout(2000);
  await oneTerminalPerLane(page, problems, 'while waiting for the prompt');
  await sessionViewPerLane(page, problems, 'while waiting for the prompt');
  await composersOnScreen(page, problems, 'while waiting for the prompt');
  await harnessInView(page, problems, 'while waiting for the prompt');
  await page.reload();
  await page.getByRole('tablist', { name: 'Compare by' }).waitFor({ timeout: 20_000 })
    .catch(() => problems.push('a reload did not come back to the run'));
  await page.waitForTimeout(3000);
  await oneTerminalPerLane(page, problems, 'after a reload');
  await sessionViewPerLane(page, problems, 'after a reload');
  await page.screenshot({ path: join(shots, 'arena-terminals-ready.png') });
  for (const [index, source] of LINEUP.entries()) {
    await page.getByRole('region', { name: `c${index + 1} ${LABEL[source]} session` })
      .screenshot({ path: join(shots, `arena-terminals-ready-c${index + 1}.png`) });
  }

  // Now the prompt, typed once on the run, for every lane.
  await page.getByLabel('Prompt every lane gets').fill(PROMPT);
  await page.getByRole('button', { name: /Send to every lane/ }).click();
  const closeBy = Date.now() + 240_000;
  while (Date.now() < closeBy && !(await contestants()).every((c) => c.status === 'closed' || c.status === 'failed')) {
    await page.waitForTimeout(1000);
  }
  if ((await api(`/api/arena/runs/${runId}`)).body?.prompt !== PROMPT) problems.push('the run does not carry the prompt it was sent');

  const final = await contestants();
  await page.waitForTimeout(2000);
  await oneTerminalPerLane(page, problems, 'once the turns closed');
  await sessionViewPerLane(page, problems, 'once the turns closed');
  await harnessInView(page, problems, 'once the turns closed');
  // Only the contestants' own panes are new: a lane's terminal joins its pane, never starts one.
  const madeByRun = tmuxSessions().filter((name) => !sessionsBefore.has(name));
  if (madeByRun.length !== LINEUP.length) problems.push(`the run left ${madeByRun.length} new tmux sessions, not ${LINEUP.length}: ${madeByRun.join(', ')}`);
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
    const folder = (await api(`/api/arena/runs/${runId}`)).body?.repoPath;
    const deleted = await api(`/api/arena/runs/${runId}`, { method: 'DELETE' }).catch(() => null);
    if (deleted?.status !== 200) console.error(`the run could not be deleted (${deleted?.status}); delete ${runId} by hand`);
    else if (folder && existsSync(folder)) {
      console.error(`deleting the run left its folder ${folder}`);
      failed = true;
    }
  }
  await context.close().catch(() => {});
  if (!process.env.ARENA_SHOTS && !process.env.ARENA_KEEP_RUN) rmSync(work, { recursive: true, force: true });
  else rmSync(join(work, 'profile'), { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
