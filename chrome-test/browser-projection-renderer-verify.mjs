import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const indexURL = pathToFileURL(join(
  here,
  '..',
  'packages',
  'BrowserProjection',
  'Sources',
  'BrowserProjection',
  'Resources',
  'BrowserProjectionWebview',
  'index.html',
)).href;
const playwrightRoot = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
const playwright = await import(pathToFileURL(join(playwrightRoot, 'index.js')).href);
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) throw new Error('Playwright Chromium is unavailable');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
await page.addInitScript(() => {
  window.__projectionIntents = [];
  window.webkit = {
    messageHandlers: {
      domMirror: { postMessage: (message) => window.__projectionIntents.push(message) },
    },
  };
});

function tab(id, windowId, index, title, options = {}) {
  return {
    id, windowId, index, active: !!options.active, pinned: !!options.pinned,
    groupId: options.groupId ?? -1, status: options.status || 'complete',
    title, url: options.url || `https://fixture.test/${id}`, favIconDataURL: null,
    audible: !!options.audible, muted: !!options.muted,
    discarded: !!options.discarded, restricted: !!options.restricted,
  };
}

const windows = [
  {
    id: 1, ordinal: 1, focused: true, state: 'normal', activeTabId: 11,
    tabs: [
      tab(10, 1, 0, 'Pinned', { pinned: true }),
      tab(11, 1, 1, '<img id="metadata-injection">', { active: true, groupId: 7 }),
    ],
    groups: [{ id: 7, title: '<b>Work</b>', color: 'blue', collapsed: true }],
  },
  {
    id: 2, ordinal: 2, focused: false, state: 'normal', activeTabId: 21,
    tabs: [
      tab(21, 2, 0, 'Window Two', { active: true }),
      tab(22, 2, 1, 'Restricted', { restricted: true, url: 'chrome://version' }),
    ],
    groups: [],
  },
];

function state(generation, projectedWindowId, windowList = windows) {
  return {
    t: 'browser-state', generation, projectedWindowId, focusedWindowId: windowList.length ? 1 : null,
    extension: { version: '0.7.0', commits: 742, sha: 'abc1234', dirty: false },
    windows: windowList,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await page.goto(indexURL);
  await page.waitForFunction(() => typeof window.__browserProjectionDeliver === 'function');
  assert(await page.locator('body').getAttribute('class') === 'page-only', 'shared renderer starts in iOS-compatible page-only mode');
  await page.evaluate(() => window.__browserProjectionDeliver({
    t: 'projection-host', connected: true, sha: 'abc1234',
  }));
  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(1, 1));

  assert(await page.locator('[role="tablist"]').count() === 2, 'renderer exposes two ARIA tablists');
  assert(await page.locator('#browser-projection-host-build[role="status"]').count() === 1, 'host build identity remains an addressable AX status');
  assert(await page.locator('#browser-projection-extension-build[role="status"]').count() === 1, 'extension build identity remains an addressable AX status');
  assert(await page.locator('#browser-projection-address[aria-readonly="true"]').count() === 1, 'address remains an addressable read-only AX field');
  assert(await page.locator('#browser-projection-window-strip [role="tab"]').count() === 2, 'outer strip renders every normal window');
  assert(await page.locator('#browser-projection-tab-strip [role="tab"]').count() === 2, 'inner strip renders every projected-window tab even when its group is collapsed');
  assert(await page.locator('#browser-projection-window-tab-1').getAttribute('aria-selected') === 'true', 'projected outer window is selected');
  assert((await page.locator('#browser-projection-window-tab-1').getAttribute('class')).includes('is-focused'), 'focused Chrome window is marked independently');
  assert(await page.locator('#metadata-injection').count() === 0, 'tab title is rendered as text');
  assert((await page.locator('#browser-projection-active-title').textContent()).includes('<img'), 'tab title text is preserved');
  assert((await page.locator('.group-chip').textContent()).includes('<b>Work</b>'), 'group label is rendered as text');
  await page.evaluate(() => {
    const bytes = fflate.zlibSync(fflate.strToU8('<html><body data-agentdesk-fixture="renderer-active"></body></html>'));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    window.__browserProjectionDeliver({
      t: 'dom-batch', tb: 11, g: 1, co: true, k: 'cdp',
      enc: 'deflate-b64', ev: btoa(binary), w: 800, h: 600,
    });
  });
  assert((await page.locator('body').getAttribute('class')).includes('page-active'), 'matching reconstructed page enables its input overlay');
  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(1, 1));
  assert(await page.locator('#browser-projection-content-status').isHidden(), 'same-target metadata refresh preserves the reconstructed page');

  await page.locator('#browser-projection-window-tab-2').click();
  let intents = await page.evaluate(() => window.__projectionIntents);
  assert(intents.at(-1).kind === 'select-window' && intents.at(-1).windowId === 2, 'outer AX target emits only window selection');

  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(2, 2));
  assert(await page.locator('#browser-projection-tab-2-21').count() === 1, 'Window 2 tabs replace Window 1 tabs');
  assert(await page.locator('#browser-projection-tab-1-11').count() === 0, 'prior inner tabs are removed');
  await page.locator('#browser-projection-tab-2-22').click();
  intents = await page.evaluate(() => window.__projectionIntents);
  assert(intents.at(-1).kind === 'select-tab' && intents.at(-1).windowId === 2 && intents.at(-1).tabId === 22, 'inner AX target emits a scoped tab selection');

  const restrictedWindows = structuredClone(windows);
  restrictedWindows[1].activeTabId = 22;
  restrictedWindows[1].tabs[0].active = false;
  restrictedWindows[1].tabs[1].active = true;
  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(3, 2, restrictedWindows));
  assert((await page.locator('#browser-projection-content-status').textContent()).includes('cannot be projected'), 'restricted tab replaces prior page with a placeholder');
  assert((await page.locator('#browser-projection-page-marker').textContent()) === '', 'restricted state clears the prior page marker');
  assert(!(await page.locator('body').getAttribute('class')).includes('page-active'), 'restricted state disables the page input overlay');

  const loadingWindows = structuredClone(windows);
  loadingWindows[0].tabs[1].status = 'loading';
  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(4, 1, loadingWindows));
  assert((await page.locator('#browser-projection-content-status').textContent()).startsWith('Loading'), 'loading target renders explicitly');

  const discardedWindows = structuredClone(windows);
  discardedWindows[0].tabs[1].discarded = true;
  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(5, 1, discardedWindows));
  assert((await page.locator('#browser-projection-content-status').textContent()).includes('discarded'), 'discarded target renders explicitly');

  await page.evaluate((snapshot) => window.__browserProjectionDeliver(snapshot), state(6, null, []));
  assert((await page.locator('#browser-projection-content-status').textContent()).includes('No normal Chrome windows'), 'empty browser state renders explicitly');
  assert(await page.locator('#browser-projection-window-strip [role="tab"]').count() === 0, 'empty state removes outer tabs');

  console.log('browser-projection-renderer-verify: all checks passed');
} finally {
  await browser.close();
}
