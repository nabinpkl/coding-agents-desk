// M1 — MAIN-world rrweb recorder (ADR-0038).
//
// Injected into the page's MAIN world by the service worker (chrome.scripting world:'MAIN'), so it
// bypasses the page CSP and can see the CSSStyleSheet/attachShadow/canvas prototype patches rrweb
// installs -- which an isolated-world script would miss. It cannot touch chrome.*; it only records
// and hands batches to the isolated content script via window.postMessage. rrweb is loaded (as a
// prior file in the same executeScript injection) before this runs, exposing window.rrweb.
(() => {
  if (window.__agentdeskDomMirrorStarted) return;
  window.__agentdeskDomMirrorStarted = true;

  const CHANNEL = 'agentdesk-dom-mirror';
  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot -> marks a checkout batch

  if (!window.rrweb || !window.rrweb.record) {
    window.postMessage({ __agentdesk: CHANNEL, kind: 'error', reason: 'rrweb-not-loaded' }, '*');
    return;
  }

  let batch = [];
  window.rrweb.record({
    emit(event) { batch.push(event); },
    checkoutEveryNms: 5000, // periodic full snapshot so a late-joining phone can bootstrap
    // Privacy: mask-by-default for an arbitrary tab (ADR-0038). This rrweb (2.0.0-alpha.4) has no
    // `maskAllText` boolean, so `maskTextSelector: '*'` matches every element and redacts every
    // visible text node; `maskAllInputs` redacts every input value. Together, no page content --
    // email bodies, chat, dollar figures, typed text, passwords -- streams in the clear.
    // `agentdesk-block` removes an element entirely. A per-element text allowlist (unmask) is not
    // available in this rrweb version; attribute masking (alt/title/aria-label) is a Phase-6 follow-up.
    maskTextSelector: '*',
    maskAllInputs: true,
    blockClass: 'agentdesk-block',
    sampling: { mousemove: 50, scroll: 100, input: 'last' },
  });

  // Flush batched events on a fixed cadence. A batch that contains a FullSnapshot is a checkout.
  setInterval(() => {
    if (!batch.length) return;
    const events = batch;
    batch = [];
    const checkout = events.some((e) => e.type === FULL_SNAPSHOT);
    window.postMessage({
      __agentdesk: CHANNEL,
      kind: 'batch',
      checkout,
      events,
      meta: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        sx: window.scrollX,
        sy: window.scrollY,
      },
    }, '*');
  }, 250);
})();
