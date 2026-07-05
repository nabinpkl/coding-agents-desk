// M3 — MV3 background service worker (ADR-0038/0039/0040).
//
// Holds the single native-messaging port to the dom-bridge shim (which also keeps this worker
// alive), injects the MAIN-world recorder on request, fans batches from N tabs into the one native
// port, and (ADR-0040) dispatches host-originated taps back into the recorded tab as TRUSTED input
// via chrome.debugger.
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

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (message.type === 'agentdesk-start') {
    if (tabId == null) return;
    recordingTabId = tabId;
    // Inject rrweb + the MAIN-world recorder. Extension-injected scripts are exempt from the page
    // CSP, which is why this works where a page-context bookmarklet would be blocked.
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['vendor/rrweb.min.js', 'record-main.js'],
    }).catch((e) => console.error('[agentdesk] inject failed', e));
    return;
  }
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
