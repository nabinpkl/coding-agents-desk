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

Touch location in `sinkScrollView` viewport coords → host global point:

```
contentX = contentOffset.x + loc.x ;  contentY = contentOffset.y + loc.y
sinkX = contentX / zoomScale       ;  sinkY = contentY / zoomScale
source = ((sinkX - padX)/fitScale, (sinkY - padY)/fitScale)
clamped = EdgeFollow.advanceCursor(from: source, delta: .zero, displayBounds:)
hostPoint = (display.originX + clamped.x, display.originY + clamped.y)
```

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

## Testing

`EdgeFollowTests`: `hostPoint(forSinkLocation:)` at zoom 1.0 and >1.0, with
letterbox padding on each axis; viewport-center touch agrees with
`viewportCenterRetarget`; out-of-bounds touch clamps; nil on missing geometry.
Scroll behavior is covered by the strip's existing `processScrollPan` tests,
reused unchanged.
