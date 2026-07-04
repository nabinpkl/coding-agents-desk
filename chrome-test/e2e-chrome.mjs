// dom-mirror-e2e Chrome side: assumes the real AgentDeskHost (DOM mirror enabled) and a paired sim
// client are already up. Installs the native-messaging manifest for Chrome for Testing pointing the
// shim at the REAL host socket (install without --socket/--token, so the shim uses its default
// Application Support paths, which the running host owns), then loads the extension and records the
// CSP-strict fixture. The rrweb batches flow: extension -> shim -> real host -> .dom QUIC lane ->
// sim client -> replay surface -> probe (which the sim console tee captures). This script just drives
// Chrome for a fixed window; the Justfile recipe greps the sim console for the probe.

import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionId } from './ext-id.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const EXT_DIR = join(REPO, 'chrome-extension');
const INSTALLER = join(REPO, 'dom-bridge', 'install.mjs');
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'page.html'), 'utf8');
const RECORD_SECONDS = Number(process.env.AGENTDESK_E2E_RECORD_SECONDS || 12);

const PW_ROOT = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g']).toString().trim(), 'playwright');
const pw = await import(pathToFileURL(join(PW_ROOT, 'index.js')).href);
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const extId = extensionId();
const work = mkdtempSync(join(tmpdir(), 'dom-e2e-chrome-'));
const userDataDir = join(work, 'chrome-profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fixtureServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(FIXTURE);
});

let ctx = null;
async function main() {
  await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
  const port = fixtureServer.address().port;

  // Install the NM manifest into the throwaway CfT profile, pointing the shim at the REAL host
  // socket (no --socket/--token: the shim's default Application Support paths are the host's).
  mkdirSync(userDataDir, { recursive: true });
  const nmDir = join(userDataDir, 'NativeMessagingHosts');
  const install = spawnSync('node', [INSTALLER, '--ext-id', extId, '--nmdir', nmDir], { encoding: 'utf8' });
  if (install.status !== 0) { console.error(install.stdout, install.stderr); throw new Error('install failed'); }
  console.log(`e2e-chrome: installed NM manifest (ext ${extId}) -> real host socket`);

  ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--no-default-browser-check'],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/page.html`, { waitUntil: 'load' });

  // Start recording from the CHROME layer (ADR-0042): drive the service worker directly, no URL param.
  let sw = ctx.serviceWorkers()[0];
  if (!sw) { try { sw = await ctx.waitForEvent('serviceworker', { timeout: 5000 }); } catch {} }
  if (!sw) throw new Error('service worker not found; cannot start recording');
  await sw.evaluate(async () => {
    const [t] = await chrome.tabs.query({ active: true });
    await startTabRecording(t.id);
  });

  console.log(`e2e-chrome: recording fixture for ${RECORD_SECONDS}s...`);
  await sleep(RECORD_SECONDS * 1000);
  console.log('e2e-chrome: done recording');
}

async function teardown() {
  try { if (ctx) await ctx.close(); } catch {}
  try { fixtureServer.close(); } catch {}
  spawnSync('node', [INSTALLER, '--remove', '--nmdir', join(userDataDir, 'NativeMessagingHosts')], { encoding: 'utf8' });
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}

const watchdog = setTimeout(() => { console.error('e2e-chrome: TIMEOUT'); teardown().finally(() => process.exit(2)); }, (RECORD_SECONDS + 30) * 1000);
watchdog.unref();

main().then(async () => { await teardown(); clearTimeout(watchdog); process.exit(0); })
  .catch(async (e) => { console.error('e2e-chrome: ERROR', e); await teardown(); process.exit(3); });
