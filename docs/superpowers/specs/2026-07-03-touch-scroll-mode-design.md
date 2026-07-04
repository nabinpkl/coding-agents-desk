# Touch-scroll mode (scroll on the video surface)

Date: 2026-07-03
Status: implemented (client only)

## Problem

The iPhone client scrolls the host through a narrow 60pt right-edge
`scrollStripView`. It is a small target. Users want to scroll on the large
video surface directly.

## Decision

Add a **mode toggle** that relocates the *existing* scroll behavior onto the
video sink. It is not a new scroll model; it is the same scroller on a bigger
target, primed to act where the finger lands.

- **Off (default):** unchanged. Passive video viewer + relative trackpad +
  right-edge strip.
- **On:** a one-finger drag on the desktop image scrolls the host. Two phases:
  1. **Prime on touch-down.** The first touch sends `.cursorSet` to move the
     host cursor to the touched host coordinate, so macOS delivers the scroll
     to the window under that point.
  2. **Then scroll as today.** The drag calls the existing
     `GestureTranslator.processScrollPan` unchanged — same acceleration curve,
     `.began/.changed/.ended` phases, and momentum/inertia tail.

Scope is scroll only: no tap-to-click, no pinch-zoom changes beyond disabling
the scroll view's own pan while the mode is active. Vertical only; direction
follows the existing `scrollInverted` tuning.

## Why no wire or host change

Reuses `.cursorSet` and `.scroll`, both already handled by
`host/AgentDeskHost/InputDispatcher.swift`. `postCursorSet` clamps to display
bounds and drops stale-display sets; `postScroll` exists. The graphics
`scrollFocusHandler` keys off `cursorBase()`, which the prime `cursorSet`
updates, so the copyRect scroll path tracks the touched point for free.

## Components (client only)

- **`EdgeFollow.swift`** — `PointerRetargeting.hostPoint(forSinkLocation:...)`,
  the touch-point inverse of `viewportCenterRetarget`, reusing the same
  `fitScale`/`padX`/`padY` letterbox math but taking a touch location and not
  gated on `zoomScale > 1.0` (must work at rest). Pure, unit-tested.
- **`PairingViewController+TouchScroll.swift`** (new) — owns the
  `InstantPanGestureRecognizer` on `videoSink.view`, the
  `handleVideoTouchScroll` handler (prime on `.began`, then `processScrollPan`),
  and `applyTouchScrollMode` (gate recognizer, `sinkScrollView.isScrollEnabled
  = !on`, dim + disable the relative controls).
- **`SettingsStore.swift`** — persisted `touchScrollMode` bool.
- **`PairingViewController` + `+Layout.swift`** — a `touchScrollToggleButton`
  in the bottom `buttonRow`; recognizer attached in `showTrackpad`.
- **`+Gestures.swift`** — `settingsChanged` calls `applyTouchScrollMode`.
- **`SettingsViewController.swift`** — a discoverability toggle row.

## Coordinate map

The touch is read in the **content view's own coordinate space**
(`gesture.location(in: videoSink.view)`), which UIKit reports pre-transform —
already independent of the scroll view's `zoomScale` and `contentOffset`,
because hit-testing inverts the zoom transform and scroll offset. So the map
needs only the content-view bounds (the aspect-fit letterbox reference) and the
display metadata:

```
fitScale = min(contentViewW/displayW, contentViewH/displayH)
padX = (contentViewW - displayW*fitScale)/2 ; padY = (contentViewH - displayH*fitScale)/2
source = ((loc.x - padX)/fitScale, (loc.y - padY)/fitScale)
clamped = EdgeFollow.advanceCursor(from: source, delta: .zero, displayBounds:)
hostPoint = (display.originX + clamped.x, display.originY + clamped.y)
```

Reading the touch in *scroll-view* space instead and re-applying
`contentOffset`/`zoomScale` double-counts the offset (`location(in: scroll)`
already returns absolute zoomed-content coords), which drove the cursor to the
display's far edge when zoomed — the "jumps to the bottom" bug. Confirmed by
on-device instrumentation and covered by `hostPointBeyondVideoClampsToDisplayBounds`.

## Edge cases

- Missing `DesktopState` / zero display bounds → inverse map returns nil → the
  touch is swallowed (no prime, no scroll).
- Stale display id → host drops the `cursorSet` (logged); scroll lands where
  the cursor was and self-corrects on the next touch-down.
- Toggled mid-drag → recognizer `isEnabled=false` cancels it; the strip's
  `.cancelled` path emits `.scroll(phase:.ended)`.
- Scroll events route through `sendPointerAwareInput`; the handler clears
  `pendingCursorRetarget` on `.began` so a stale viewport retarget cannot
  override the prime.

## Known limitation (target-side, not this pipeline)

Reversing scroll direction out of an overscrolled boundary (e.g. scroll to the
bottom, then scroll back up) is inert in **Electron/Chromium** target windows
(the Claude desktop app). This is not specific to touch-scroll — the right-edge
strip behaves identically, because both feed the same `postScroll` path. Host
`postScroll` traces confirm the pipeline emits well-formed continuous-scroll
events (correct `began/changed/ended` phases, `isContinuous=1`, correctly-signed
up-deltas at the boundary); Chromium's scroll-latching swallows them anyway.
Native macOS apps reverse out of the boundary correctly, so this is target-app
behavior. Hardening applied while confirming this (`isContinuous=1`, resetting
`scrollRemainder` at gesture delimiters) is retained as correctness, but does not
change the Electron behavior.

## Testing

`EdgeFollowTests`: `hostPoint(forSinkLocation:)` at zoom 1.0 and >1.0, with
letterbox padding on each axis; viewport-center touch agrees with
`viewportCenterRetarget`; out-of-bounds touch clamps; nil on missing geometry.
Scroll behavior is covered by the strip's existing `processScrollPan` tests,
reused unchanged.
