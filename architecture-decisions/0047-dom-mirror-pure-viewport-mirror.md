---
status: accepted
date: 2026-07-02
---

# DOM mirror client is a pure viewport mirror; view changes originate host-side

## Context

The DOM mirror shows a desktop-captured Chrome tab: rrweb replays the tab's DOM as
it rendered at the host viewport's width, and the replay has no live JS (it is a
snapshot plus a mutation stream). Fitting a wide desktop viewport into a tall phone
raised a fork: should the client reflow the page to phone width, or size the iframe
to the full document height and scroll it locally, so the phone's vertical space is
filled ("Path 1")?

Both fail on inspection:

- **Reflow to phone width is unreliable.** Narrowing the replay iframe fires the
  page's mobile media queries against the *desktop* DOM we captured. Many sites
  ship different DOM for mobile (server UA-sniffing or client JS), the replay has no
  live JS to restructure responsive components, and responsive images already chose
  desktop assets. The result is a broken desktop/mobile hybrid, usually worse than a
  clean shrink.
- **Local full-page scroll is a footgun.** Scrolling a captured full-height snapshot
  locally only shows content already in the DOM. Anything that materializes when the
  *real* page scrolls (infinite feeds, lazy images, scroll-triggered sections,
  scroll-spy JS) never appears, because it needs the live tab to scroll and run JS.

## Decision

The client is a **pure viewport mirror**. It renders exactly what the host tab
displays (its viewport, its layout, its scroll position) and never reflows, never
re-renders at a different width, and never scrolls the page on its own. Everything
that changes what is shown originates host-side.

Concretely:

- **Fit:** scale the host viewport to the phone width and letterbox the aspect
  difference. Blank bands where the wide desktop viewport does not fill the tall
  phone are **correct, not a bug**.
- **Scroll / navigation is host-driven.** A phone scroll gesture goes UP the `.dom`
  lane (the same client->host reverse channel as ADR-0040 taps); the real tab
  scrolls, runs its JS, loads dynamic content, and the new state streams back.
  Dynamic pages work because it is always the real page.
- **Local view affordances are transforms, not reflow.** Pinch-zoom + pan on the
  mirrored viewport are allowed: they transform the *view* of what the host shows,
  not the page layout, so they stay inside the invariant.
- **Mobile layout is a host-side decision.** To see a page as mobile, the host
  device-emulates the tab (Chrome device emulation / a mobile emulation window),
  which renders the true mobile layout; returning to the desktop state is a
  host-side toggle. The client still just mirrors whatever the host displays,
  emulated or not.

## Consequences

- Path 1 (client-side reflow / local full-page scroll) is rejected for the reasons
  above; the letterbox and small-text tradeoff of faithful mirroring is accepted,
  and pinch-zoom + pan mitigates readability.
- Dynamic pages (feeds, lazy load, sticky/scroll-spy) behave correctly, because
  scroll drives the real tab rather than a frozen snapshot.
- Two invariant-preserving client slices are enabled and can be built independently:
  **scroll-drive-back** (phone scroll gesture -> host tab scroll, over the `.dom`
  lane) and **pinch-zoom + pan** of the mirrored viewport.
- **True mobile rendering is a separate host-side feature** (device-emulate the
  tab), not a client behavior. This keeps the client trivially simple and correct.
- Any future work that proposes the client re-laying-out, reflowing, or independently
  scrolling page content must revisit this ADR first.

Relates to ADR-0038 (DOM lane), ADR-0040 (client->host reverse channel), ADR-0044
(tiered fidelity), ADR-0046 (diagnostic status line).
