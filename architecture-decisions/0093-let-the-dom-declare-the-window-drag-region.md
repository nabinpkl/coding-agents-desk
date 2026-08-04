---
status: accepted
date: 2026-08-04
---

# Let the DOM declare the window drag region, and keep the native side to performing the drag

## Context and Problem Statement

The Agents window is `fullSizeContentView` with a transparent title bar, so the React header in
`packages/AgentPanel/Web/src/app/AgentPanelApp.tsx` draws into the area a platform title bar would
occupy. WebKit consumes the background mouse events `NSWindow.isMovableByWindowBackground` acts on,
so that flag cannot move the window and the header's empty space was inert. The previous mechanism
was a single 32x24pt native `NSView` (`AgentWindowTitlebarDragView`) parked after the header's
leading control, positioned by native constants that mirrored the web button's width and gap and
were rescaled on every page zoom. It covered a sliver of a 44pt-tall, full-width header, and any
change to the header's controls silently invalidated its position.

## Decision Drivers

- The draggable area must be the header's actual inert space, and stay correct as the header gains
  or loses controls, changes title length, pins or unpins the sidebar, and zooms.
- One shared web bundle serves both the macOS host and the iOS client; the bundle must not carry a
  platform branch, and iOS must take no behavior from this.
- Controls in the title bar must keep their clicks. A drag region that swallows them is worse than
  no drag region.
- No second source of truth for header geometry. The mirrored native constants were the defect.

## Considered Options

- **Option A**: Grow the native overlay to the full header strip and cut holes for controls by
  having the web publish no-drag rectangles that native hit-tests synchronously.
- **Option B**: Let the DOM hit-test the press and ask native to start the drag over a script
  message channel.
- **Option C**: Replace the web header with a native AppKit title bar on macOS.

## Decision Outcome

Chose **Option B**. The DOM already knows, exactly and continuously, which of its own pixels are
inert; publishing that as geometry (Option A) reintroduces the mirrored-state problem the change
exists to remove, and adds a rectangle cache that is wrong for a frame after every layout change.
Option C satisfies correctness but breaks the one-shared-bundle driver, forking the header for a
platform that renders it identically today. Option B keeps hit-testing in the layer that owns the
layout and leaves native with only the part that must be native: turning a live `NSEvent` into
`NSWindow.performDrag(with:)`. This is also the idiom WKWebView-hosting frameworks converge on;
Tauri's `data-tauri-drag-region` resolves to the same `performWindowDragWithEvent:` call.

Concretely: the web marks a header `data-window-drag`, `windowDrag.ts` decides on mouse-down whether
the press landed on background or on a control, and calls `window.__agentDeskBeginWindowDrag()`.
That global is installed by the host's `AgentWindowPanelChrome` user script, so its absence is the
platform check; iOS defines nothing and the bundle does nothing. `WebPanelWebViewController` grew an
`additionalMessageHandlers` seam so a container can own chrome channels without them becoming panel
requests in the cross-platform `AgentPanelRequest` enum.

### Consequences

- Good, because the draggable area is now the whole inert header on both the thread header and the
  pinned sidebar header, and it follows any future header change with no native edit.
- Good, because the native side lost all mirrored geometry: `dragRegionWidth`, `dragRegionHeight`,
  `leadingControlWidth`, `leadingControlGap`, `dragRegionLeading`, and the zoom-rescaled constraint.
  The only remaining native title-bar measurement is the traffic-light inset, which is genuinely
  native state.
- Good, because control exclusion is a capability list (`button`, `a[href]`, `input`, `[role=button]`,
  ...) rather than a list of the header's current buttons, so a control added later is excluded
  without anyone remembering this decision.
- Bad, because the drag starts one web-process round trip after the press, and the native side reads
  `NSApp.currentEvent` rather than the originating event. A press released inside that window
  produces no drag; it is logged at `notice` rather than silently dropped.
- Neutral, because the title bar no longer selects text, matching a platform title bar. This is
  enforced by `user-select: none` on `[data-window-drag]` and applies on iOS too.

### Confirmation

`windowDrag.test.ts` covers the hit-testing contract, including icon-inside-button targets, the
no-drag opt-out, capture-phase survival against a control that stops propagation, and the
no-native-host case. `AgentWindowZoomTests.theWebTitleBarReachesTheNativeWindowOverTheChromeChannel`
pins the injected global's name, the channel name, and command decoding, which is the wire the web
and native sides mirror by hand. `WebPanelWebViewController` precondition-fails if a container
registers a handler name that collides with the contract or diagnostics channel.

## Links

- ADR-0086 agent feed views
- `host/AgentDeskHost/AgentWindow/AgentWindowTitlebar.swift`, `packages/AgentPanel/Web/src/app/windowDrag.ts`
- [Tauri window customization](https://v2.tauri.app/learn/window-customization/) (no date verifiable)
