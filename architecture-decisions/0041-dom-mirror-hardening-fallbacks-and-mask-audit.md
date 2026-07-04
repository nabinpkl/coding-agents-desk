---
status: proposed
date: 2026-07-01
---

# DOM-mirror hardening: attribute masking, pixel fallback, asset reachability, mask audit

## Context and Problem Statement

Read-only v1 (ADR-0038) plus input (ADR-0040) mirror a Chrome tab to the phone with text and input
values masked. Three gaps remain before always-on use on arbitrary real pages: (1) attribute-borne
text (title/alt/aria-label/placeholder) still carried PII; (2) canvas/WebGL/`<video>`/cross-origin
iframes are not representable as DOM and come across blank; (3) images/fonts/CSS are loaded by URL,
so a phone can't fetch cookie-gated or localhost-only assets. This decision records how each is
handled or deferred, and audits exactly what is and isn't masked. Touches `chrome-extension/
record-main.js` (masking) and names the interfaces for the deferred pixel/asset work.

## Decision Drivers

- Privacy: no human-readable page content should reach the phone unmasked (the load-bearing v1 rule).
- Keep the DOM lane decoupled from the media/video path; a pixel fallback must not entangle them.
- Ship the tractable privacy fix now; defer large subsystems (pixel compositing, asset proxy) without
  losing the decision or the interface.

## Considered Options

- **Attribute masking**: (A) upgrade rrweb to a build with `maskAttributeFn`; (B) redact sensitive
  attributes in a post-emit pass in the recorder.
- **Pixel content**: (A) punch through to the existing media/video path for canvas/video regions now;
  (B) defer, behind a clean region-signal interface, and blank for v1.
- **Asset reachability**: (A) inline everything (`inlineImages`/`collectFonts`); (B) inline only
  stylesheets, leave images/fonts by URL, and defer a host-side asset proxy.

## Decision Outcome

**Attribute masking — Option B (implemented).** `maskAttributeFn` is absent in the pinned rrweb
(2.0.0-alpha.4), and an upgrade would re-open the whole masking/replay surface. Instead the recorder
redacts a fixed set of sensitive attributes (`title`, `alt`, `aria-label`, `aria-description`,
`placeholder`) in a post-emit pass over the FullSnapshot tree and incremental attribute mutations.
`data-*` and structural attributes are untouched, so the mirror still reconstructs layout. Verified:
`just dom-mirror-record-verify` now asserts a `title` secret is absent while the `data-*` capture
marker is still present.

**Pixel content — Option B (deferred, interface named).** For v1, canvas/WebGL/`<video>` and
cross-origin iframes render blank (rrweb captures element state, not pixels; cross-origin DOM is
unreadable). A v2 pixel fallback marks such regions as unrenderable and composites the existing
owned-media video for exactly those rectangles — kept behind a clean region-signal interface so the
DOM lane and the media path never entangle (the reviewer's decoupling driver). Not built in this arc.

**Asset reachability — Option B (partial now, proxy deferred).** rrweb's `inlineStylesheet` (on)
carries CSS, so layout/typography travel self-contained. Images and fonts stay URL-referenced
(inlining them multiplies bandwidth), which is correct for public pages but breaks for cookie-gated
or localhost-only assets. The v2 fix is a host-side asset proxy that fetches with the session's
credentials and rewrites URLs; `inlineImages` remains an opt-in escape hatch. Deferred.

### Consequences

- Good, because attribute-borne PII is now masked — the v1 "no unmasked page text" rule holds for
  attributes too, tested.
- Bad, because rich surfaces (canvas/video/cross-origin) are blank until the v2 pixel fallback lands.
- Bad, because authed/localhost images and fonts won't load on the phone until the v2 asset proxy.
- Neutral, because both deferrals are behind named interfaces and recorded here, not silently dropped.

### Confirmation

`just dom-mirror-record-verify` asserts, in one run: visible text masked, text-input masked, password
masked, and now **attribute text masked**, while the `data-*` structural marker is present. The
pixel-fallback and asset-proxy interfaces are named here; their absence is a known v1 limitation, not
a regression.

### Privacy-mask audit (what reaches the phone)

- **Masked (never sent as plaintext):** all visible text nodes (`maskTextSelector: '*'`), all input
  values (`maskAllInputs`, incl. password/email), and sensitive attributes (title/alt/aria-label/
  aria-description/placeholder, redacted in the recorder). Two honest caveats: (a) the attribute mask
  is a **denylist** of the common tooltip/label attributes — `aria-valuetext`, `aria-placeholder`,
  and custom `data-*`-tooltip conventions are NOT covered (`data-*` is deliberately preserved for
  layout), so "sensitive attributes masked" means this enumerated set, not all attribute PII; (b) the
  mask is `'*'.repeat(min(len,8))`, which leaks one bit — whether the original was ≤8 or >8 chars —
  negligible for tooltip/label text, and a fixed-length mask would close even that.
- **Not representable / not sent:** canvas & WebGL pixels, `<video>` frames, cross-origin iframe
  content (blank).
- **Sent (intended):** DOM structure, layout, non-sensitive attributes (`data-*`, class, id, href,
  src URLs), and CSS. `src`/`href` URLs can themselves encode information; masking those is a future
  consideration if a page puts secrets in URLs, noted but not addressed in v1.

## Links

- ADR-0038 DOM mirror over a dedicated reliable QUIC lane
- ADR-0040 trusted Chrome input via chrome.debugger
- rrweb privacy options — https://github.com/rrweb-io/rrweb/blob/master/guide.md#privacy
