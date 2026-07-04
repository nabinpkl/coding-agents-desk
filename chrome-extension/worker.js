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
// masked FullSnapshot can exceed the host's 2 MB line cap, but compressed it is tens of KB. A still-
// oversized compressed batch (>~15 MB raw) is chunked into cid/seq/total parts, each a normal line.
importScripts('vendor/fflate.min.js');

const NATIVE_HOST = 'com.example.agentdesk.agentdesk.dom_bridge';

// A compressed+base64 batch line larger than this is split into chunk parts, each well under the
// host's 2 MB newline-frame cap. ~15 MB of raw events is needed to reach this after deflate.
const CHUNK_LIMIT = 1_500_000; // base64 chars per part
let nextChunkId = 0;

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

// Status snapshot for the action popup. canRecord is false on pages with no content script
// (chrome://, the Web Store), where mirroring can't start.
function popupState(tab) {
  const canRecord = !!tab && /^https?:/.test(tab.url || '');
  return {
    recording: !!tab && recordingTabId === tab.id,
    title: tab ? (tab.title || tab.url || '') : '',
    canRecord,
  };
}

// The toolbar click opens popup.html (default_popup), so chrome.action.onClicked does not fire;
// the popup drives start/stop through these messages. The keyboard command toggles directly below.
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  // Action popup: report status / toggle the active tab. Resolved worker-side so recordingTabId is
  // the single source of truth. Async responses -> return true to keep the channel open.
  if (message.type === 'agentdesk-popup-query') {
    activeTab().then((tab) => sendResponse(popupState(tab)));
    return true;
  }
  if (message.type === 'agentdesk-popup-toggle') {
    activeTab().then(async (tab) => {
      if (tab && tab.id != null) await toggleTabRecording(tab.id);
      sendResponse(popupState(tab));
    });
    return true;
  }
  if (message.type === 'agentdesk-batch') {
    const p = ensurePort();
    if (!p) return;
    const tb = tabId == null ? -1 : tabId;
    const co = !!message.checkout;
    // ADR-0043: compress the events off the page thread. Chrome drops an ext->host native message
    // over ~1 MB and the host caps a line at 2 MB; deflate keeps a masked snapshot well under both.
    let b64;
    try {
      b64 = bytesToBase64(fflate.zlibSync(fflate.strToU8(JSON.stringify(message.events))));
    } catch (e) {
      console.error('[agentdesk] batch compress failed', e && e.message);
      return;
    }
    if (b64.length <= CHUNK_LIMIT) {
      p.postMessage({ t: 'dom-batch', tb, co, enc: 'deflate-b64', ev: b64, meta: message.meta });
      return;
    }
    // Backstop: a compressed batch still over the limit is split into ordered parts reassembled by
    // cid in the webview. co rides part 0 only, so the host's late-join buffer resets once per
    // snapshot (not per part) and keeps the whole chunked snapshot together.
    const cid = nextChunkId++;
    const total = Math.ceil(b64.length / CHUNK_LIMIT);
    for (let seq = 0; seq < total; seq++) {
      p.postMessage({
        t: 'dom-batch',
        tb,
        co: seq === 0 ? co : false,
        enc: 'deflate-b64',
        ev: b64.slice(seq * CHUNK_LIMIT, (seq + 1) * CHUNK_LIMIT),
        meta: seq === 0 ? message.meta : undefined,
        cid,
        seq,
        total,
      });
    }
    return;
  }
  if (message.type === 'agentdesk-error') {
    console.error('[agentdesk] recorder error', message.reason);
  }
});
