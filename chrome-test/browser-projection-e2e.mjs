import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionId } from './ext-id.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const extensionDirectory = join(repo, 'chrome-extension');
const installer = join(repo, 'dom-bridge', 'install.mjs');
const axDriver = join(repo, 'tools', 'agent-window-ax.swift');
const bundleID = 'com.example.agentdesk.AgentDeskHost.dev';
const supportDirectory = process.env.AGENTDESK_E2E_HOST_SUPPORT;
const hostDerivedData = process.env.AGENTDESK_E2E_HOST_DERIVED_DATA;
if (!supportDirectory || !hostDerivedData) {
  throw new Error('AGENTDESK_E2E_HOST_SUPPORT and AGENTDESK_E2E_HOST_DERIVED_DATA are required');
}

const socketPath = join(supportDirectory, 'ad-dom-bridge.sock');
const tokenPath = join(supportDirectory, 'ad-dom-bridge-token');
const expectedSHA = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = join('/tmp', `agentdesk-browser-projection-e2e-${timestamp}`);
const work = mkdtempSync(join(tmpdir(), 'agentdesk-browser-projection-work-'));
const userDataDirectory = join(work, 'chrome-profile');
const wrapperPath = join(work, 'dom-bridge');
const nativeManifestDirectory = join(userDataDirectory, 'NativeMessagingHosts');
mkdirSync(artifacts, { recursive: true });
mkdirSync(userDataDirectory, { recursive: true });

const playwrightRoot = process.env.AGENTDESK_PLAYWRIGHT_ROOT
  || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), 'playwright');
const playwright = await import(pathToFileURL(join(playwrightRoot, 'index.js')).href);
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) throw new Error('Playwright Chromium is unavailable');

const browserLog = [];
const result = {
  status: 'running',
  expectedSHA,
  hostSHA: null,
  extensionSHA: null,
  windows: {},
  transitions: [],
  staleBatchAssertions: [],
  screenshots: [],
  cleanup: null,
};
let context = null;
let fixtureServer = null;
let baselineDevProcessIDs = new Set();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: options.timeout || 30_000,
    env: { ...process.env, ...(options.env || {}) },
  });
}

function runAX(args, timeout = 20_000) {
  return run('/usr/bin/swift', [axDriver, ...args], { timeout });
}

async function waitUntil(label, operation, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitForFile(path, timeout = 30_000) {
  return waitUntil(`file ${path}`, () => existsSync(path), timeout);
}

function readDOM(identifier) {
  return runAX([
    'read', '--bundle-id', bundleID,
    '--window-identifier', 'browser-projection-window',
    '--dom-identifier', identifier,
  ]);
}

function hasDOM(identifier) {
  try {
    readDOM(identifier);
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForDOMText(identifier, text, timeout = 25_000) {
  return waitUntil(`${identifier} containing ${text}`, () => {
    const output = readDOM(identifier);
    return output.includes(text) ? output : null;
  }, timeout);
}

function pressDOM(identifier) {
  runAX([
    'press', '--bundle-id', bundleID,
    '--window-identifier', 'browser-projection-window',
    '--dom-identifier', identifier,
  ]);
}

function screenshot(name) {
  const path = join(artifacts, name);
  runAX([
    'screenshot', '--bundle-id', bundleID,
    '--window-identifier', 'browser-projection-window',
    '--output', path,
  ], 30_000);
  if (!existsSync(path)) throw new Error(`screenshot was not created: ${path}`);
  result.screenshots.push(path);
}

function fixtureHTML(marker, title, color) {
  return `<!doctype html>
  <html><head><meta charset="utf-8"><title>${title}</title>
  <style>html,body{margin:0;min-height:100%;font:18px system-ui;background:${color};color:#17202a}
  main{padding:48px}button{font:inherit;padding:10px 16px}</style></head>
  <body><main data-agentdesk-fixture="${marker}"><h1>${title}</h1>
  <p>Deterministic AgentDesk browser projection fixture.</p>
  <button id="fixture-button">Fixture action</button><div style="height:1400px"></div></main></body></html>`;
}

async function startFixtures() {
  const pages = new Map([
    ['/w1-a', fixtureHTML('window-1-a', 'Window One Pinned', '#e7f0ff')],
    ['/w1-b', fixtureHTML('window-1-b', 'Window One Blue', '#dcefff')],
    ['/w1-c', fixtureHTML('window-1-c', 'Window One Green', '#dcf7e7')],
    ['/w2-a', fixtureHTML('window-2-a', 'Window Two Amber', '#fff0cf')],
    ['/w2-b', fixtureHTML('window-2-b', 'Window Two Rose', '#ffe2e7')],
  ]);
  fixtureServer = http.createServer((request, response) => {
    const body = pages.get((request.url || '').split('?')[0]);
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  return fixtureServer.address().port;
}

async function serviceWorker() {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
  if (!worker) throw new Error('extension service worker did not start');
  worker.on('console', (message) => browserLog.push(`[service-worker] ${message.type()}: ${message.text()}`));
  return worker;
}

async function createBrowserFixture(worker, fixturePort) {
  const origin = `http://127.0.0.1:${fixturePort}`;
  const page = context.pages()[0] || await context.newPage();
  page.on('console', (message) => browserLog.push(`[fixture] ${message.type()}: ${message.text()}`));
  await page.goto(`${origin}/w1-a`, { waitUntil: 'load' });

  return worker.evaluate(async (baseURL) => {
    const [windowOne] = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const pinned = windowOne.tabs.find((tab) => tab.active);
    await chrome.tabs.update(pinned.id, { pinned: true });
    const oneB = await chrome.tabs.create({ windowId: windowOne.id, url: `${baseURL}/w1-b`, active: true });
    const oneC = await chrome.tabs.create({ windowId: windowOne.id, url: `${baseURL}/w1-c`, active: false });
    const groupId = await chrome.tabs.group({ tabIds: [oneB.id, oneC.id], createProperties: { windowId: windowOne.id } });
    await chrome.tabGroups.update(groupId, { title: 'Work', color: 'blue', collapsed: false });

    const windowTwo = await chrome.windows.create({ url: `${baseURL}/w2-a`, focused: false });
    const twoA = windowTwo.tabs[0];
    const twoB = await chrome.tabs.create({ windowId: windowTwo.id, url: `${baseURL}/w2-b`, active: true });
    const restricted = await chrome.tabs.create({ windowId: windowTwo.id, url: 'chrome://version', active: false });
    await chrome.windows.update(windowOne.id, { focused: true });
    await chrome.tabs.update(oneB.id, { active: true });

    return {
      windowOne: { id: windowOne.id, pinned: pinned.id, active: oneB.id, other: oneC.id },
      windowTwo: { id: windowTwo.id, first: twoA.id, active: twoB.id, restricted: restricted.id },
    };
  }, origin);
}

async function activeTabID(worker, windowId) {
  return worker.evaluate(async (id) => {
    const tabs = await chrome.tabs.query({ windowId: id, active: true });
    return tabs[0] && tabs[0].id;
  }, windowId);
}

async function focusedWindowID(worker) {
  return worker.evaluate(async () => {
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const focused = windows.find((window) => window.focused);
    return focused ? focused.id : null;
  });
}

async function projectionState(worker) {
  return worker.evaluate(() => browserStatePayload());
}

function assertGenerationAdvanced(previous, next, transition) {
  if (!(next.generation > previous.generation)) {
    throw new Error(`${transition} did not advance generation: ${previous.generation} -> ${next.generation}`);
  }
  result.transitions.push({
    kind: transition,
    fromGeneration: previous.generation,
    toGeneration: next.generation,
    focusedWindowId: next.focusedWindowId,
    projectedWindowId: next.projectedWindowId,
  });
}

async function assertStaleBatchRejected(worker, staleState, expectedMarker) {
  const staleWindow = staleState.windows.find((window) => window.id === staleState.projectedWindowId);
  if (!staleWindow || staleWindow.activeTabId == null) throw new Error('stale state has no active tab');
  const staleMarker = `stale-${staleState.generation}-${staleWindow.activeTabId}`;
  await worker.evaluate(({ tabId, generation, marker }) => {
    const html = `<html><body data-agentdesk-fixture="${marker}"></body></html>`;
    const payload = bytesToBase64(fflate.zlibSync(fflate.strToU8(html)));
    const nativePort = ensurePort();
    if (!nativePort) throw new Error('native bridge is unavailable for stale-batch injection');
    nativePort.postMessage({
      t: 'dom-batch', tb: tabId, g: generation, co: true,
      k: 'cdp', enc: 'deflate-b64', ev: payload, w: 800, h: 600,
    });
  }, { tabId: staleWindow.activeTabId, generation: staleState.generation, marker: staleMarker });
  await sleep(1_000);
  const marker = readDOM('browser-projection-page-marker');
  if (marker.includes(staleMarker) || !marker.includes(expectedMarker)) {
    throw new Error(`stale batch leaked into projection: ${marker}`);
  }
  result.staleBatchAssertions.push({
    generation: staleState.generation,
    tabId: staleWindow.activeTabId,
    rejectedMarker: staleMarker,
    retainedMarker: expectedMarker,
  });
}

function startHost() {
  const launch = spawnSync('just', ['host-run-dev', 'dev', 'false'], {
    cwd: repo,
    stdio: 'inherit',
    timeout: 180_000,
    env: { ...process.env, AGENTDESK_AX_AUTOMATION_ENABLED: '1' },
  });
  if (launch.status !== 0) throw new Error(`host-run-dev failed with status ${launch.status}`);
}

function devProcessRows() {
  const processes = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout || '';
  return processes.split('\n').flatMap((line) => {
    if (!line.includes(hostDerivedData) && !line.includes(supportDirectory)) return [];
    if (!line.includes('AgentDeskHost.app/Contents/MacOS/AgentDeskHost')
        && !line.includes('/pty-manager ')
        && !line.endsWith('/atc-sidecar')) return [];
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    return Number.isInteger(pid) && pid > 1 ? [{ pid, command: line.trim() }] : [];
  });
}

function stopHost() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ownedPIDs = devProcessRows()
      .map((process) => process.pid)
      .filter((pid) => !baselineDevProcessIDs.has(pid));
    if (ownedPIDs.length === 0) return;
    for (const pid of ownedPIDs) {
      try { process.kill(pid, 'SIGTERM'); } catch (error) {}
    }
    spawnSync('/bin/sleep', ['0.1']);
  }
  for (const { pid } of devProcessRows()) {
    if (baselineDevProcessIDs.has(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch (error) {}
  }
}

function collectHostLog() {
  const capture = spawnSync('/usr/bin/log', [
    'show', '--last', '10m', '--style', 'compact',
    '--predicate', 'subsystem == "com.example.agentdesk.AgentDeskHost.dev" OR subsystem == "com.example.agentdesk.AgentDeskHost"',
  ], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(join(artifacts, 'host.log'), capture.stdout || capture.stderr || 'no host log output');
}

async function cleanup() {
  try { if (context) await context.close(); } catch (error) {}
  try { if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve)); } catch (error) {}
  spawnSync('node', [installer, '--remove', '--nmdir', nativeManifestDirectory, '--wrapper', wrapperPath], {
    cwd: repo,
    encoding: 'utf8',
  });
  stopHost();
  collectHostLog();
  writeFileSync(join(artifacts, 'chrome.log'), browserLog.join('\n') || 'no browser console output');
  rmSync(work, { recursive: true, force: true });
  const processes = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout || '';
  const newDevProcesses = devProcessRows().filter((process) => !baselineDevProcessIDs.has(process.pid));
  result.cleanup = !processes.includes(userDataDirectory) && newDevProcesses.length === 0;
}

async function main() {
  runAX(['preflight']);
  baselineDevProcessIDs = new Set(devProcessRows().map((process) => process.pid));
  startHost();
  await waitForFile(socketPath);
  await waitForFile(tokenPath);

  const install = spawnSync('node', [
    installer, '--ext-id', extensionId(), '--nmdir', nativeManifestDirectory,
    '--socket', socketPath, '--token', tokenPath, '--wrapper', wrapperPath,
  ], { cwd: repo, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`native bridge install failed: ${install.stderr || install.stdout}`);

  const fixturePort = await startFixtures();
  context = await chromium.launchPersistentContext(userDataDirectory, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionDirectory}`,
      `--load-extension=${extensionDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  const worker = await serviceWorker();
  const fixture = await createBrowserFixture(worker, fixturePort);
  result.windows = fixture;
  await worker.evaluate(() => startBrowserProjection());

  runAX(['wait', '--bundle-id', bundleID, '--identifier', 'workspace-shell-browser', '--timeout', '20']);
  runAX(['press', '--bundle-id', bundleID, '--identifier', 'workspace-shell-browser']);
  runAX([
    'wait', '--bundle-id', bundleID, '--window-identifier', 'browser-projection-window',
    '--dom-identifier', `browser-projection-window-tab-${fixture.windowOne.id}`, '--timeout', '25',
  ]);
  runAX([
    'wait', '--bundle-id', bundleID, '--window-identifier', 'browser-projection-window',
    '--dom-identifier', `browser-projection-window-tab-${fixture.windowTwo.id}`, '--timeout', '25',
  ]);

  const hostBuild = await waitForDOMText('browser-projection-host-build', expectedSHA);
  const extensionBuild = await waitForDOMText('browser-projection-extension-build', expectedSHA);
  result.hostSHA = expectedSHA;
  result.extensionSHA = expectedSHA;
  if (!hostBuild.includes(expectedSHA) || !extensionBuild.includes(expectedSHA)) {
    throw new Error('running build identity does not match checkout');
  }
  await waitForDOMText('browser-projection-page-marker', 'window-1-b');
  let priorState = await projectionState(worker);
  if (priorState.windows.length !== 2) throw new Error(`expected 2 normal windows, got ${priorState.windows.length}`);
  const initialWindow = priorState.windows.find((window) => window.id === fixture.windowOne.id);
  if (!initialWindow || initialWindow.tabs.length !== 3 || !initialWindow.tabs.some((tab) => tab.pinned)) {
    throw new Error('Window 1 metadata is missing its complete pinned/projectable tab set');
  }
  if (!initialWindow.groups.some((group) => group.title === 'Work')) {
    throw new Error('Window 1 named tab group is missing');
  }
  screenshot('01-two-windows.png');

  pressDOM(`browser-projection-window-tab-${fixture.windowTwo.id}`);
  await waitForDOMText('browser-projection-projected-window', String(fixture.windowTwo.id));
  await waitForDOMText('browser-projection-focused-window', String(fixture.windowOne.id));
  await waitForDOMText('browser-projection-page-marker', 'window-2-b');
  if (hasDOM(`browser-projection-tab-${fixture.windowOne.id}-${fixture.windowOne.active}`)) {
    throw new Error('Window 1 inner tabs remained in the Window 2 projection');
  }
  if ((await focusedWindowID(worker)) === fixture.windowTwo.id) {
    throw new Error('projection-only window selection focused the projected Chrome window');
  }
  let currentState = await projectionState(worker);
  if (currentState.focusedWindowId !== fixture.windowOne.id) {
    throw new Error('projection-only window selection replaced Chrome last-known focus');
  }
  assertGenerationAdvanced(priorState, currentState, 'projection-only-window');
  await assertStaleBatchRejected(worker, priorState, 'window-2-b');
  priorState = currentState;
  screenshot('02-projection-only-window-switch.png');

  pressDOM(`browser-projection-tab-${fixture.windowTwo.id}-${fixture.windowTwo.first}`);
  await waitUntil('Window 2 inner tab activation', async () =>
    (await activeTabID(worker, fixture.windowTwo.id)) === fixture.windowTwo.first);
  await waitForDOMText('browser-projection-page-marker', 'window-2-a');
  if ((await focusedWindowID(worker)) === fixture.windowTwo.id) {
    throw new Error('inner-tab selection focused the projected Chrome window');
  }
  currentState = await projectionState(worker);
  if (currentState.focusedWindowId !== fixture.windowOne.id) {
    throw new Error('inner-tab selection replaced Chrome last-known focus');
  }
  assertGenerationAdvanced(priorState, currentState, 'agentdesk-tab');
  await assertStaleBatchRejected(worker, priorState, 'window-2-a');
  priorState = currentState;
  screenshot('03-inner-tab-switch.png');

  await worker.evaluate((windowId) => chrome.windows.update(windowId, { focused: true }), fixture.windowOne.id);
  await waitForDOMText('browser-projection-projected-window', String(fixture.windowOne.id));
  await waitForDOMText('browser-projection-page-marker', 'window-1-b');
  runAX(['press', '--bundle-id', bundleID, '--identifier', 'workspace-shell-browser']);
  currentState = await projectionState(worker);
  assertGenerationAdvanced(priorState, currentState, 'chrome-window-focus');
  await assertStaleBatchRejected(worker, priorState, 'window-1-b');
  priorState = currentState;
  screenshot('04-chrome-window-follow.png');

  await worker.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), fixture.windowOne.other);
  await waitForDOMText('browser-projection-page-marker', 'window-1-c');
  currentState = await projectionState(worker);
  assertGenerationAdvanced(priorState, currentState, 'chrome-tab');
  await assertStaleBatchRejected(worker, priorState, 'window-1-c');
  priorState = currentState;
  screenshot('05-chrome-tab-follow.png');

  pressDOM(`browser-projection-window-tab-${fixture.windowTwo.id}`);
  runAX([
    'wait', '--bundle-id', bundleID, '--window-identifier', 'browser-projection-window',
    '--dom-identifier', `browser-projection-tab-${fixture.windowTwo.id}-${fixture.windowTwo.restricted}`,
    '--timeout', '20',
  ]);
  await waitForDOMText('browser-projection-page-marker', 'window-2-a');
  currentState = await projectionState(worker);
  assertGenerationAdvanced(priorState, currentState, 'restricted-window-projection');
  await assertStaleBatchRejected(worker, priorState, 'window-2-a');
  priorState = currentState;
  pressDOM(`browser-projection-tab-${fixture.windowTwo.id}-${fixture.windowTwo.restricted}`);
  await waitForDOMText('browser-projection-content-status', 'cannot be projected');
  currentState = await projectionState(worker);
  assertGenerationAdvanced(priorState, currentState, 'restricted-tab');
  await assertStaleBatchRejected(worker, priorState, '');
  screenshot('06-restricted-tab.png');

  const finalState = await worker.evaluate(() => browserStatePayload());
  writeFileSync(join(artifacts, 'browser-state.json'), `${JSON.stringify(finalState, null, 2)}\n`);
  result.status = 'passed';
}

const watchdog = setTimeout(() => {
  browserLog.push('[harness] watchdog timeout');
  stopHost();
}, 240_000);
watchdog.unref();

let failure = null;
try {
  await main();
} catch (error) {
  failure = error;
  result.status = 'failed';
  result.error = error.stack || error.message;
  try {
    const tree = runAX([
      'dump', '--bundle-id', bundleID,
      '--window-identifier', 'browser-projection-window', '--depth', '12',
    ], 30_000);
    writeFileSync(join(artifacts, 'ax-tree.txt'), tree);
  } catch (dumpError) {
    browserLog.push(`[harness] AX tree capture failed: ${dumpError.message}`);
  }
} finally {
  clearTimeout(watchdog);
  await cleanup();
  writeFileSync(join(artifacts, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`browser-projection-e2e artifacts: ${artifacts}`);
}

if (failure) {
  console.error(`browser-projection-e2e: FAIL: ${failure.message}`);
  process.exit(1);
}
if (!result.cleanup) {
  console.error('browser-projection-e2e: FAIL: a Chrome process still references the temporary profile');
  process.exit(1);
}
console.log('browser-projection-e2e: PASS');
