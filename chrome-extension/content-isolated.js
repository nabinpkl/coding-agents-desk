// Isolated-world DOM recorder (ADR-0038, ADR-0042).
//
// This is the ONLY code that records the page, and it runs entirely in the extension's isolated
// content-script world -- never the page's MAIN world. Consequences (ADR-0042): the page cannot see
// that it is being recorded via its own JS or URL. There is no `?agentdesk_record` URL gate, no
// `window.rrweb`/`window.__agentdesk*` global on the page, and no `window.postMessage` traffic;
// batches go straight to the service worker over chrome.runtime.sendMessage. rrweb is loaded as the
// prior file in this content_scripts entry (`vendor/rrweb.min.js`), so its top-level `var rrweb`
// binding lives in this isolated realm and is referenced here as globalThis.rrweb.
//
// Recording is started/stopped by the service worker (toolbar action or Alt+Shift+M command), which
// sends an `agentdesk-start` / `agentdesk-stop` message. It never self-starts.
//
// Fidelity note (ADR-0042): isolated-world rrweb cannot patch the page realm's prototypes, so
// dynamic/closed shadow DOM, canvas/WebGL pixels, and adopted/constructable stylesheets created by
// page script are not captured. Static shadow roots and initial stylesheets still serialize.
(() => {
  const CHANNEL = 'agentdesk-dom-mirror';
  const FULL_SNAPSHOT = 2; // rrweb EventType.FullSnapshot -> marks a checkout batch

  const rrweb = globalThis.rrweb || (typeof rrweb !== 'undefined' && rrweb) || null;

  // ADR-0038/0041 attribute masking. rrweb 2.0.0-alpha.4 has no maskAttributeFn, and maskTextSelector
  // only masks text NODES -- attribute-borne text (title/alt/aria-label/placeholder) can still carry
  // PII. Redact those attribute values in a post-emit pass, on both the FullSnapshot tree and
  // incremental attribute mutations. data-* and structural attributes are untouched (the mirror still
  // reconstructs layout; only human-readable attribute text is masked).
  const SENSITIVE_ATTRS = ['title', 'alt', 'aria-label', 'aria-description', 'placeholder'];
  function redactAttrs(attrs) {
    if (!attrs) return;
    for (var k in attrs) {
      if (SENSITIVE_ATTRS.indexOf(k) >= 0 && typeof attrs[k] === 'string' && attrs[k].length) {
        attrs[k] = '*'.repeat(Math.min(attrs[k].length, 8));
      }
    }
  }
  function redactNode(node) {
    if (!node) return;
    redactAttrs(node.attributes);
    if (node.childNodes) for (var i = 0; i < node.childNodes.length; i++) redactNode(node.childNodes[i]);
  }
  function redactEvent(e) {
    if (e.type === 2 && e.data && e.data.node) redactNode(e.data.node); // FullSnapshot
    if (e.type === 3 && e.data && e.data.source === 0 && Array.isArray(e.data.attributes)) {
      e.data.attributes.forEach(function (m) { redactAttrs(m && m.attributes); }); // attribute mutations
    }
    return e;
  }

  // Recorder state lives in this isolated realm only -- no page-visible flags.
  let recording = false;
  let stopFn = null;       // rrweb.record() returns its own stop function
  let flushTimer = null;
  let batch = [];
  let lastHref = '';       // ADR-0043: SPA-nav detection -> force a fresh full snapshot (keyframe)

  // An orphaned content script -- extension reloaded/updated while this tab stayed open -- has an
  // invalidated chrome.runtime: every sendMessage throws "Extension context invalidated". Detect it so
  // the 250 ms flush tick tears the recorder down instead of spinning a permanent error loop; a fresh
  // content script loads on this tab's next navigation/reload.
  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  // ADR-0044 Tier A: the isolated world CAN read adopted/constructable stylesheets (document + open
  // shadow roots) and their rules -- rrweb can't, because it captures them by monkeypatching
  // CSSStyleSheet in the page's MAIN world (patches don't cross realms), and its snapshot serializer
  // doesn't read document.adoptedStyleSheets (rrweb #1567). So a page styled via adopted sheets (e.g.
  // Google) serializes as structure with no CSS -> renders blank. We read the rule text ourselves on
  // each keyframe and ship it alongside; the replay injects it as a <style>. No MAIN world needed.
  // Closed shadow roots are null here (that residue is Tier B / CDP).
  function collectAdoptedCSS() {
    const parts = [];
    const fromSheets = (sheets) => {
      if (!sheets) return;
      for (let i = 0; i < sheets.length; i++) {
        try {
          const rules = sheets[i].cssRules;
          for (let j = 0; j < rules.length; j++) parts.push(rules[j].cssText);
        } catch (e) { /* cross-origin or detached sheet: skip */ }
      }
    };
    try { fromSheets(document.adoptedStyleSheets); } catch (e) {}
    try {
      const all = document.querySelectorAll('*');
      for (let k = 0; k < all.length; k++) {
        const sr = all[k].shadowRoot; // open roots only; closed returns null
        if (sr) fromSheets(sr.adoptedStyleSheets);
      }
    } catch (e) {}
    return parts.join('\n');
  }

  function flush() {
    // `if (recording)` keeps stopRecording()'s own residual flush() from re-entering this branch.
    if (!contextAlive()) { if (recording) stopRecording(); return; }
    // ADR-0043: rrweb's own checkoutEveryNms is a wall-clock keyframe; SPA route changes don't move
    // it, so a client that late-joins mid-route would wait up to 2 min for a usable snapshot. Poll the
    // URL on the flush tick and force a full snapshot on change (no MAIN-world history hook needed).
    if (recording && location.href !== lastHref) {
      lastHref = location.href;
      if (rrweb && typeof rrweb.record.takeFullSnapshot === 'function') {
        try { rrweb.record.takeFullSnapshot(true); } catch (e) {}
      }
    }
    if (!batch.length) return;
    const events = batch;
    batch = [];
    const checkout = events.some((e) => e.type === FULL_SNAPSHOT);
    // ADR-0044 Tier A: attach adopted-stylesheet CSS on keyframes only (rare, and the read walks the
    // DOM for open shadow roots, so keep it off the incremental path).
    const css = checkout ? collectAdoptedCSS() : '';
    try {
      chrome.runtime.sendMessage({
        type: 'agentdesk-batch',
        __agentdesk: CHANNEL,
        checkout,
        events,
        css: css || undefined,
        meta: {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          sx: window.scrollX,
          sy: window.scrollY,
        },
      });
    } catch (e) {
      // Context died between the guard and here (extension reloaded mid-tick): stop cleanly.
      stopRecording();
    }
  }

  function startRecording() {
    if (recording) return; // idempotent
    if (!rrweb || !rrweb.record) {
      chrome.runtime.sendMessage({ type: 'agentdesk-error', reason: 'rrweb-not-loaded' });
      return;
    }
    recording = true;
    batch = [];
    lastHref = location.href;
    // Privacy: mask-by-default for an arbitrary tab (ADR-0038). This rrweb (2.0.0-alpha.4) has no
    // `maskAllText` boolean, so `maskTextSelector: '*'` matches every element and redacts every
    // visible text node; `maskAllInputs` redacts every input value. Together, no page content --
    // email bodies, chat, dollar figures, typed text, passwords -- streams in the clear.
    stopFn = rrweb.record({
      emit(event) { batch.push(redactEvent(event)); },
      // ADR-0043: keyframe every 2 min (not 5 s). Each full snapshot is the biggest line on the wire;
      // at 5 s it dominated bandwidth and (uncompressed) blew the host's 2 MB frame cap on heavy pages.
      // Compression + a rare keyframe + SPA-nav snapshots (see flush) keep late-join fast and cheap.
      checkoutEveryNms: 120000,
      // Trim non-visual nodes from the snapshot before it is serialized/compressed: scripts, comments,
      // and head metadata never render in the mirror, so dropping them shrinks the keyframe further.
      slimDOMOptions: {
        script: true,
        comment: true,
        headFavicon: true,
        headWhitespace: true,
        headMetaSocial: true,
        headMetaRobots: true,
      },
      maskTextSelector: '*',
      maskAllInputs: true,
      blockClass: 'agentdesk-block',
      sampling: { mousemove: 50, scroll: 100, input: 'last' },
    }) || null;
    flushTimer = setInterval(flush, 250);
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (typeof stopFn === 'function') { try { stopFn(); } catch (e) {} }
    stopFn = null;
    flush(); // ship any residual events
    batch = [];
  }

  // The service worker drives start/stop; the page has no way to trigger or observe this.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'agentdesk-start') { startRecording(); sendResponse({ recording }); return true; }
    if (msg.type === 'agentdesk-stop') { stopRecording(); sendResponse({ recording }); return true; }
    // ADR-0048: the worker device-emulated (or restored) the tab; force a fresh full snapshot so the
    // next flush emits a checkout with the new meta.w/h (the emulated viewport) and the mirror repaints
    // to the true mobile/desktop layout. Same primitive the SPA-nav keyframe uses (see flush()).
    if (msg.type === 'agentdesk-resnapshot') {
      if (recording && rrweb && typeof rrweb.record.takeFullSnapshot === 'function') {
        try { rrweb.record.takeFullSnapshot(true); } catch (e) {}
      }
      sendResponse({ recording });
      return true;
    }
  });
})();
