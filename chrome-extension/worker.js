// M3 — MV3 background service worker (ADR-0038/0039/0040/0042).
//
// Owns the chrome-layer recording controls (toolbar action + Alt+Shift+M command), holds the single
// native-messaging port to the dom-bridge shim (which also keeps this worker alive), fans batches
// from the isolated-world recorder into the one native port, and (ADR-0040) dispatches host-
// originated taps back into the recorded tab as TRUSTED input via chrome.debugger.
//
// ADR-0042: recording runs in the page's isolated content-script world, started/stopped by messaging
// the content script from here -- the worker never injects into the page MAIN world. The page cannot
// observe recording via its own JS or URL.
//
// ADR-0043: each batch's rrweb events are deflate-compressed (zlib) and base64-encoded HERE, off the
// recorded page's main thread, then shipped opaquely through the whole chain (shim, host, .dom lane,
// Swift client) and inflated only in the replay webview. This is the fix for heavy pages: a raw
// FullSnapshot can exceed the host's 2 MB line cap, but compressed it is tens of KB. A still-
// oversized compressed batch (>~15 MB raw) is chunked into cid/seq/total parts, each a normal line.
importScripts(
  'vendor/fflate.min.js',
  'cdp-reconstruct.js',
  'browser-session.js',
  'browser-metadata.js',
  'source-viewport.js'
);

const NATIVE_HOST = 'agentdesk.dom_bridge';

// A compressed+base64 batch line larger than this is split into chunk parts, each well under the
// host's 2 MB newline-frame cap. ~15 MB of raw events is needed to reach this after deflate.
const CHUNK_LIMIT = 1_500_000; // base64 chars per part
let nextChunkId = 0;
let browserSession = AgentDeskBrowserSession.createSession();

// btoa over a large String.fromCharCode(...bytes) overflows the call stack, so encode in 32 KB
// windows. Input is fflate.zlibSync output (a Uint8Array of raw deflate/zlib bytes).
function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

// Compress a string payload and post it as one or more dom-batch lines (chunked past CHUNK_LIMIT,
// same backstop as the ADR-0043 events path), merging `extra` fields onto each line. Used by the
// ADR-0044 Tier B CDP path so its large HTML snapshot rides the identical compressed/opaque pipeline.
function postCompressed(p, extra, str) {
  let b64;
  try {
    b64 = bytesToBase64(fflate.zlibSync(fflate.strToU8(str)));
  } catch (e) {
    console.error('[agentdesk] compress failed', e && e.message);
    return;
  }
  if (b64.length <= CHUNK_LIMIT) {
    p.postMessage({ ...extra, enc: 'deflate-b64', ev: b64 });
    return;
  }
  const cid = nextChunkId++;
  const total = Math.ceil(b64.length / CHUNK_LIMIT);
  for (let seq = 0; seq < total; seq++) {
    p.postMessage({
      ...extra,
      co: seq === 0 ? extra.co : false, // co on part 0 only, like the events path
      enc: 'deflate-b64',
      ev: b64.slice(seq * CHUNK_LIMIT, (seq + 1) * CHUNK_LIMIT),
      cid,
      seq,
      total,
    });
  }
}

let port = null;
// The tab chrome.debugger is currently attached to (one debuggee per tab; shows the debug banner).
let attachedTabId = null;
// The host's last-activated active viewer owns this desired source viewport. Recording and device
// overrides are active atomically with it; no active viewer restores native Chrome.
let sourceViewport = {
  active: false,
  hostEpoch: null,
  revision: 0,
  profile: null,
  sizing: null,
  requestedWidth: null,
  requestedHeight: null,
  actualWidth: null,
  actualHeight: null,
  error: null,
};
const retiredHostEpochs = new Set();
// The tab's pristine UA, captured on the first emulate so desktop can restore it (CDP has no UA-clear).
let originalUserAgent = null;
// iPhone 12/13/14-class UA. Emulation is resnapshot-based (no reload), so this mainly drives live UA
// client hints; the device-metrics + touch overrides are what re-trigger the page's responsive layout.
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.error('[agentdesk] connectNative threw', e);
    port = null;
    return null;
  }
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    // ADR-0040: host -> extension input command. Dispatch it as trusted input.
    if (msg.t === 'dom-input') { dispatchInput(msg); return; }
    // ADR-0047: host -> extension scroll command. Drive the REAL tab to scroll (so lazy/infinite
    // pages load), because the mirror is always the live page.
    if (msg.t === 'dom-scroll') { dispatchScroll(msg); return; }
    if (msg.t === 'browser-source-viewport') {
      enqueueSessionMutation(() => applySourceViewportCommand(msg));
      return;
    }
    if (msg.t === 'browser-state-request') { enqueueSessionMutation(requestBrowserState); return; }
    if (msg.t === 'browser-select-window') { enqueueSessionMutation(() => selectProjectedWindow(msg)); return; }
    if (msg.t === 'browser-select-tab') { enqueueSessionMutation(() => selectProjectedTab(msg)); return; }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[agentdesk] native port disconnected', err && err.message);
    port = null; // reconnect lazily on the next batch
    enqueueSessionMutation(clearSourceViewportAfterDisconnect);
  });
  if (browserSession.enabled) setTimeout(() => enqueueSessionMutation(() => refreshBrowserProjection()), 0);
  return port;
}

// Keep attachedTabId honest if the tab (or user) detaches the debugger.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    enqueueSessionMutation(() => handleUnexpectedDebuggerDetach(source.tabId));
  }
});

async function handleUnexpectedDebuggerDetach(tabId) {
  sourceViewport = { ...sourceViewport, actualWidth: null, actualHeight: null, error: 'debugger-detached' };
  if (browserSession.recordedTabId === tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'agentdesk-stop' }); } catch (error) {}
    browserSession = AgentDeskBrowserSession.withRecordedTab(browserSession, null);
    await setBadge(tabId, false);
  }
  stopCdp(false); cdpMode = false; cdpUserSet = false;
  browserSession = AgentDeskBrowserSession.advanceGeneration(
    browserSession,
    AgentDeskBrowserSession.selectedTarget(browserSession)
  );
  await persistBrowserSession();
  await emitBrowserState();
}

async function ensureAttached(tabId) {
  if (attachedTabId === tabId) return true;
  if (attachedTabId != null) {
    const priorTabId = attachedTabId;
    attachedTabId = null;
    try { await chrome.debugger.detach({ tabId: priorTabId }); } catch (e) {}
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabId = tabId;
    return true;
  } catch (e) {
    console.error('[agentdesk] debugger attach failed', e && e.message);
    return false;
  }
}

// ADR-0040: dispatch a trusted click at the given page CSS-pixel coordinates. isTrusted input that
// every site honors, unlike synthetic events. The debug banner is the visible cost.
async function dispatchInput(cmd) {
  const tabId = browserSession.recordedTabId;
  if (tabId == null) return;
  if (!(await ensureAttached(tabId))) return;
  // ADR-0044 Tier B is OPT-IN ONLY (popup "High fidelity"). We do NOT auto-upgrade on tap: the CDP
  // flatten is lower fidelity than the rrweb replay for normal pages (no pseudo-elements, limited
  // computed-style set, broken relative asset URLs), so a tap must never silently degrade the render.
  const target = { tabId };
  // Defense-in-depth (ADR-0040): clamp to finite, non-negative coordinates before dispatch, so a
  // compromised/buggy client cannot probe negative or non-finite points. CDP already ignores points
  // outside the viewport; the blast radius is bounded to the recorded projection tab regardless.
  const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const base = { x: clamp(cmd.x), y: clamp(cmd.y), button: 'left', clickCount: 1 };
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base });
  } catch (e) {
    console.error('[agentdesk] dispatch failed', e && e.message);
  }
}

// ADR-0047: scroll-drive-back. Drive the recorded tab to scroll via a trusted CDP mouse-wheel event,
// reusing the ADR-0040 debugger attachment (same banner cost taps already pay). x/y are the page
// CSS-pixel anchor (the wheel hit-tests the scrollable element under it); cmd.dx/dy are the phone's
// FINGER movement in page px (positive dy = finger moved down).
//
// We use Input.dispatchMouseEvent{type:'mouseWheel'}, NOT Input.synthesizeScrollGesture. The gesture
// call ANIMATES a physical swipe (with inertia) and its promise only resolves after the animation
// plays out (~0.75s); the client emits one scroll frame per animation frame (~60-120Hz), so at that
// rate the animated gestures serialize into a multi-second backlog -- the page crawls and keeps
// scrolling after the finger stops, and tiny per-frame deltas barely move (the "too slow / didn't
// scroll" bug). A wheel event applies its delta INSTANTLY and returns immediately, so 60-120Hz of
// small deltas reads as smooth continuous scroll, exactly like a real trackpad.
//
// Sign: a wheel's deltaY is the opposite of touch-drag intent (positive deltaY scrolls the page DOWN,
// scrollY increases), so we NEGATE the finger delta to make content follow the finger: finger down
// (dy>0) -> deltaY<0 -> scrollY decreases -> content moves down with the finger. The real page scrolls
// and streams back through rrweb; no content-script change. Dispatch is bounded to the recorded tab.
async function dispatchScroll(cmd) {
  const tabId = browserSession.recordedTabId;
  if (tabId == null) return;
  const tAttach0 = performance.now();
  if (!(await ensureAttached(tabId))) return;
  const attachMs = performance.now() - tAttach0;
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const deltaX = -num(cmd.dx);
  const deltaY = -num(cmd.dy);
  if (deltaX === 0 && deltaY === 0) return; // nothing to scroll
  const t0 = performance.now();
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: clamp(cmd.x), y: clamp(cmd.y), deltaX, deltaY,
    });
    // ADR-0047 scroll diagnostic: dispatchMs is the wheel dispatch round-trip -- unlike the old
    // synthesizeScrollGesture (tens-to-hundreds of ms while it animated), this should be ~1ms, which
    // is what lets 60-120Hz of frames keep up. Read in chrome://extensions -> AgentDesk ->
    // "service worker" -> Console (filter: scroll-diag).
    console.log(`[agentdesk][scroll-diag] attachMs=${attachMs.toFixed(1)} dispatchMs=${(performance.now() - t0).toFixed(1)}`);
  } catch (e) {
    console.error('[agentdesk] scroll dispatch failed', e && e.message);
  }
}

async function clearSourceOverrides(tabId) {
  if (tabId == null || attachedTabId !== tabId) return;
  const priorUA = originalUserAgent;
  originalUserAgent = null;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {});
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    if (priorUA) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setUserAgentOverride', { userAgent: priorUA });
    }
  } catch (error) {
    console.error('[agentdesk] source viewport clear failed', error && error.message);
  }
}

async function detachDebugger(tabId) {
  if (tabId == null || attachedTabId !== tabId) return;
  attachedTabId = null;
  try { await chrome.debugger.detach({ tabId }); } catch (error) {}
}

async function applyDesiredSourceViewport(tabId) {
  if (!sourceViewport.active) return true;
  if (sourceViewport.error) return false;
  if (!(await ensureAttached(tabId))) {
    sourceViewport = { ...sourceViewport, error: 'debugger-attach-failed', actualWidth: null, actualHeight: null };
    return false;
  }
  try {
    if (originalUserAgent == null) {
      try {
        const result = await chrome.debugger.sendCommand(
          { tabId },
          'Runtime.evaluate',
          { expression: 'navigator.userAgent', returnByValue: true }
        );
        originalUserAgent = (result && result.result && result.result.value) || '';
      } catch (error) {
        originalUserAgent = '';
      }
    }
    const settings = AgentDeskSourceViewport.deviceSettings(
      sourceViewport.profile,
      sourceViewport.requestedWidth,
      sourceViewport.requestedHeight,
      MOBILE_UA
    );
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.setDeviceMetricsOverride',
      settings.metrics
    );
    await chrome.debugger.sendCommand(
      { tabId },
      'Emulation.setTouchEmulationEnabled',
      { enabled: settings.touchEnabled }
    );
    if (settings.userAgent) {
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setUserAgentOverride',
        { userAgent: settings.userAgent }
      );
    } else if (originalUserAgent) {
      await chrome.debugger.sendCommand(
        { tabId },
        'Emulation.setUserAgentOverride',
        { userAgent: originalUserAgent }
      );
    }
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {});
    const viewport = (metrics && (metrics.cssLayoutViewport || metrics.layoutViewport)) || {};
    sourceViewport = {
      ...sourceViewport,
      actualWidth: Number.isFinite(viewport.clientWidth) ? Math.round(viewport.clientWidth) : sourceViewport.requestedWidth,
      actualHeight: Number.isFinite(viewport.clientHeight) ? Math.round(viewport.clientHeight) : sourceViewport.requestedHeight,
      error: null,
    };
    return true;
  } catch (error) {
    sourceViewport = {
      ...sourceViewport,
      error: (error && error.message) || 'viewport-apply-failed',
      actualWidth: null,
      actualHeight: null,
    };
    console.error('[agentdesk] source viewport apply failed', error && error.message);
    return false;
  }
}

async function applySourceViewportCommand(command) {
  if (!browserSession.enabled) return;
  const evaluation = AgentDeskSourceViewport.evaluateCommand(
    sourceViewport,
    retiredHostEpochs,
    command,
    browserSession.targetTabId,
    browserSession.generation
  );
  if (!evaluation.accepted) return;
  if (evaluation.sameDesired) {
    if (!evaluation.sameEpoch && sourceViewport.hostEpoch) retiredHostEpochs.add(sourceViewport.hostEpoch);
    sourceViewport = { ...sourceViewport, revision: command.revision, hostEpoch: command.hostEpoch };
    await emitBrowserState();
    return;
  }

  const priorTabId = browserSession.recordedTabId;
  const preserveCdp = cdpMode;
  const preserveCdpUserSet = cdpUserSet;
  if (priorTabId != null) await stopRecorderForTab(priorTabId);
  if (!evaluation.sameEpoch && sourceViewport.hostEpoch) retiredHostEpochs.add(sourceViewport.hostEpoch);
  sourceViewport = {
    active: !!command.active,
    hostEpoch: command.hostEpoch,
    revision: command.revision,
    profile: command.active ? command.profile : null,
    sizing: command.active ? command.sizing : null,
    requestedWidth: command.active ? command.width : null,
    requestedHeight: command.active ? command.height : null,
    actualWidth: null,
    actualHeight: null,
    error: null,
  };
  browserSession = AgentDeskBrowserSession.advanceGeneration(
    browserSession,
    AgentDeskBrowserSession.selectedTarget(browserSession)
  );
  await persistBrowserSession();
  await emitBrowserState();

  if (!sourceViewport.active) {
    const debuggedTabId = priorTabId == null ? attachedTabId : priorTabId;
    await clearSourceOverrides(debuggedTabId);
    await detachDebugger(debuggedTabId);
    await emitBrowserState();
    return;
  }
  const target = AgentDeskBrowserSession.selectedTarget(browserSession).tab;
  if (!target || target.restricted || target.discarded || target.status === 'loading') return;
  if (await startRecorderForTab(target.id)) {
    cdpMode = preserveCdp;
    cdpUserSet = preserveCdpUserSet;
    if (cdpMode) {
      await restartCdpWithImmediateSnapshot();
    }
  }
  await emitBrowserState();
}

async function clearSourceViewportAfterDisconnect() {
  const recordedTabId = browserSession.recordedTabId;
  if (recordedTabId != null) await stopRecorderForTab(recordedTabId);
  const debuggedTabId = attachedTabId;
  await clearSourceOverrides(debuggedTabId);
  await detachDebugger(debuggedTabId);
  sourceViewport = {
    active: false, hostEpoch: null, revision: 0, profile: null, sizing: null,
    requestedWidth: null, requestedHeight: null, actualWidth: null, actualHeight: null, error: null,
  };
}

// --- ADR-0044 Tier B: CDP high-fidelity keyframe (opt-in / banner-already-paid) ---
// Reuses the ADR-0040 chrome.debugger attachment. DOMSnapshot.captureSnapshot pierces shadow
// boundaries (so closed shadow DOM is captured) and returns computed styles, which we inline per node
// so the flattened snapshot renders WITHOUT external/adopted stylesheets (that is the whole point).
// Password values are masked here before egress; ordinary visible text remains projectable.
// Engages only when the user opted in via the popup, OR the debugger is already attached for taps
// (banner already shown) -- so the default view-only session stays banner-free on Tier A.
const CDP_POLL_MS = 1500;
let cdpMode = false;      // whether CDP keyframes are being sent for the recording tab
let cdpUserSet = false;   // the user explicitly toggled it -> don't auto-upgrade over their choice
let cdpTimer = null;
// reconstructProjectionHtml + CDP_STYLE_PROPS come from cdp-reconstruct.js (importScripts above); the same
// file is require()'d by the cdp-verify test so projection and password masking use the real code.

async function captureCdpSnapshot() {
  const tabId = browserSession.recordedTabId;
  const generation = browserSession.generation;
  if (tabId == null || !cdpMode) return;
  if (!(await ensureAttached(tabId))) return;
  let snap, metrics;
  try {
    snap = await chrome.debugger.sendCommand({ tabId }, 'DOMSnapshot.captureSnapshot', { computedStyles: CDP_STYLE_PROPS });
  } catch (e) {
    console.error('[agentdesk] cdp snapshot failed', e && e.message);
    return;
  }
  try { metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics', {}); } catch (e) {}
  const vp = (metrics && (metrics.cssLayoutViewport || metrics.layoutViewport)) || {};
  let html;
  try { html = reconstructProjectionHtml(snap); } catch (e) { console.error('[agentdesk] cdp reconstruct failed', e && e.message); return; }
  if (!AgentDeskBrowserSession.acceptsBatch(browserSession, tabId, generation)) return;
  const p = ensurePort();
  if (!p) return;
  // k:'cdp' + full-keyframe (co:true). w/h let the replay size the frame for tap mapping.
  postCompressed(p, {
    t: 'dom-batch', tb: tabId, g: generation,
    co: true, k: 'cdp', w: vp.clientWidth || 0, h: vp.clientHeight || 0
  }, html);
}

function maybeStartCdp() {
  if (!cdpMode || browserSession.recordedTabId == null || cdpTimer) return;
  captureCdpSnapshot();
  cdpTimer = setInterval(captureCdpSnapshot, CDP_POLL_MS);
}

async function restartCdpWithImmediateSnapshot() {
  if (!cdpMode || browserSession.recordedTabId == null) return;
  await captureCdpSnapshot();
  if (cdpMode && browserSession.recordedTabId != null && !cdpTimer) {
    cdpTimer = setInterval(captureCdpSnapshot, CDP_POLL_MS);
  }
}

function stopCdp(notify) {
  if (cdpTimer) { clearInterval(cdpTimer); cdpTimer = null; }
  if (notify && port && browserSession.recordedTabId != null) {
    try { port.postMessage({
      t: 'dom-batch', tb: browserSession.recordedTabId, g: browserSession.generation,
      co: false, k: 'cdp-off'
    }); } catch (e) {}
  }
}

// Set the CDP fidelity mode. userSet=true means the popup toggle drove it (sticky: auto-upgrade won't
// override an explicit choice). notify=true tells the replay to drop the CDP overlay when turning off.
function setCdpMode(on, userSet) {
  if (userSet) cdpUserSet = true;
  const was = cdpMode;
  cdpMode = !!on;
  if (cdpMode) maybeStartCdp();
  else if (was) stopCdp(true);
}

// --- Multi-window browser projection session (ADR-0063) ---
// Chrome owns window/tab metadata. This worker owns projection selection, generation, and exactly one
// isolated-world recorder. The pure transitions live in browser-session.js and are exercised in Node.

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#D00000' });
  } catch (e) {}
}

async function startRecorderForTab(tabId) {
  if (tabId == null) return false;
  stopCdp(false); cdpMode = false; cdpUserSet = false;
  if (sourceViewport.active && !(await applyDesiredSourceViewport(tabId))) return false;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'agentdesk-start',
      generation: browserSession.generation,
    });
  } catch (e) {
    console.warn('[agentdesk] cannot start recording on tab', tabId, e && e.message);
    return false;
  }
  browserSession = AgentDeskBrowserSession.withRecordedTab(browserSession, tabId);
  await setBadge(tabId, true);
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'agentdesk-resnapshot' });
  } catch (error) {
    console.warn('[agentdesk] recorder keyframe request failed', error && error.message);
  }
  return true;
}

async function stopRecorderForTab(tabId) {
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'agentdesk-stop' }); } catch (e) {}
  if (browserSession.recordedTabId === tabId) {
    browserSession = AgentDeskBrowserSession.withRecordedTab(browserSession, null);
  }
  stopCdp(false); cdpMode = false; cdpUserSet = false;
  await clearSourceOverrides(tabId);
  await setBadge(tabId, false);
}

let sessionMutation = Promise.resolve();

function enqueueSessionMutation(operation) {
  sessionMutation = sessionMutation.then(operation).catch((error) => {
    console.error('[agentdesk] browser session mutation failed', error && error.message);
  });
  return sessionMutation;
}

async function browserStatePayload() {
  return {
    t: 'browser-state',
    generation: browserSession.generation,
    projectedWindowId: browserSession.projectedWindowId,
    focusedWindowId: browserSession.focusedWindowId,
    extension: await AgentDeskBrowserMetadata.extensionBuildIdentity(),
    viewport: {
      active: sourceViewport.active,
      revision: sourceViewport.revision,
      profile: sourceViewport.profile,
      sizing: sourceViewport.sizing,
      requestedWidth: sourceViewport.requestedWidth,
      requestedHeight: sourceViewport.requestedHeight,
      actualWidth: sourceViewport.actualWidth,
      actualHeight: sourceViewport.actualHeight,
      error: sourceViewport.error,
    },
    windows: browserSession.windows,
  };
}

async function emitBrowserState() {
  if (!browserSession.enabled) return;
  const p = ensurePort();
  if (!p) return;
  p.postMessage(await browserStatePayload());
}

async function persistBrowserSession() {
  if (!browserSession.enabled) {
    await chrome.storage.session.remove('browserProjection');
    return;
  }
  await chrome.storage.session.set({
    browserProjection: {
      enabled: true,
      projectedWindowId: browserSession.projectedWindowId,
      focusedWindowId: browserSession.focusedWindowId,
      orderedWindowIds: browserSession.orderedWindowIds,
      recentlyFocusedWindowIds: browserSession.recentlyFocusedWindowIds,
      ordinals: browserSession.ordinals,
      nextOrdinal: browserSession.nextOrdinal,
      generation: browserSession.generation,
      recordedTabId: browserSession.recordedTabId,
      targetWindowId: browserSession.targetWindowId,
      targetTabId: browserSession.targetTabId,
      targetURL: browserSession.targetURL,
      targetStatus: browserSession.targetStatus,
    },
  });
}

async function synchronizeProjectionTarget(forceGeneration) {
  const target = AgentDeskBrowserSession.selectedTarget(browserSession);
  const changedTarget = browserSession.targetWindowId !== (target.window && target.window.id)
    || browserSession.targetTabId !== (target.tab && target.tab.id);
  const changedDocument = !!target.tab && (
    browserSession.targetURL !== target.tab.url
    || (target.tab.status === 'loading' && browserSession.targetStatus !== 'loading')
  );
  const preserveCdp = !changedTarget && cdpMode;
  const preserveCdpUserSet = !changedTarget && cdpUserSet;
  if (changedTarget || changedDocument || forceGeneration) {
    if (browserSession.recordedTabId != null) await stopRecorderForTab(browserSession.recordedTabId);
    if (preserveCdp) {
      cdpMode = true;
      cdpUserSet = preserveCdpUserSet;
    }
    browserSession = AgentDeskBrowserSession.advanceGeneration(browserSession, target);
    await persistBrowserSession();
    await emitBrowserState();
  } else {
    browserSession = AgentDeskBrowserSession.withTargetMetadata(browserSession, target);
  }

  const tab = target.tab;
  if (!tab || tab.restricted || tab.discarded || tab.status === 'loading') {
    if (browserSession.recordedTabId != null) {
      await stopRecorderForTab(browserSession.recordedTabId);
      await emitBrowserState();
    }
    return;
  }
  if (!sourceViewport.active) return;
  if (browserSession.recordedTabId == null) {
    if (await startRecorderForTab(tab.id)) {
      cdpMode = preserveCdp;
      cdpUserSet = preserveCdpUserSet;
      if (cdpMode) await restartCdpWithImmediateSnapshot();
    }
    await emitBrowserState();
  }
}

async function refreshBrowserProjection(options) {
  if (!browserSession.enabled) return;
  const settings = options || {};
  const windows = await AgentDeskBrowserMetadata.enumerateNormalWindows();
  const focused = windows.find((window) => window.focused);
  let focusedWindowId = settings.focusedWindowId == null ? (focused && focused.id) : settings.focusedWindowId;
  if (focusedWindowId == null && browserSession.focusedWindowId == null && windows.length) {
    try {
      const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      focusedWindowId = lastFocused && lastFocused.id;
    } catch (error) {
      console.warn('[agentdesk] most-recent Chrome window lookup failed', error && error.message);
    }
  }
  browserSession = AgentDeskBrowserSession.reconcile(
    browserSession,
    windows,
    focusedWindowId
  );
  if (settings.followFocusedWindowId != null) {
    browserSession = AgentDeskBrowserSession.followFocusedWindow(browserSession, settings.followFocusedWindowId);
  }
  if (settings.synchronizeTarget !== false) {
    await synchronizeProjectionTarget(!!settings.forceGeneration);
  }
  await persistBrowserSession();
  await emitBrowserState();
}

async function requestBrowserState() {
  await refreshBrowserProjection();
  if (browserSession.recordedTabId == null) return;
  try {
    await chrome.tabs.sendMessage(browserSession.recordedTabId, { type: 'agentdesk-resnapshot' });
  } catch (error) {
    console.warn('[agentdesk] browser state keyframe request failed', error && error.message);
  }
}

async function startBrowserProjection() {
  if (browserSession.enabled) {
    await refreshBrowserProjection();
    return browserSession.projectedWindowId;
  }
  browserSession = Object.assign(AgentDeskBrowserSession.createSession(), { enabled: true });
  await refreshBrowserProjection();
  return browserSession.projectedWindowId;
}

async function stopBrowserProjection() {
  const recordedTabId = browserSession.recordedTabId;
  if (recordedTabId != null) await stopRecorderForTab(recordedTabId);
  const debuggedTabId = attachedTabId;
  await clearSourceOverrides(debuggedTabId);
  await detachDebugger(debuggedTabId);
  browserSession = AgentDeskBrowserSession.createSession();
  sourceViewport = {
    active: false, hostEpoch: null, revision: 0, profile: null, sizing: null,
    requestedWidth: null, requestedHeight: null, actualWidth: null, actualHeight: null, error: null,
  };
  await chrome.storage.session.remove('browserProjection');
  if (port) {
    try { port.disconnect(); } catch (error) {}
    port = null;
  }
}

async function toggleBrowserProjection() {
  if (browserSession.enabled) await stopBrowserProjection();
  else await startBrowserProjection();
}

async function selectProjectedWindow(command) {
  const next = AgentDeskBrowserSession.selectWindow(
    browserSession,
    command.windowId,
    command.generation
  );
  if (!next) {
    console.warn('[agentdesk] rejected browser-select-window');
    return;
  }
  browserSession = next;
  await synchronizeProjectionTarget(false);
  await persistBrowserSession();
  await emitBrowserState();
}

async function selectProjectedTab(command) {
  if (!AgentDeskBrowserSession.validateTabSelection(
    browserSession,
    command.windowId,
    command.tabId,
    command.generation
  )) {
    console.warn('[agentdesk] rejected browser-select-tab');
    return;
  }
  await chrome.tabs.update(command.tabId, { active: true });
  await refreshBrowserProjection();
}

function popupState() {
  const target = AgentDeskBrowserSession.selectedTarget(browserSession);
  return {
    recording: browserSession.enabled,
    title: target.tab ? (target.tab.title || target.tab.url || '') : '',
    canRecord: true,
    fidelity: browserSession.recordedTabId != null && cdpMode,
  };
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-recording') enqueueSessionMutation(toggleBrowserProjection);
});

chrome.windows.onCreated.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.windows.onRemoved.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  enqueueSessionMutation(() => refreshBrowserProjection({
    focusedWindowId: windowId,
    followFocusedWindowId: windowId,
  }));
});

chrome.tabs.onCreated.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.tabs.onMoved.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.tabs.onAttached.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.tabs.onDetached.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.tabs.onActivated.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabId === tabId) attachedTabId = null;
  enqueueSessionMutation(() => refreshBrowserProjection());
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  enqueueSessionMutation(async () => {
    if (!browserSession.enabled) return;
    await refreshBrowserProjection({ forceGeneration: info.discarded === true && tabId === browserSession.targetTabId });
  });
});

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
  chrome.tabGroups.onMoved.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
  chrome.tabGroups.onRemoved.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
  chrome.tabGroups.onUpdated.addListener(() => enqueueSessionMutation(() => refreshBrowserProjection()));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (message.type === 'agentdesk-popup-query') {
    sendResponse(popupState());
    return true;
  }
  if (message.type === 'agentdesk-popup-toggle') {
    enqueueSessionMutation(toggleBrowserProjection).then(() => sendResponse(popupState()));
    return true;
  }
  // ADR-0044 Tier B: the popup high-fidelity toggle. Only meaningful for the recording tab; engaging
  // it attaches chrome.debugger (banner) and starts CDP keyframes.
  if (message.type === 'agentdesk-popup-fidelity') {
    if (browserSession.recordedTabId != null) setCdpMode(!!message.on, true);
    sendResponse(popupState());
    return true;
  }
  if (message.type === 'agentdesk-batch') {
    const tb = tabId == null ? -1 : tabId;
    const generation = message.generation;
    if (!AgentDeskBrowserSession.acceptsBatch(browserSession, tb, generation)) return;
    const p = ensurePort();
    if (!p) return;
    const co = !!message.checkout;
    // ADR-0043: compress the events off the page thread. Chrome drops an ext->host native message
    // over ~1 MB and the host caps a line at 2 MB; deflate keeps a full snapshot well under both.
    let b64;
    try {
      b64 = bytesToBase64(fflate.zlibSync(fflate.strToU8(JSON.stringify(message.events))));
    } catch (e) {
      console.error('[agentdesk] batch compress failed', e && e.message);
      return;
    }
    if (b64.length <= CHUNK_LIMIT) {
      p.postMessage({ t: 'dom-batch', tb, g: generation, co, enc: 'deflate-b64', ev: b64, meta: message.meta });
    } else {
      // Backstop: a compressed batch still over the limit is split into ordered parts reassembled by
      // cid in the webview. co rides part 0 only, so the host's late-join buffer resets once per
      // snapshot (not per part) and keeps the whole chunked snapshot together.
      const cid = nextChunkId++;
      const total = Math.ceil(b64.length / CHUNK_LIMIT);
      for (let seq = 0; seq < total; seq++) {
        p.postMessage({
          t: 'dom-batch',
          tb,
          g: generation,
          co: seq === 0 ? co : false,
          enc: 'deflate-b64',
          ev: b64.slice(seq * CHUNK_LIMIT, (seq + 1) * CHUNK_LIMIT),
          meta: seq === 0 ? message.meta : undefined,
          cid,
          seq,
          total,
        });
      }
    }
    // ADR-0044 Tier A: adopted-stylesheet CSS (keyframes only) rides its OWN compressed line, sent
    // right after the events. Kept off the ev payload so the ADR-0043 ev path is byte-for-byte
    // unchanged, and off the chunked seq-0 line so it can't push that line past the 2 MB frame cap.
    // co:false -- the events checkout already reset the late-join buffer; this appends to it. The
    // webview injects it as a <style>. If it's still too big (huge design-system sheet), drop it with
    // a log rather than risk a frame-cap violation; the next keyframe retries.
    if (message.css) {
      try {
        const cssz = bytesToBase64(fflate.zlibSync(fflate.strToU8(message.css)));
        if (cssz.length <= CHUNK_LIMIT) {
          p.postMessage({ t: 'dom-batch', tb, g: generation, co: false, enc: 'deflate-b64', cssz });
        } else {
          console.warn('[agentdesk] adopted css too large, skipped', cssz.length);
        }
      } catch (e) {
        console.error('[agentdesk] css compress failed', e && e.message);
      }
    }
    return;
  }
  if (message.type === 'agentdesk-error') {
    console.error('[agentdesk] recorder error', message.reason);
  }
});

enqueueSessionMutation(async () => {
  try {
    const stored = await chrome.storage.session.get('browserProjection');
    const saved = stored && stored.browserProjection;
    if (!saved || !saved.enabled) return;
    browserSession = AgentDeskBrowserSession.restoreSession(saved);
    await refreshBrowserProjection();
  } catch (error) {
    console.error('[agentdesk] browser session restore failed', error && error.message);
  }
});
