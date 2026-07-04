# Host Cursor Follows a Zoomed Pan (Option E) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** During a manual pan of the zoomed video surface, continuously move the
host cursor so it follows the client cursor dot, reaching the display edges via
iOS overscroll.

**Architecture:** Two new pure functions on `PointerRetargeting` do all the
geometry (interior reconcile + overscroll edge push); the view controller wires
them into the existing `UIScrollViewDelegate` pan lifecycle and emits throttled
`.cursorSet`. No wire or host change.

**Tech Stack:** Swift, UIKit (`UIScrollViewDelegate`), Swift Testing, `just`.

## Global Constraints

- Client-only. **No host change, no wire change** — reuse `.cursorSet`.
- Pointer-only: never emit `.scroll` or change zoom from this path.
- Works **irrespective of touch-scroll mode**; only active at `zoomScale > 1`.
- Pure geometry lives in `EdgeFollow.swift`; UIKit delegate methods stay thin
  (the codebase's testable-seam pattern).
- Client gate is `just sim-test` (not `just check`); full gate `just check-all`.
- New source/test files auto-compile via buildable folders — no pbxproj edits.
- Auto-commit each green task to `origin/main`.

---

### Task 1: Pure pan-follow geometry (`viewportPoint` + `panFollowRetarget`)

**Files:**
- Modify: `client/AgentDeskClient/EdgeFollow.swift` (add two static funcs to
  `PointerRetargeting`; remove `viewportCenterRetarget`)
- Test: `client/AgentDeskClientTests/EdgeFollowTests.swift`

**Interfaces:**
- Consumes: `CursorViewportRetarget` (unchanged), `EdgeFollow.advanceCursor`,
  `DesktopState`.
- Produces:
  - `PointerRetargeting.viewportPoint(forSource:displayBounds:sinkViewSize:
    zoomScale:contentOffset:) -> CGPoint?`
  - `PointerRetargeting.panFollowRetarget(anchorViewportPoint:state:displayId:
    displayBounds:sinkViewSize:zoomScale:contentOffset:edgeReachOverscroll:)
    -> CursorViewportRetarget?`

- [ ] **Step 1: Write the failing tests**

Add to `EdgeFollowTests.swift`. The existing tests inline `DesktopState`
construction (see `viewportCenterRetargetProjectsThroughZoomAndPadding`); add
this one small fixture helper to the test type so the new tests read cleanly, and
`DisplayMetadata` uses `widthPoints`/`heightPoints`:

```swift
static func singleDisplayState(
    id: String, width: CGFloat, height: CGFloat, originX: Int, originY: Int
) -> DesktopState {
    DesktopState(
        displays: [DisplayMetadata(
            id: id, originX: originX, originY: originY,
            widthPoints: Int(width), heightPoints: Int(height))],
        spaces: [], activeDisplayId: id, selectedDisplayId: id,
        activeSpaceId: nil, cursorX: nil, cursorY: nil)
}
```

Verify `DisplayMetadata`'s init labels/types against the existing tests before
relying on them; match them exactly (`originX`/`originY` are `Int`,
`widthPoints`/`heightPoints` are `Int`).

```swift
@Test func viewportPointRoundTripsThroughPanFollowInInterior() {
    let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
    let sink = CGSize(width: 400, height: 240)   // same aspect => no letterbox
    let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
    let source = CGPoint(x: 640, y: 300)
    let zoom: CGFloat = 2.0
    let offset = CGPoint(x: 150, y: 90)          // inside scrollable range

    let anchor = PointerRetargeting.viewportPoint(
        forSource: source, displayBounds: bounds, sinkViewSize: sink,
        zoomScale: zoom, contentOffset: offset)
    #expect(anchor != nil)

    let back = PointerRetargeting.panFollowRetarget(
        anchorViewportPoint: anchor!, state: state, displayId: "d1",
        displayBounds: bounds, sinkViewSize: sink, zoomScale: zoom,
        contentOffset: offset, edgeReachOverscroll: 44)
    #expect(back != nil)
    #expect(abs(back!.sourcePoint.x - source.x) < 0.001)
    #expect(abs(back!.sourcePoint.y - source.y) < 0.001)
}

@Test func panFollowInteriorPinsAtMarginWithoutOverscroll() {
    let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
    let sink = CGSize(width: 400, height: 240)
    let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
    let zoom: CGFloat = 2.0
    // Centre anchor, offset pinned at the right/bottom scrollable max.
    let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
    let maxOffset = CGPoint(x: sink.width * zoom - sink.width,
                            y: sink.height * zoom - sink.height)
    let r = PointerRetargeting.panFollowRetarget(
        anchorViewportPoint: anchor, state: state, displayId: "d1",
        displayBounds: bounds, sinkViewSize: sink, zoomScale: zoom,
        contentOffset: maxOffset, edgeReachOverscroll: 44)!
    // Centre reaches W - W/2z = 1000 - 250 = 750, NOT the 999 edge.
    #expect(abs(r.sourcePoint.x - 750) < 0.5)
    #expect(r.sourcePoint.x < 999)
}

@Test func panFollowOverscrollReachesTheFarEdge() {
    let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
    let sink = CGSize(width: 400, height: 240)
    let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
    let zoom: CGFloat = 2.0
    let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
    let maxOffset = CGPoint(x: sink.width * zoom - sink.width,
                            y: sink.height * zoom - sink.height)
    // Push a full edgeReachOverscroll past the right/bottom max.
    let over = CGPoint(x: maxOffset.x + 44, y: maxOffset.y + 44)
    let r = PointerRetargeting.panFollowRetarget(
        anchorViewportPoint: anchor, state: state, displayId: "d1",
        displayBounds: bounds, sinkViewSize: sink, zoomScale: zoom,
        contentOffset: over, edgeReachOverscroll: 44)!
    #expect(abs(r.sourcePoint.x - 999) < 0.5)   // advanceCursor clamps to W-1
    #expect(abs(r.sourcePoint.y - 599) < 0.5)
}

@Test func panFollowNegativeOverscrollReachesZeroEdge() {
    let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
    let sink = CGSize(width: 400, height: 240)
    let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
    let zoom: CGFloat = 2.0
    let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
    let over = CGPoint(x: -44, y: -44)          // past the 0 boundary
    let r = PointerRetargeting.panFollowRetarget(
        anchorViewportPoint: anchor, state: state, displayId: "d1",
        displayBounds: bounds, sinkViewSize: sink, zoomScale: zoom,
        contentOffset: over, edgeReachOverscroll: 44)!
    #expect(abs(r.sourcePoint.x - 0) < 0.5)
    #expect(abs(r.sourcePoint.y - 0) < 0.5)
}

@Test func panFollowPartialOverscrollLandsBetweenMarginAndEdge() {
    let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
    let sink = CGSize(width: 400, height: 240)
    let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
    let zoom: CGFloat = 2.0
    let anchor = CGPoint(x: sink.width / 2, y: sink.height / 2)
    let maxOffset = CGPoint(x: sink.width * zoom - sink.width, y: 0)
    let over = CGPoint(x: maxOffset.x + 22, y: 0)   // half of edgeReachOverscroll
    let r = PointerRetargeting.panFollowRetarget(
        anchorViewportPoint: anchor, state: state, displayId: "d1",
        displayBounds: bounds, sinkViewSize: sink, zoomScale: zoom,
        contentOffset: over, edgeReachOverscroll: 44)!
    // base 750, remaining 250, frac 0.5 => 750 + 125 = 875.
    #expect(abs(r.sourcePoint.x - 875) < 0.5)
}

@Test func panFollowReturnsNilWhenNotZoomed() {
    let bounds = CGRect(x: 0, y: 0, width: 1000, height: 600)
    let sink = CGSize(width: 400, height: 240)
    let state = Self.singleDisplayState(id: "d1", width: 1000, height: 600, originX: 0, originY: 0)
    #expect(PointerRetargeting.panFollowRetarget(
        anchorViewportPoint: .zero, state: state, displayId: "d1",
        displayBounds: bounds, sinkViewSize: sink, zoomScale: 1.0,
        contentOffset: .zero, edgeReachOverscroll: 44) == nil)
}
```

If `Self.singleDisplayState(...)` does not already exist in the test file, add a
small helper mirroring how the existing `viewportCenterRetarget` tests built
their `DesktopState`; reuse that exact construction so the fixture matches.

- [ ] **Step 2: Run tests to verify they fail**

Run: `just sim-test`
Expected: FAIL — `panFollowRetarget` / `viewportPoint` are undefined.

- [ ] **Step 3: Add the two pure functions; remove `viewportCenterRetarget`**

In `EdgeFollow.swift`, inside `enum PointerRetargeting`, delete
`viewportCenterRetarget(...)` and add:

```swift
    // The dot's viewport position for a source-display point, at the given
    // zoom/offset. Used to capture the fixed pan anchor at drag start.
    static func viewportPoint(
        forSource source: CGPoint,
        displayBounds: CGRect,
        sinkViewSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CGPoint? {
        guard displayBounds.width > 0, displayBounds.height > 0,
              sinkViewSize.width > 0, sinkViewSize.height > 0,
              zoomScale > 0 else { return nil }
        let fitScale = min(sinkViewSize.width / displayBounds.width,
                           sinkViewSize.height / displayBounds.height)
        guard fitScale > 0 else { return nil }
        let padX = (sinkViewSize.width - displayBounds.width * fitScale) / 2
        let padY = (sinkViewSize.height - displayBounds.height * fitScale) / 2
        let contentX = (padX + source.x * fitScale) * zoomScale
        let contentY = (padY + source.y * fitScale) * zoomScale
        return CGPoint(x: contentX - contentOffset.x, y: contentY - contentOffset.y)
    }

    // Continuous pan-follow (Option E). During a manual viewport pan the dot is
    // held at a fixed viewport anchor while the content slides beneath it; this
    // reprojects that anchor through the live contentOffset to the source point
    // now under it, so the host cursor can be reconciled to follow the pan.
    // Overscroll past the scrollable range (iOS rubber-band) drives an edge
    // push that carries the cursor the final unreachable margin (W/2z) to the
    // true display edge — the part plain reconciliation cannot reach.
    static func panFollowRetarget(
        anchorViewportPoint anchor: CGPoint,
        state: DesktopState?,
        displayId: String?,
        displayBounds: CGRect,
        sinkViewSize: CGSize,
        zoomScale: CGFloat,
        contentOffset: CGPoint,
        edgeReachOverscroll: CGFloat = 44
    ) -> CursorViewportRetarget? {
        guard let state,
              let displayId,
              let display = state.displays.first(where: { $0.id == displayId }),
              displayBounds.width > 0,
              displayBounds.height > 0,
              sinkViewSize.width > 0,
              sinkViewSize.height > 0,
              zoomScale > 1.0 else {
            return nil
        }
        let fitScale = min(sinkViewSize.width / displayBounds.width,
                           sinkViewSize.height / displayBounds.height)
        guard fitScale > 0 else { return nil }
        let padX = (sinkViewSize.width - displayBounds.width * fitScale) / 2
        let padY = (sinkViewSize.height - displayBounds.height * fitScale) / 2
        let maxOffsetX = max(0, sinkViewSize.width * zoomScale - sinkViewSize.width)
        let maxOffsetY = max(0, sinkViewSize.height * zoomScale - sinkViewSize.height)

        // Per-axis: interior reconcile of the fixed anchor, then an
        // overscroll-gained push toward the near display edge.
        func axis(anchor: CGFloat, offset: CGFloat, maxOffset: CGFloat,
                  pad: CGFloat, span: CGFloat) -> CGFloat {
            let clamped = min(max(0, offset), maxOffset)
            let overscroll = offset - clamped               // signed; 0 interior
            let sink = (anchor + clamped) / zoomScale
            let base = (sink - pad) / fitScale
            guard overscroll != 0, edgeReachOverscroll > 0 else { return base }
            let frac = min(1, abs(overscroll) / edgeReachOverscroll)
            return overscroll > 0 ? base + frac * (span - base)
                                  : base - frac * base
        }

        let source = CGPoint(
            x: axis(anchor: anchor.x, offset: contentOffset.x, maxOffset: maxOffsetX,
                    pad: padX, span: displayBounds.width),
            y: axis(anchor: anchor.y, offset: contentOffset.y, maxOffset: maxOffsetY,
                    pad: padY, span: displayBounds.height))
        let clamped = EdgeFollow.advanceCursor(
            from: source, delta: .zero, displayBounds: displayBounds)
        return CursorViewportRetarget(
            displayId: displayId,
            sourcePoint: clamped,
            hostPoint: CGPoint(
                x: CGFloat(display.originX) + clamped.x,
                y: CGFloat(display.originY) + clamped.y))
    }
```

Then delete the two `viewportCenterRetarget*` tests from `EdgeFollowTests.swift`
(they cover a removed function).

- [ ] **Step 4: Run tests to verify they pass**

Run: `just sim-test`
Expected: PASS — new pan-follow tests green, no reference to the removed
`viewportCenterRetarget` remains.

- [ ] **Step 5: Commit**

```bash
git add client/AgentDeskClient/EdgeFollow.swift client/AgentDeskClientTests/EdgeFollowTests.swift
git commit -m "feat(client): pan-follow projection with overscroll edge push

Pure geometry for reconciling the host cursor to the client dot during a
zoomed pan: interior anchor reprojection plus a rubber-band overscroll push
that reaches the outer W/2z margin plain reconciliation can't. Retires the
now-unused viewport-center retarget.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire pan-follow into the scroll-view pan lifecycle

**Files:**
- Modify: `client/AgentDeskClient/PairingViewController.swift` (3 stored props +
  teardown resets)
- Modify: `client/AgentDeskClient/PairingViewController+EdgeFollow.swift`
  (`scrollViewWillBeginDragging`, new `scrollViewDidScroll`,
  `scrollViewDidEndDragging`, `finishManualViewportPan`)

**Interfaces:**
- Consumes: `PointerRetargeting.viewportPoint`, `PointerRetargeting.panFollow
  Retarget` (Task 1); existing `cursorSourcePos`, `activeDisplayRect`,
  `activeDisplayIdMirror`, `lastDesktopState`, `isManualViewportPanActive`,
  `pendingCursorRetarget`, `updateCursorDot()`, `sendInput(_:)`.
- Produces: no new public API; behavior only.

This task is thin glue over Task 1's tested geometry; its correctness is verified
by the Task 1 unit tests plus the user-gated device-feel run below.

- [ ] **Step 1: Add the stored properties**

In `PairingViewController.swift`, next to `var isManualViewportPanActive = false`
(line ~50):

```swift
    // Continuous pan-follow (Option E). Active only during a manual zoomed pan.
    var panFollowActive = false
    var panFollowAnchor: CGPoint?
    var lastSentPanFollowHostPoint: CGPoint?
```

In BOTH teardown resets that set `isManualViewportPanActive = false` (lines ~422
and ~441), add alongside:

```swift
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
```

- [ ] **Step 2: Capture the anchor on drag start**

In `PairingViewController+EdgeFollow.swift`, replace `scrollViewWillBeginDragging`:

```swift
    public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView, scrollView.zoomScale > 1.0 else { return }
        isManualViewportPanActive = true
        // Drop any stale retarget so a queued cursorSet can't fight the reconcile.
        pendingCursorRetarget = nil
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
        // Hold the dot's current viewport position fixed for the gesture; the
        // content slides under it and we reproject to the source now beneath it.
        if let source = cursorSourcePos,
           let anchor = PointerRetargeting.viewportPoint(
               forSource: source,
               displayBounds: activeDisplayRect,
               sinkViewSize: scrollView.bounds.size,
               zoomScale: scrollView.zoomScale,
               contentOffset: scrollView.contentOffset) {
            panFollowAnchor = anchor
            panFollowActive = true
        }
    }
```

- [ ] **Step 3: Reconcile each frame; freeze on lift**

Add `scrollViewDidScroll` and replace `scrollViewDidEndDragging` /
`finishManualViewportPan` in `PairingViewController+EdgeFollow.swift`:

```swift
    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === sinkScrollView, panFollowActive,
              let anchor = panFollowAnchor,
              let retarget = PointerRetargeting.panFollowRetarget(
                  anchorViewportPoint: anchor,
                  state: lastDesktopState,
                  displayId: activeDisplayIdMirror,
                  displayBounds: activeDisplayRect,
                  sinkViewSize: scrollView.bounds.size,
                  zoomScale: scrollView.zoomScale,
                  contentOffset: scrollView.contentOffset) else { return }
        cursorSourcePos = retarget.sourcePoint
        updateCursorDot()
        // Pointer only. Dedupe identical points to avoid flooding the channel.
        if retarget.hostPoint != lastSentPanFollowHostPoint {
            lastSentPanFollowHostPoint = retarget.hostPoint
            sendInput(.cursorSet(
                displayId: retarget.displayId,
                x: Float(retarget.hostPoint.x),
                y: Float(retarget.hostPoint.y)))
        }
    }

    public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        guard scrollView === sinkScrollView else { return }
        // Freeze at finger-lift: ignore momentum/bounce frames so the cursor
        // holds where the user aimed it (this is a pointing gesture).
        panFollowActive = false
        if !decelerate { finishManualViewportPan(scrollView) }
    }

    func finishManualViewportPan(_ scrollView: UIScrollView) {
        guard isManualViewportPanActive else { return }
        isManualViewportPanActive = false
        // No viewport-center snap: the continuous reconcile has already kept the
        // host cursor under the dot, so a center cursorSet would jump it.
        panFollowActive = false
        panFollowAnchor = nil
        lastSentPanFollowHostPoint = nil
    }
```

Leave `scrollViewDidEndDecelerating` as-is (it already calls
`finishManualViewportPan`).

- [ ] **Step 4: Build gates**

Run: `just sim-test`
Expected: PASS (unchanged suite still green; no UIKit unit coverage added here).

Run: `just check-all`
Expected: host + client build clean.

- [ ] **Step 5: Commit**

```bash
git add client/AgentDeskClient/PairingViewController.swift client/AgentDeskClient/PairingViewController+EdgeFollow.swift
git commit -m "feat(client): host cursor follows the dot during a zoomed pan

Reconcile the host cursor to the client dot every frame of a manual zoomed
pan (pointer-only cursorSet), reaching the display edges via rubber-band
overscroll, and freeze on finger-lift. Replaces the pan-end center snap.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Device-feel verification (user-gated)

Per AGENTS.md, a device install/launch is a checkpoint: prepare, state the
command, then STOP and wait for an explicit "run it". First confirm the on-device
build sha matches HEAD (`AgentDeskGitSHA` vs `git rev-parse --short HEAD`).

Prepared command: `just fresh-release-diagnostic-run` (Release host rebuild +
clean client reinstall + attached console).

With touch-scroll mode both **on and off**, at zoom > 1, the user drives while I
watch `/tmp/agentdesk-client-console.log` and host `owned-media` traces:

1. Pan the content in the interior — the host cursor tracks the dot as the
   content slides (dot stays put on screen, points at the new desktop spot).
2. Push past each of the four boundaries — the cursor reaches the true display
   edges/corners (not stuck a margin short).
3. Lift mid-pan — the cursor holds where it was aimed; no retreat during the
   momentum glide/bounce.
4. Pan-end — no center-snap jump of the host cursor.
5. Regression: one-finger touch-scroll still scrolls (not pointer-move); the
   relative trackpad still moves the cursor.

Contingency: if the edge feels too sticky to reach, lower `edgeReachOverscroll`
(default 44pt) and re-verify; if the interior tracking floods the input channel,
add a display-link coalesce in `scrollViewDidScroll`.
