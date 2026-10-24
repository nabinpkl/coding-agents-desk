# Pinch-to-zoom inside touch-scroll mode

Date: 2026-07-03
Status: designed (client only)
Supersedes the pinch-zoom claim in `2026-07-03-touch-scroll-mode-design.md`.

## Problem

Touch-scroll mode (one-finger drag on the video surface scrolls the host)
currently kills pinch-to-zoom. Two independent causes, both verified in code:

1. `applyTouchScrollMode` sets `sinkScrollView.isScrollEnabled = false`. On
   `UIScrollView` that disables the whole gesture stack, zoom included.
2. The touch-scroll recognizer is an `InstantPanGestureRecognizer` on
   `videoSink.view` that forces `.began` on the *first* touch-down. The first
   finger of a two-finger pinch therefore fires a `.cursorSet` prime + host
   `scroll(.began)` before the second finger lands, and — with no delegate
   wiring simultaneous recognition — the already-begun single-finger pan blocks
   the scroll view's pinch.

The prior design doc's line "no pinch-zoom changes beyond disabling the scroll
view's own pan" is false as written; this doc corrects it.

## Decision

A **finger-count state machine** on the video surface while touch mode is on:

- **One finger** = scroll the host, at every zoom level. Never pans the local
  view, never zooms. (Unchanged touch-scroll behavior.)
- **Two fingers** = behave exactly as touch-mode-off: native `UIScrollView`
  pinch-to-zoom and pan-while-pinched.

To reposition a magnified view the user keeps two fingers down; one finger
always scrolls the host. This is the literal, most consistent reading of "one
finger = no pan no zoom."

## Approach: native finger-count split

Lean on `UIScrollView`'s native zoom rather than reimplementing it. Two
mechanisms combine to route by finger count:

### 1. Scroll view: two-finger-only

In `applyTouchScrollMode`, when touch mode is ON:

- `sinkScrollView.isScrollEnabled = true` — keep it on so pinch/zoom stays
  alive. (Do **not** set it false; that was cause #1.)
- `sinkScrollView.panGestureRecognizer.minimumNumberOfTouches = 2` — the scroll
  view then responds only to two-finger gestures (pinch + pan-while-pinched) and
  never pans on one finger.
- `touchScrollRecognizer.isEnabled = true`.

When OFF, restore today's behavior exactly:

- `sinkScrollView.panGestureRecognizer.minimumNumberOfTouches = 1`
- `touchScrollRecognizer.isEnabled = false`
- (`isScrollEnabled` stays true either way now.)

The trackpad/strip dimming is unchanged.

### 2. Touch-scroll recognizer: standard pan, one touch max

Swap the `InstantPanGestureRecognizer` for a **standard `UIPanGestureRecognizer`
with `maximumNumberOfTouches = 1`**. A standard pan waits for slop (a few px of
movement) before `.began`, and that wait is what distinguishes a scroll from a
pinch:

- **One-finger scroll:** finger moves → crosses slop → `.began` → prime +
  `processScrollPan`. The slop is imperceptible; the video surface does not need
  the strip's instant 1:1 feel.
- **Two-finger pinch:** the second finger lands before the first crosses the
  one-finger slop; `maximumNumberOfTouches = 1` fails the pan before `.began`, so
  **no prime, no phantom host scroll**, and the pinch runs clean.
- **Finger added mid-scroll:** the pan already reached `.began`, so it
  **cancels**; the existing `.cancelled` path emits `scroll(phase:.ended)` and
  the pinch/two-finger pan take over.

`handleVideoTouchScroll` is otherwise unchanged: it still primes on `.began`
from content-view-space coords (the `dbee771` fix) and clears
`pendingCursorRetarget`.

## Why no wire or host change

Same as the base feature: reuses `.cursorSet` + `.scroll`, both handled by the
host. Zoom is local-only (`UIScrollView`), unchanged from R21. The touch-scroll
prime already maps correctly at any zoom scale because it reads content-view
space.

## Unchanged

Prime coordinate math, `GestureTranslator.processScrollPan`, `EdgeFollow` /
`applyEdgeFollow`, `handleSinkDoubleTap` (a tap, coexists), the host
`InputDispatcher`, and the wire. Still client-only.

## Components (client only)

- **`PairingViewController+TouchScroll.swift`**
  - `attachTouchScrollRecognizer` — construct a standard
    `UIPanGestureRecognizer` (not `InstantPanGestureRecognizer`),
    `maximumNumberOfTouches = 1`, `minimumNumberOfTouches = 1`.
  - `applyTouchScrollMode` — set `panGestureRecognizer.minimumNumberOfTouches`
    to 2 (on) / 1 (off); keep `isScrollEnabled = true`; gate the recognizer.
- No new files, settings, or buttons.

## Edge cases

- Simultaneous two-finger tap → pan never begins → straight to zoom.
- Toggle mode mid-drag → recognizer `isEnabled=false` cancels → `scroll(.ended)`;
  `applyTouchScrollMode` also restores `minimumNumberOfTouches = 1`.
- Missing `DesktopState` / zero display bounds → prime returns nil → touch
  swallowed (unchanged).
- Simultaneous recognition: the touch-scroll pan and the scroll view's pinch are
  mutually exclusive by finger count (the pan fails/cancels as the pinch begins),
  so **no `shouldRecognizeSimultaneously` delegate is expected to be needed**.
  This is the one item to confirm on-device; if a pinch ever fails to start while
  a finger is mid-scroll, the fix is a `UIGestureRecognizerDelegate` allowing the
  pinch to recognize simultaneously with (or require failure of) the pan.

## Testing

- Unit: `applyTouchScrollMode` sets `panGestureRecognizer.minimumNumberOfTouches`
  to 2 when on and 1 when off, and leaves `isScrollEnabled == true` in both; the
  touch-scroll recognizer's `isEnabled` tracks the mode. The recognizer is a
  plain `UIPanGestureRecognizer` with `maximumNumberOfTouches == 1`.
- Prime and scroll behavior are already covered by existing `EdgeFollow` /
  `processScrollPan` tests, reused unchanged.
- The two-finger → zoom hand-off and the pinch-does-not-prime behavior are a
  device-feel check (a physical-device run), not a unit test.

## Doc cleanup

Correct the false line in `2026-07-03-touch-scroll-mode-design.md` (the
"Scope is scroll only ... disabling the scroll view's own pan" sentence) to
point at this doc for the finger-count model.
