// M3 — MV3 background service worker (ADR-0038/0039).
//
// Holds the single native-messaging port to the dom-bridge shim (which also keeps this worker
// alive), injects the MAIN-world recorder on request, and fans batches from N tabs into the one
// native port. Read-only v1: host -> extension messages (input commands) are logged but not yet
// dispatched (Phase 5).
const NATIVE_HOST = 'com.example.agentdesk.agentdesk.dom_bridge';

let port = null;

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
    // Phase 5: route input commands back into the tab. For read-only v1, just observe.
    console.log('[agentdesk] host->ext', msg && msg.t);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('[agentdesk] native port disconnected', err && err.message);
    port = null; // reconnect lazily on the next batch
  });
  return port;
}

chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab && sender.tab.id;
  if (message.type === 'agentdesk-start') {
    if (tabId == null) return;
    // Inject rrweb + the MAIN-world recorder. Extension-injected scripts are exempt from the
    // page CSP, which is why this works where a page-context bookmarklet would be blocked.
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
