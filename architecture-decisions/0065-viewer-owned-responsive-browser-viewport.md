---
status: accepted
date: 2026-07-21
supersedes: ADR-0048
---

# Let the last active Browser viewer own Chrome's projected viewport

## Context

ADR-0047 requires the projection to mirror Chrome's real layout. ADR-0048 implemented that rule with
one iOS-only Desktop or Mobile command, but it could not represent a resizable macOS viewer, multiple
viewers, custom source dimensions, or safe restoration when Browser was no longer visible. The shared
macOS and iOS shell introduced by ADR-0064 needs one source-viewport authority rather than independent
device toggles.

## Decision

The host owns a viewport coordinator keyed by the local macOS viewer and authenticated remote device
fingerprints. Active viewers cache a profile (`desktop` or `mobile`), sizing mode (`viewer`, `custom`,
or `preset`), and a bounded CSS-pixel size. A claim updates activation order. The last activated active
viewer owns Chrome, passive geometry changes do not steal ownership, and releasing an owner promotes
the most recently activated remaining viewer. Releasing the last viewer pauses recording and restores
Chrome's native metrics, user agent, and touch behavior.

The owner sends one host-generated `browser-source-viewport` command containing a host epoch,
monotonic revision, current tab and generation, and the resolved source request. The extension rejects
stale epochs, revisions, targets, and dimensions. It stops the recorder, advances generation, applies
Chrome DevTools Protocol metrics, user-agent, and touch overrides, reads the actual layout viewport,
then restarts the one recorder. Application failure clears the projected page and becomes explicit
viewport state. Metrics are applied before recording after tab changes and navigation.

The shared BrowserProjection webview supplies Desktop (1440 by 900), Mobile (390 by 844), custom
responsive dimensions, and Reset to Viewer. macOS initially uses desktop identity at its content-stage
size. iOS initially uses mobile identity at its content-stage size. Viewer-linked resize uses a trailing
150 ms debounce and an explicit end-of-resize flush.

Fit, zoom, and pan are local presentation transforms shared by rrweb and CDP snapshots. They do not
change Chrome or projection generation. At magnified zoom, dragging pans locally. Otherwise dragging
scrolls the real tab. Tap and scroll coordinates are derived from the transformed surface rectangle.

Protocol 13 adds `browser-viewer-state` on the authenticated DOM lane and targeted
`browser-viewer-status`. The host derives remote identity from the authenticated session. The earlier
`dom-emulate`, direct `dom-capture`, batch `em`, and `DomStatus.emulated` contracts are removed rather
than retained as compatibility paths. The extension version becomes 0.9.0.

## Consequences

- The visible viewer determines responsive layout without focusing, raising, moving, or resizing a
  Chrome window.
- Multiple viewers retain their own requested mode while one source owner controls Chrome.
- Requested and actual source dimensions can differ for legacy mobile pages and are both displayed.
- One recorder and one debugger attachment remain the resource boundary.
- ADR-0047's pure-mirror invariant remains: source reflow happens in Chrome; local zoom is only a view
  transform.

Relates to ADR-0038, ADR-0040, ADR-0047, ADR-0063, and ADR-0064.
