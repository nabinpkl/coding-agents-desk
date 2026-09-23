// Checks that a long message typed into the mirrored composer survives Claude collapsing it.
//
// Claude Code replaces a bracketed paste of more than 800 characters, or of more than three lines,
// with a `[Pasted text #N]` handle in its own prompt box, and moves the words into a table inside
// that process (measured 2026-09-22 on a live pane against v2.1.263: literal at 800 characters and
// at three lines, collapsed at 801 and at four). The panel's pushes cross that line the moment
// somebody writes a real message, so the reading that comes back from the pane names a handle to
// words the browser can no longer read.
//
// The unit test pins the reconciliation rule with a fake stream. It cannot pin THIS, which is that
// a real Claude really does collapse a real push and that the field really does keep the message
// anyway -- both halves live outside the panel, one in the CLI's renderer and one in the sidecar's
// watcher.
//
// Needs a live panel (`just host-run`) and a session in a tmux pane to type into. It makes its own
// throwaway session rather than borrowing one, because it types into the composer it is testing:
// `just composer-paste-collapse-verify`. Chrome for Testing with a throwaway profile, never the
// owner's Chrome.

import { execFileSync, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

const ORIGIN = process.env.PANEL_ORIGIN || 'https://127.0.0.1:5173';
const REPO = process.env.PANEL_PROJECT || process.cwd();
// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a
// name mismatch every time. Test-only; the browser side says the same through `ignoreHTTPSErrors`.
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

/** The session name belongs to this RUN, because several agents share this machine's tmux. */
const NAME = `paste-collapse-${process.pid}`;
// Named absolutely and kept, so the teardown removes exactly what this run created.
const WORK = mkdtempSync(join(tmpdir(), 'paste-collapse-'));

let browser = null;
let started = false;
async function teardown() {
  if (browser) await browser.close().catch(() => {});
  if (started) {
    await run(join(REPO, 'tools/throwaway-session.sh'), ['stop', NAME], { cwd: REPO }).catch(() => {});
  }
  rmSync(WORK, { recursive: true, force: true });
}
// A hung run still tidies up before it exits non-zero.
const watchdog = setTimeout(() => {
  console.error('composer-paste-collapse-verify: timed out');
  teardown().finally(() => process.exit(1));
}, 240000);

try {
  const { stdout } = await run(join(REPO, 'tools/throwaway-session.sh'), ['start', NAME], { cwd: REPO });
  started = true;
  const sessionId = stdout.trim();
  const session = { projectPath: REPO, source: 'claude', sessionId };

  // More than 800 characters, which is what makes Claude collapse the push.
  const message = 'zebra '.repeat(150).trim();

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
  });
  await context.addInitScript((sel) => {
    localStorage.setItem('agent-panel.selection', JSON.stringify(sel));
  }, session);
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/?entry=feed`, { waitUntil: 'domcontentloaded' });

  // Reaching for the field is what attaches the mirror: opening the stream puts a `tmux pipe-pane`
  // on the pane, so the panel waits for intent rather than doing it to every thread somebody
  // opens to read. Until then the band is the CLI inbox, which is a different field.
  const INBOX = '[aria-label="Message this terminal session"]';
  const FIELD = '[aria-label="Type into this session\'s terminal composer"]';
  await page.waitForSelector(INBOX, { timeout: 60000 });
  await page.focus(INBOX);
  // The mirrored band then appears on the first reading that finds a prompt box, which is the
  // sidecar watching the pane rather than anything this page does.
  await page.waitForSelector(FIELD, { timeout: 60000 });
  check('the session mirrors into the panel', true);

  await page.fill(FIELD, message);
  // Past the 90ms push debounce, the round trip, and the pane's redraw, so the watcher has had
  // its say about what the box holds.
  await page.waitForTimeout(4000);

  const box = (await run('tmux', ['capture-pane', '-p', '-t', NAME])).stdout;
  const collapsed = /\[Pasted text #\d+/.test(box);
  check('Claude collapsed the push into a pasted-text handle', collapsed,
    collapsed ? 'the case this guards' : 'threshold moved: re-measure before trusting this run');

  const held = await page.inputValue(FIELD);
  check('the field still holds the reader\'s words', held === message,
    held.length > 80 ? `${held.length} chars` : JSON.stringify(held));

  // And the next keystroke pushes the WORDS rather than the handle, which is the half that
  // decides whether the message still exists after one more character.
  await page.fill(FIELD, `${message}!`);
  await page.waitForTimeout(4000);
  const after = await page.inputValue(FIELD);
  check('an edit after the collapse still carries the message', after === `${message}!`,
    after.length > 80 ? `${after.length} chars` : JSON.stringify(after));

  const box2 = (await run('tmux', ['capture-pane', '-p', '-t', NAME])).stdout;
  check('the pane holds a handle and not the literal token text', /\[Pasted text #\d+/.test(box2)
    && !/❯\s*\[Pasted text #\d+\]\s*\[Pasted text/.test(box2));
} finally {
  clearTimeout(watchdog);
  await teardown();
}

if (failures.length > 0) {
  console.error(`composer-paste-collapse-verify: ${failures.length} failed`);
  process.exit(1);
}
console.log('composer-paste-collapse-verify: OK');
