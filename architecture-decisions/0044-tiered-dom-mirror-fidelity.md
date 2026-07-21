---
status: proposed
date: 2026-07-01
---

# Tiered DOM-mirror fidelity: isolated adopted-stylesheet enrichment + opt-in CDP keyframe (no MAIN world)

## Context and Problem Statement

After ADR-0043 fixed transport (heavy pages now cross the wire and reconstruct), a JS-heavy page like Google still painted near-blank. The isolated-world recorder (ADR-0042) captures DOM structure but not the CSS that styles such pages: rrweb records adopted/constructable stylesheets by monkeypatching `CSSStyleSheet` in the page's MAIN world, which the isolated world can't do (prototype patches don't cross realms), and rrweb's snapshot serializer doesn't read `document.adoptedStyleSheets` at keyframe time (rrweb #1567, open July 2026). So the page serialized as structure with no styles → blank.

We proved empirically that the isolated content-script world **can read** `document.adoptedStyleSheets` (+ open shadow roots' sheets) and their rules, and `getComputedStyle` resolves adopted-sheet values — rrweb simply doesn't take them. The genuine residue the isolated world cannot reach is **closed shadow roots** and **canvas/WebGL pixels**; only CDP (which pierces shadow boundaries) or MAIN-world hooks get those.

Goal: close the fidelity gap **without MAIN-world injection** (holding ADR-0042's page-undetectability default), reusing the ADR-0043 compressed `.dom` pipeline and the ADR-0040 tap path, with the host and Swift client staying fully opaque.

## Decision Drivers

- Styled JS-heavy pages must mirror; keep the isolated recorder as the default.
- No MAIN-world content-script injection and no CDP `Runtime.evaluate` (that executes page JS).
- Keep the host + Swift client opaque (they parse only `{t, tb, co}`).
- Password parity (ADR-0041): no capture path may expose a password value rrweb would mask.
- CDP's debugger banner must not be paid by default (ADR-0042 rejected always-on CDP for this reason).

## Considered Options

- **A**: Isolated adopted-stylesheet/open-shadow CSS enrichment only.
- **B**: CDP `DOMSnapshot.captureSnapshot` high-fidelity keyframe only (closed shadow + computed styles), always on.
- **C**: Two additive tiers — A as the default, B as an opt-in / banner-already-paid escalation. (chosen)

## Decision Outcome

Chose **C**: keep rrweb as the live engine and layer two additive tiers over the existing transport.

**Tier A — isolated adopted-stylesheet + open-shadow CSS enrichment (default, no banner).** On each keyframe the isolated recorder reads `document.adoptedStyleSheets` and every open shadow root's `adoptedStyleSheets`, concatenates their rule text, and ships it as a separate compressed `cssz` line (kept off the ADR-0043 `ev` payload, and off the chunked seq-0 line, so it can never push a line past the 2 MB cap; dropped-with-log if itself over `CHUNK_LIMIT`). The replay webview inflates it into a singleton `<style id="agentdesk-adopted">` re-injected after each (async) snapshot rebuild. This closes the Google-blank case with no MAIN world and no banner.

**Tier B — CDP high-fidelity keyframe (opt-in / banner-already-paid).** For the residue Tier A can't reach (closed shadow DOM, and later canvas), the service worker reuses the ADR-0040 `chrome.debugger` attachment to poll `DOMSnapshot.captureSnapshot` (~1.5 s), reconstructs a **self-contained projection** HTML string (computed styles inlined per node so it renders without external/adopted CSS; shadow trees flattened; page scripts/CSS dropped), and ships it as a `k:'cdp'` keyframe through the same compressed/opaque pipeline. The webview renders it into a static overlay iframe above the rrweb replayer, with tap mapping generalized to the active frame. Ordinary content remains visible and **password values are masked in the worker before egress** (`DOMSnapshot` returns raw values), enforced by the `dom-mirror-cdp-verify` test. Tier B engages only when the user opts in via the popup toggle, or the debugger is already attached for a tap (banner already shown) — so the default view-only session stays banner-free. The reconstruction lives in `chrome-extension/cdp-reconstruct.js`, loaded by the worker via `importScripts` and `require`d by the test so the real code is exercised.

This narrows ADR-0042's blanket rejection of CDP (Option C) rather than reversing it: CDP is now a bounded, opt-in escalation, not the default capture path, so the undetectable default is preserved.

### Consequences

- Good: styled JS-heavy pages mirror (Tier A); closed shadow + full computed styles available on demand (Tier B); no MAIN world; host/client unchanged (opaque); no protocol-version bump (experimental, flag-gated, pre-v0).
- Good: `chrome.debugger`'s banner is only paid when the user already accepted it (a tap) or explicitly opts in.
- Bad: Tier B's reconstruction is a nontrivial HTML serializer; a password-classification bug could expose credentials, so the real CDP path has a dedicated password test.
- Bad: Tier B keyframes are coarser (poll cadence) and heavier than rrweb increments; only active in fidelity mode, still compressed + chunked.
- Neutral: adopted-CSS `url()` assets and canvas pixels remain gaps (named non-goals below).

### Confirmation

- `dom-mirror-record-verify` (Tier A): the fixture applies an adopted stylesheet via a same-origin script; asserts the `cssz` line arrives, decompresses to the rule, is compressed on the wire, ordinary content remains visible, and static plus incremental password values stay masked.
- `dom-mirror-cdp-verify` (Tier B): captures a real `DOMSnapshot.captureSnapshot` over a **closed** shadow root via Playwright's CDP session, runs it through the real `reconstructProjectionHtml`, and asserts the closed-shadow subtree is captured, computed styles are inlined, ordinary content remains visible, and password values are masked.
- `dom-mirror-bridge-verify` + `just check` unaffected (host/client opaque).

## Links

- ADR-0038 (dedicated `.dom` QUIC lane; relayed opaquely)
- ADR-0040 (trusted input via chrome.debugger; Tier B reuses the attach + banner)
- ADR-0041 (projection-data audit; password parity enforced in the CDP reconstruction)
- ADR-0042 (isolated-world recorder; MAIN-world constraint held; CDP rejection narrowed to opt-in)
- ADR-0043 (compressed transport; both tiers ride it unchanged)
- CDP `DOMSnapshot.captureSnapshot`; rrweb 2.0.0-alpha.4 (adopted-stylesheet replay support; capture gap #1567)

## Explicit non-goals

- No MAIN-world content-script injection or CDP `Runtime.evaluate` (executes page JS); Tier B uses only passive CDP data commands.
- Canvas/WebGL pixels (reachable via CDP later, same tier; not this pass).
- Adopted-CSS `url()` asset rewriting and host-side asset dedup caching (ADR-0043 non-goal).
