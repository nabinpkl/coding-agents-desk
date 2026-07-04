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
const NATIVE_HOST = 'com.example.agentdesk.agentdesk.dom_bridge';

let port = null;
// The tab currently being recorded; input from the phone is dispatched here (single-tab v1).
let recordingTabId = null;
// The tab chrome.debugger is currently attached to (one debuggee per tab; shows the debug banner).
let attachedTabId = null;

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
    // ADR-0040: host -> extension input command. Dispatch it as trusted input.
    if (msg && msg.t === 'dom-input') dispatchInput(msg);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[agentdesk] native port disconnected', err && err.message);
    port = null; // reconnect lazily on the next batch
  });
  return port;
}

// Keep attachedTabId honest if the tab (or user) detaches the debugger.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) attachedTabId = null;
});

async function ensureAttached(tabId) {
  if (attachedTabId === tabId) return true;
  if (attachedTabId != null) {
    try { await chrome.debugger.detach({ tabId: attachedTabId }); } catch (e) {}
    attachedTabId = null;
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
  const tabId = recordingTabId;
  if (tabId == null) return;
  if (!(await ensureAttached(tabId))) return;
  const target = { tabId };
  // Defense-in-depth (ADR-0040): clamp to finite, non-negative coordinates before dispatch, so a
  // compromised/buggy client cannot probe negative or non-finite points. CDP already ignores points
  // outside the viewport; the blast radius is bounded to recordingTabId regardless.
  const clamp = (v) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const base = { x: clamp(cmd.x), y: clamp(cmd.y), button: 'left', clickCount: 1 };
  try {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base });
  } catch (e) {
    console.error('[agentdesk] dispatch failed', e && e.message);
  }
}

// --- Chrome-layer recording controls (ADR-0042) ---
// Start/stop drive the isolated-world recorder by messaging the content script. recordingTabId is the
// single-tab-v1 target for ADR-0040 tap dispatch. These are top-level so a test can invoke them in
// the service worker via Playwright's sw.evaluate (which cannot click the toolbar action).

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? 'REC' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#D00000' });
  } catch (e) {}
}

async function startTabRecording(tabId) {
  if (tabId == null) return null;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'agentdesk-start' });
  } catch (e) {
    // Restricted pages (chrome://, webstore) have no content script; nothing to record.
    console.warn('[agentdesk] cannot start recording on tab', tabId, e && e.message);
    return null;
  }
  recordingTabId = tabId;
  await setBadge(tabId, true);
  return tabId;
}

async function stopTabRecording(tabId) {
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'agentdesk-stop' }); } catch (e) {}
  if (recordingTabId === tabId) recordingTabId = null;
  await setBadge(tabId, false);
}

async function toggleTabRecording(tabId) {
  if (tabId == null) return;
  if (recordingTabId === tabId) await stopTabRecording(tabId);
  else await startTabRecording(tabId);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// Test entry point (Playwright sw.evaluate) and the command fallback: resolve the active tab and
// start it. The real toolbar path uses the tab handed to onClicked directly.
async function startActiveTabRecording() {
  const tab = await activeTab();
  return tab ? startTabRecording(tab.id) : null;
}

async function stopRecording() {
  if (recordingTabId != null) await stopTabRecording(recordingTabId);
}

// Toolbar click: onClicked fires only when there is no default_popup. Toggle the clicked tab.
chrome.action.onClicked.addListener((tab) => { if (tab && tab.id != null) toggleTabRecording(tab.id); });

// Keyboard command (Alt+Shift+M): no tab is passed, so resolve the active one.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  const tab = await activeTab();
  if (tab && tab.id != null) toggleTabRecording(tab.id);
});

// Lifecycle: keep recordingTabId/attachedTabId honest so ADR-0040 tap dispatch never targets a tab
// that is no longer recording.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordingTabId === tabId) recordingTabId = null;
  if (attachedTabId === tabId) attachedTabId = null;
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // A navigation re-injects a fresh, non-recording content script; drop the stale recording state.
  if (tabId === recordingTabId && info.status === 'loading' && info.url) {
    recordingTabId = null;
    setBadge(tabId, false);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (message.type === 'agentdesk-batch') {
    const p = ensurePort();
    if (!p) return;
    // NOTE (Phase 3): Chrome silently drops an ext->host native message over ~1 MB, a tighter limit
    // than the host's 2 MB line cap. rrweb inlineImages/dataURL is off by default so batches stay
    // small (~KB), but a huge DOM could exceed it -- Phase 3 should chunk or drop-with-signal rather
    // than rely on Chrome truncating.
    p.postMessage({
      t: 'dom-batch',
      tb: tabId == null ? -1 : tabId,
      co: !!message.checkout,
      ev: message.events,
      meta: message.meta,
    });
    return;
  }
  if (message.type === 'agentdesk-error') {
    console.error('[agentdesk] recorder error', message.reason);
  }
});
