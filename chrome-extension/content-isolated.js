// M2 — isolated content script (ADR-0038).
//
// The only page-context code that can touch chrome.*. It decides whether this page should be
// recorded, asks the service worker to inject the MAIN-world recorder, and relays the recorder's
// window.postMessage batches to the worker. It shares the page's `window` with the MAIN world, so
// postMessage from the recorder is received here.
(() => {
  if (window.__agentdeskDomMirrorContent) return;
  window.__agentdeskDomMirrorContent = true;

  const CHANNEL = 'agentdesk-dom-mirror';

  // Test-only auto-start gate: only pages that explicitly opt in via ?agentdesk_record=1 are
  // recorded automatically. Real use will start recording from a user action (toolbar), never
  // silently on arbitrary sites. This keeps the recorder dark on normal browsing.
  const autoStart = new URLSearchParams(location.search).has('agentdesk_record');
  if (!autoStart) return;

  // Relay recorder batches (from the MAIN world) to the service worker.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__agentdesk !== CHANNEL) return;
    if (data.kind === 'batch') {
      chrome.runtime.sendMessage({
        type: 'agentdesk-batch',
        checkout: data.checkout,
        events: data.events,
        meta: data.meta,
      });
    } else if (data.kind === 'error') {
      chrome.runtime.sendMessage({ type: 'agentdesk-error', reason: data.reason });
    }
  });

  // Ask the worker to inject the MAIN-world recorder into this tab.
  chrome.runtime.sendMessage({ type: 'agentdesk-start' });
})();
