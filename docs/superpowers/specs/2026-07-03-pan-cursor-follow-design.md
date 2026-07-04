# Host cursor follows the client cursor on a zoomed pan

Date: 2026-07-03
Status: designed (client only)

## Problem

When the desktop is zoomed (`zoomScale > 1`) and the user pans the video
surface, the **content slides but the host cursor does not follow**. The client
cursor dot is anchored to a source-display point and pinned on screen, so as the
content slides under it the dot points at a *new* desktop location every frame —
but the host is never told. The host cursor only moves via two paths today:
relative `.cursorMove` (the trackpad) and one-shot `.cursorSet` primes
(touch-scroll, viewport-center snap). A pan is neither, so the host cursor lags
behind wherever the user just panned to.

The existing behavior is worse than "does nothing": at pan-end
`finishManualViewportPan` fires a single `.cursorSet` to **viewport center**,
so the host cursor *jumps* to the middle of the panned view rather than tracking
the dot.

## Decision (Option E: reconcile + overscroll edge push)

Continuously reconcile the host cursor to the dot during a manual pan, and use
iOS rubber-band overscroll to reach the display edges that plain reconciliation
cannot.

- **Trigger:** a manual drag on the sink scroll view while `zoomScale > 1`
  (`scrollViewWillBeginDragging`), any finger count, **irrespective of touch-
  scroll mode**. At `zoomScale == 1` the content fits and there is no pan.
- **Anchor:** at drag start, capture the dot's current *viewport* position and
  hold it fixed for the gesture. The dot stays put on screen; the content slides
  beneath it.
- **Interior reconcile (`scrollViewDidScroll`):** each frame, reproject the
  fixed anchor through the live `contentOffset` to the source point now under
  it, set `cursorSourcePos`, reposition the dot, and send a throttled
  `.cursorSet` to the host. **Pointer only** — no scroll or zoom is emitted.
- **Edge push (overscroll):** plain reconciliation of a fixed viewport point
  cannot reach the outer `W/2z` of the display, because the viewport pins at its
  content edge while still a half-window short of the true edge (at 2× that is
  25% of the display unreachable on each side). When the user keeps dragging
  past the boundary, iOS rubber-bands `contentOffset` beyond `[0, maxOffset]`.
  That signed overscroll drives a bounded push that carries the cursor the
  remaining margin to the true edge (`0` or `W`). No raw-gesture snooping and no
  accumulation — the overscroll magnitude *is* the surplus.
- **Freeze at finger-lift:** on `scrollViewDidEndDragging` stop reconciling, so
  momentum glide and bounce-back frames are ignored and the cursor stays where
  the user aimed it. This is a pointing gesture: on lift, the pointer holds.
- **Remove the center snap:** `finishManualViewportPan` no longer sets a
  viewport-center `pendingCursorRetarget`; the continuous reconcile has already
  kept the host cursor under the dot, and the snap would fight it.

### Why not the alternatives

- **Pure reconciliation (`.cursorSet` only), no edge push** — leaves the outer
  `W/2z` unreachable at every zoom (50% of the display at 2×). Disqualifying.
- **Option D (drag *moves the pointer*, viewport chases via edge-follow)** —
  reaches every pixel and reuses the trackpad path, but inverts the felt model:
  the interior 76% of the viewport becomes a dead zone for scrolling (the view
  only follows once the pointer reaches the outer 12% edge band), so "grab and
  slide the content" no longer works. The user's intent is content-drag with the
  cursor tagging along, which is E.

## Why no wire or host change

Reuses `.cursorSet`, already handled by `InputDispatcher.postCursorSet`, which
clamps to display bounds and drops stale-display sets. The host integrates
nothing new. `advanceCursor` (the client's mirror of the host's
current+delta+clamp pipeline) is reused to clamp the reconciled source into the
display rect, so client and host stay in lockstep without a return push.

## Components (client only)

- **`EdgeFollow.swift` / `PointerRetargeting`** — two new pure functions:
  - `viewportPoint(forSource:displayBounds:sinkViewSize:zoomScale:contentOffset:)`
    → the dot's viewport position for a source point (the drag-start anchor).
  - `panFollowRetarget(anchorViewportPoint:state:displayId:displayBounds:
    sinkViewSize:zoomScale:contentOffset:edgeReachOverscroll:)` →
    `CursorViewportRetarget?` — interior reconcile plus the overscroll edge push,
    per axis, clamped into the display via `advanceCursor`. Pure, unit-tested.
  - `viewportCenterRetarget` is **removed** (its only caller, the center snap,
    is retired), along with its two tests.
- **`PairingViewController+EdgeFollow.swift`** — a new `scrollViewDidScroll`
  drives the reconcile while `panFollowActive`; `scrollViewWillBeginDragging`
  captures the anchor; `scrollViewDidEndDragging` freezes; `finishManualViewport
  Pan` drops the center snap.
- **`PairingViewController.swift`** — three stored properties: `panFollowActive:
  Bool`, `panFollowAnchor: CGPoint?`, `lastSentPanFollowHostPoint: CGPoint?`,
  reset alongside `isManualViewportPanActive` in the teardown paths.

## Coordinate map

At zoom `z`, letterbox pad `pad`, aspect-fit `fitScale`, a fixed viewport anchor
`a` and live `contentOffset` `o` clamped to the scrollable range:

```
clamped   = clamp(o, 0, maxOffset);  overscroll = o - clamped   (signed)
sink      = (a + clamped) / z
base      = (sink - pad) / fitScale                             (interior source)
# edge push toward the near display edge, gained by overscroll:
frac      = min(1, |overscroll| / edgeReachOverscroll)
source    = overscroll > 0 ? base + frac*(W - base)             (toward W)
                           : base - frac*base                   (toward 0)
clampedSrc = advanceCursor(source, .zero, displayBounds)        (into [0, W-1])
hostPoint  = (display.originX + clampedSrc.x, display.originY + clampedSrc.y)
```

In the interior `overscroll == 0`, so `source == base` (pure reconcile). The
identity `panFollowRetarget(viewportPoint(s), o)` returns `s` when `o` is in
range — the anchor round-trips.

## Edge cases

- `zoomScale <= 1` / zero display bounds / missing `DesktopState` → helper
  returns nil → no reconcile.
- Simultaneous pinch + pan: the anchor is captured at the start zoom; the
  reconcile uses the live zoom each frame. The mapping stays sensible (the
  anchor is a zoom-independent viewport coordinate); precise tracking during a
  concurrent zoom is a known minor imperfection, not a correctness bug.
- Momentum / bounce after lift: ignored by design (frozen). The dot may lag the
  glide and resettle on the next cursor/desktop push; acceptable for v0.
- `edgeReachOverscroll` (default 44pt) is the overscroll at which the cursor
  reaches the true edge — a device-feel tuning constant, since iOS damps
  rubber-band travel.

## Testing

`EdgeFollowTests`, pure, no UIKit:
- interior center anchor equals a manual reprojection; off-center anchor too;
- `viewportPoint` then `panFollowRetarget` round-trips to the same source;
- at `maxOffset` with no overscroll the source pins at the margin (not the edge);
- overscroll ≥ `edgeReachOverscroll` clamps the source to the true edge;
- partial overscroll lands proportionally between margin and edge;
- negative overscroll drives toward `0`;
- `zoomScale <= 1` and missing geometry return nil.

Device-feel verification (user-gated) covers: interior content-drag with the
host cursor tracking the dot; reaching all four display edges by pushing past
the boundary; the cursor holding position on finger-lift; and no center-snap
jump at pan-end.
