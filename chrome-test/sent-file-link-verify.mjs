// Can a reader OPEN a file a session handed them?
//
// `SendUserFile` hands over a page, a report, a log. Until this, the feed printed its name and
// that was all there was: an absolute path in a scratchpad, which is not something a browser can
// reach and not something the reader can act on. A picture at least had a thumbnail; everything
// else was the index of a thing instead of the thing.
//
// So the assertions here are the ones no unit test can make. That the panel's row carries a real
// address; that the address answers through the dev origin's proxy with the file's own bytes; and
// that the page lands in an OPAQUE origin, which is the part that matters most -- the panel's
// origin has no authentication in front of it, so a page served as the panel would be handed the
// sidecar's whole API.
//
// Run against a live panel, which means `just host-run` is up: `just sent-file-link-verify`.
// Uses Playwright's Chrome for Testing with a throwaway profile, never the owner's Chrome, and
// stays off the Desktop surface so it cannot cycle an encoder under somebody's live stream.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ORIGIN = process.env.PANEL_ORIGIN;
if (!ORIGIN) throw new Error('set PANEL_ORIGIN to the panel dev origin');
const PROJECT = process.env.PANEL_PROJECT || process.cwd();

// The dev origin's certificate is issued for the tailnet name, so reaching it by loopback is a
// name mismatch every time. Test-only; what is checked is on the far side of the connection.
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

const PICTURE = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * The most recent handover of a file that is NOT a picture, and whose file is still on disk.
 *
 * Read from the transcripts rather than seeded, because there is nowhere to seed one: Claude's
 * own directory is read-only to us, and a session cannot be asked to hand a file over on demand.
 * So this probe takes the real history it finds, and says plainly when it finds none.
 */
function lastHandover() {
  const root = process.env.CLAUDE_PROJECTS
    || join(homedir(), '.claude', 'projects', PROJECT.replaceAll('/', '-'));
  const transcripts = readdirSync(root)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { name } of transcripts) {
    const lines = readFileSync(join(root, name), 'utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index] || !lines[index].includes('"SendUserFile"')) continue;
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      const content = record?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'tool_use' || block?.name !== 'SendUserFile') continue;
        const files = Array.isArray(block?.input?.files) ? block.input.files : [];
        const path = files.find((file) => typeof file === 'string' && !PICTURE.test(file));
        if (!path) continue;
        try { if (!statSync(path).isFile()) continue; } catch { continue; }
        return { sessionId: name.replace(/\.jsonl$/, ''), path, name: path.split('/').pop() };
      }
    }
  }
  return null;
}

const handover = lastHandover();
if (!handover) {
  console.error('no session in this project has handed over a non-picture file that still exists');
  process.exit(1);
}
console.log(`     handing over ${handover.name} from ${handover.sessionId.slice(0, 8)}`);

const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 950 } });
await context.addInitScript((selection) => {
  localStorage.setItem('agent-panel.selection', JSON.stringify(selection));
}, { projectPath: PROJECT, source: 'claude', sessionId: handover.sessionId });
const page = await context.newPage();

const teardown = async () => {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
};
const watchdog = setTimeout(() => {
  console.error('FAIL timed out');
  void teardown().then(() => process.exit(1));
}, 180_000);

try {
  await page.goto(`${ORIGIN}/?entry=feed`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('div.h-full.overflow-y-auto', { timeout: 60_000 });
  // The feed opens at the tail, which is where a recent handover is, and settles its heights.
  await page.waitForTimeout(6000);

  // A tool call is folded until a reader opens it, so the file list is not drawn yet. The header
  // carries the call's own summary, which names the file.
  const header = page.locator('button[aria-expanded]', { hasText: handover.name }).last();
  check('the call that handed the file over is in the feed', await header.count() > 0, handover.name);
  if (await header.count() === 0) throw new Error('no SendUserFile row on screen');
  await header.scrollIntoViewIfNeeded();
  await header.click();
  await page.waitForTimeout(800);

  const link = page.getByRole('link', { name: handover.name }).last();
  check('the file name is a link and not just a name', await link.count() > 0);
  if (await link.count() === 0) throw new Error('the row printed the name with no address');

  const href = await link.getAttribute('href');
  check('it opens in a tab of its own', await link.getAttribute('target') === '_blank');
  check(
    'and hands the opened page nothing it could act as this panel with',
    await link.getAttribute('rel') === 'noreferrer',
  );
  // No path in the address: the panel asks by the file's POSITION in the call the transcript
  // already made, so it cannot ask for anything the session did not say it was sending.
  check(
    'the address names a position in the transcript, not a path on the disk',
    /\/events\/\d+\/blocks\/\d+\/files\/\d+/.test(href ?? '') && !(href ?? '').includes('/tmp/'),
    href,
  );

  const opened = await context.newPage();
  const response = await opened.goto(new URL(href, ORIGIN).href, { waitUntil: 'domcontentloaded' });
  check('the address answers with the file', response?.status() === 200, `${response?.status()}`);
  const headers = response?.headers() ?? {};
  check(
    'as what it is, and not sniffed into something else',
    headers['content-type']?.startsWith('text/html') && headers['x-content-type-options'] === 'nosniff',
    headers['content-type'],
  );
  // The whole reason a page may be served at all. `allow-same-origin` is deliberately absent, so
  // the document is nobody: it cannot read this panel's storage or call `/api` as the reader.
  check(
    'and into an origin of its own, where it cannot act as the panel',
    await opened.evaluate(() => window.origin) === 'null',
    headers['content-security-policy'],
  );
  const drawn = await opened.evaluate(() => document.body?.innerText?.trim().length ?? 0);
  check('the page the reader was sent actually renders', drawn > 0, `${drawn} characters of text`);
  await opened.screenshot({ path: '/tmp/sent-file-link-opened.png' });
} finally {
  clearTimeout(watchdog);
  await teardown();
}

if (failures.length > 0) {
  console.error('sent-file-link-verify FAILED');
  for (const failure of failures) console.error('  ' + failure);
  process.exit(1);
}
console.log('sent-file-link-verify OK');
