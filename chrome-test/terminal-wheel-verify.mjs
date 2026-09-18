// Checks that a wheel over a FULLSCREEN pane reaches the program, and that one over an ordinary
// pane still does not.
//
// This exists because neither half can be settled anywhere else. The unit tests know the bytes are
// right; they cannot know that xterm entered the alternate buffer from the payload the sidecar
// composed, that a real wheel event over a real terminal produces one, or that the program on the
// far end does anything with it. And the dangerous direction is the one that looks like nothing:
// a report sent to a pane whose program never asked for mouse tracking is not refused, it arrives
// as typed text in somebody's shell.
//
// The target is a PEER, because that is where the case lives: a Claude Code running `"tui":
// "fullscreen"` draws on the alternate screen, tmux keeps no scrollback for it, and the import is
// therefore one page with the whole session's history reachable only through the program itself.
// The peer's panes are found rather than named -- the fullscreen one is whichever pane reports all
// three of `alternate_on`, `mouse_any_flag` and `mouse_sgr_flag`, which is the same condition the
// sidecar reports as `mouseReporting`.
//
// Run it against a live panel, which means `just host-run` is up: `just terminal-wheel-verify`.
// Playwright's Chrome for Testing with a throwaway profile, never the owner's Chrome. It opens the
// Terminals surface pointed at the peer and never at this machine, which matters: that surface
// claims its tiles' shape, and this Mac's own panes are not 80x24.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
/** The peer, by the name the panel knows it as AND the name ssh knows it as; they are the same. */
const MACHINE = process.env.WHEEL_MACHINE || 'oracle';

// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a name
// mismatch every time. Test-only, and the browser side says the same through `ignoreHTTPSErrors`.
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

const peer = (command) =>
  execFileSync('ssh', ['-o', 'BatchMode=yes', MACHINE, command], { encoding: 'utf8' });

/** Every pane on the peer, with the three flags that decide what its wheel means. */
function panes() {
  const format = '#{session_name}\t#{alternate_on}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{pane_width}x#{pane_height}';
  return peer(`tmux list-panes -a -F '${format}'`)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name, alternate, any, sgr, size] = line.split('\t');
      return { name, alternate: alternate === '1', mouse: any === '1' && sgr === '1', size };
    });
}

const before = panes();
const fullscreen = before.find((pane) => pane.alternate && pane.mouse);
const ordinary = before.find((pane) => !pane.alternate);
if (!fullscreen) {
  throw new Error(`${MACHINE} has no pane on the alternate screen with SGR mouse tracking on`);
}
if (!ordinary) throw new Error(`${MACHINE} has no ordinary pane to use as the control`);
console.log(`fullscreen pane: ${fullscreen.name} (${fullscreen.size})`);
console.log(`control pane:    ${ordinary.name} (${ordinary.size})`);

const screenOf = (session) => peer(`tmux capture-pane -p -t ${session}`);

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
// Seeded rather than clicked, so this surface never mounts a tile on THIS machine's panes. The
// Terminals surface claims its tiles' shape, and a tile opening at 80x24 on a pane that is not
// would reshape a live session inside whatever terminal its owner has it open in.
await context.addInitScript((machine) => {
  try {
    localStorage.setItem('agentdesk.panel.session', machine);
  } catch { /* a context with storage disabled lands on the default machine and fails loudly */ }
}, MACHINE);
const page = await context.newPage();

// The direct evidence, and the reason this does not settle for watching the screen change: what is
// under test is whether the panel SENT the wheel rather than scrolling its own buffer, and the
// request carries the exact bytes. Watching only the picture would also pass on a tile that
// happened to repaint because the session wrote something while the wheel was being dispatched.
const sent = [];
page.on('request', (request) => {
  if (!/\/terminals\/[0-9a-f-]+\/input$/.test(new URL(request.url()).pathname)) return;
  sent.push(request.postData() ?? '');
});
const sentSince = (mark) => sent.slice(mark);

const teardown = async () => {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
};
const watchdog = setTimeout(() => {
  console.error('FAIL timed out');
  void teardown().then(() => process.exit(1));
}, 120_000);

try {
  await page.goto(`${ORIGIN}/?entry=terminals`, { waitUntil: 'domcontentloaded' });

  const tile = (session) => page.locator(`section[aria-label="${session} terminal"]`);
  await tile(fullscreen.name).waitFor({ state: 'visible', timeout: 60_000 });
  await tile(ordinary.name).waitFor({ state: 'visible', timeout: 60_000 });

  /** What the tile is showing, as the reader sees it, rather than what tmux says it is showing. */
  const tileText = async (session) => (await tile(session).locator('.xterm-rows').innerText()).trim();

  // The import has to land before any of this means anything: a wheel over an empty terminal
  // scrolls nothing whatever the code does.
  await page.waitForFunction((label) => {
    const rows = document.querySelector(`section[aria-label="${label} terminal"] .xterm-rows`);
    return rows !== null && rows.textContent.trim().length > 200;
  }, `${fullscreen.name}`, { timeout: 60_000 });

  const wheel = async (session, deltaY, times) => {
    const box = await tile(session).locator('.xterm-screen').boundingBox();
    if (!box) throw new Error(`no box for ${session}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < times; index += 1) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(700);
  };

  const opening = await tileText(fullscreen.name);
  const mark = sent.length;
  await wheel(fullscreen.name, -400, 3);
  const reports = sentSince(mark);
  // `\u001b[<64;` is a wheel-up report in SGR form. Asserted on the wire rather than inferred from
  // the picture: the encoding is the half a program cannot complain about, since a report it
  // cannot read arrives as typed text rather than being refused.
  check(
    'a wheel over a fullscreen pane is sent to the program as an SGR wheel report',
    reports.length > 0 && reports.every((body) => body.includes('\\u001b[<64;')),
    `${reports.length} input requests, first: ${JSON.stringify(reports[0] ?? '').slice(0, 90)}`,
  );
  const scrolled = await tileText(fullscreen.name);
  check(
    'the program answers it by moving its own view, which is the history no capture can reach',
    scrolled !== opening && scrolled.length > 0,
    `${opening.length} -> ${scrolled.length} chars, changed: ${scrolled !== opening}`,
  );

  // Back to where the reader left it. More than went up, because a fullscreen renderer clamps at
  // the bottom and there is no way to ask it where it was.
  await wheel(fullscreen.name, 400, 6);
  const restored = await tileText(fullscreen.name);
  check('wheeling back down returns the program to its live view', restored !== scrolled, `changed: ${restored !== scrolled}`);

  // The control, and the direction that would be a bug rather than a missing feature. An ordinary
  // pane's program never asked for mouse reports, so a report sent to it would be typed into it.
  const controlBefore = screenOf(ordinary.name);
  const controlMark = sent.length;
  await wheel(ordinary.name, -400, 3);
  const controlAfter = screenOf(ordinary.name);
  check(
    'a wheel over an ordinary pane sends it nothing at all',
    sentSince(controlMark).length === 0 && controlBefore === controlAfter,
    `${sentSince(controlMark).length} input requests, ${ordinary.name} unchanged: ${controlBefore === controlAfter}`,
  );

  const after = panes();
  const reshaped = after.filter((pane) => {
    const was = before.find((one) => one.name === pane.name);
    return was && was.size !== pane.size;
  });
  check('opening the tiles reshaped no pane', reshaped.length === 0, reshaped.map((p) => p.name).join(', '));
} finally {
  clearTimeout(watchdog);
  await teardown();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nterminal-wheel-verify: OK');
