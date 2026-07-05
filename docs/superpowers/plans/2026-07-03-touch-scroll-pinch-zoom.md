# Touch-scroll pinch-zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pinch-to-zoom work while touch-scroll mode is on, via a finger-count state machine: one finger scrolls the host at any zoom level, two fingers drive native `UIScrollView` pinch-zoom and pan-while-pinched.

**Architecture:** Client-only. Replace `sinkScrollView.isScrollEnabled = false` (which also disabled zoom) with `panGestureRecognizer.minimumNumberOfTouches = 2` so the scroll view only responds to two-finger gestures, and swap the touch-scroll `InstantPanGestureRecognizer` for a standard `UIPanGestureRecognizer` (`maximumNumberOfTouches = 1`) whose slop lets a pinch fail it before it fires a spurious `.cursorSet` prime. The mode→config decision is extracted into a pure function so the UIKit apply step stays a trivial, testable translator (mirrors `ControlSurface.visibility(for:)`).

**Tech Stack:** Swift, UIKit, Swift Testing (`import Testing`), Xcode buildable folders, `just`.

## Global Constraints

- No wire or host change — reuses `.cursorSet` + `.scroll`, zoom is local-only `UIScrollView` (unchanged from R21). Client-only.
- Buildable folders: files under `client/AgentDeskClient/` auto-compile into **both** the app and test targets unless listed in the test target's membership-exception set in `project.pbxproj`. Pure files and new test files need **no** pbxproj edits. Do not add UIKit-dependent files to the test compile.
- The pure config file must not import UIKit (it compiles into the test target).
- Physical-device runs are gated: per `AGENTS.md`, the agent prepares and states the command, then STOPS and waits for an explicit "run it". Do not launch a device build without that go-ahead.
- Auto-commit each green task (`just sim-test` passing).

---

## File Structure

- `client/AgentDeskClient/TouchScrollGestureConfig.swift` (new, pure) — `TouchScrollGestureConfig` value + `touchScrollGestureConfig(touchScrollMode:)`. The finger-count routing decision.
- `client/AgentDeskClientTests/TouchScrollGestureConfigTests.swift` (new) — unit tests for the routing function.
- `client/AgentDeskClient/PairingViewController+TouchScroll.swift` (modify) — `attachTouchScrollRecognizer` (standard pan) + `applyTouchScrollMode` (consume the config).
- `docs/superpowers/specs/2026-07-03-touch-scroll-mode-design.md` (modify) — correct the false pinch-zoom claim.

---

### Task 1: Pure finger-count routing seam + tests

**Files:**
- Create: `client/AgentDeskClient/TouchScrollGestureConfig.swift`
- Test: `client/AgentDeskClientTests/TouchScrollGestureConfigTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct TouchScrollGestureConfig: Equatable { let touchScrollRecognizerEnabled: Bool; let scrollViewScrollEnabled: Bool; let scrollViewPanMinimumTouches: Int }`
  - `func touchScrollGestureConfig(touchScrollMode on: Bool) -> TouchScrollGestureConfig`

- [ ] **Step 1: Write the failing test**

Create `client/AgentDeskClientTests/TouchScrollGestureConfigTests.swift`:

```swift
import Testing

// Finger-count routing for touch-scroll mode. One finger scrolls the host at any
// zoom; two fingers drive native UIScrollView pinch + pan-while-pinched. The
// scroll view stays zoom-capable in both modes (isScrollEnabled must never be
// false — that was the original bug that killed pinch).
struct TouchScrollGestureConfigTests {
    @Test func offModeDisablesTouchScrollAndKeepsSingleFingerScrollView() {
        let config = touchScrollGestureConfig(touchScrollMode: false)
        #expect(config.touchScrollRecognizerEnabled == false)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 1)
    }

    @Test func onModeRoutesOneFingerToTouchScrollAndTwoToScrollView() {
        let config = touchScrollGestureConfig(touchScrollMode: true)
        #expect(config.touchScrollRecognizerEnabled == true)
        #expect(config.scrollViewScrollEnabled == true)
        #expect(config.scrollViewPanMinimumTouches == 2)
    }

    // Regression guard against reintroducing isScrollEnabled = false, which also
    // disables pinch-zoom on a UIScrollView.
    @Test func scrollViewStaysZoomCapableInBothModes() {
        #expect(touchScrollGestureConfig(touchScrollMode: false).scrollViewScrollEnabled == true)
        #expect(touchScrollGestureConfig(touchScrollMode: true).scrollViewScrollEnabled == true)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `just sim-test`
Expected: FAIL to compile — `cannot find 'touchScrollGestureConfig' in scope` (the function does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `client/AgentDeskClient/TouchScrollGestureConfig.swift`:

```swift
import Foundation

// Finger-count gesture routing for touch-scroll mode, as a pure value so the
// UIKit apply step (applyTouchScrollMode) stays a trivial translator and the
// routing is unit-testable without a view controller. Mirrors the
// ControlSurface.visibility(for:) seam. Design:
// docs/superpowers/specs/2026-07-03-touch-scroll-pinch-zoom-design.md
//
// One finger scrolls the host at any zoom level; two fingers behave as
// touch-mode-off (native UIScrollView pinch + pan-while-pinched). The scroll
// view stays zoom-capable in both modes (scrollViewScrollEnabled always true) —
// setting isScrollEnabled = false would also disable pinch. Routing is by the
// scroll view pan's minimum touch count: 2 in touch mode (one finger never pans
// the local view, leaving single-finger drags to the touch-scroll recognizer),
// 1 otherwise (default).
struct TouchScrollGestureConfig: Equatable {
    let touchScrollRecognizerEnabled: Bool
    let scrollViewScrollEnabled: Bool
    let scrollViewPanMinimumTouches: Int
}

func touchScrollGestureConfig(touchScrollMode on: Bool) -> TouchScrollGestureConfig {
    TouchScrollGestureConfig(
        touchScrollRecognizerEnabled: on,
        scrollViewScrollEnabled: true,
        scrollViewPanMinimumTouches: on ? 2 : 1
    )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `just sim-test`
Expected: PASS — all three `TouchScrollGestureConfigTests` pass, no other tests regress.

- [ ] **Step 5: Commit**

```bash
git add client/AgentDeskClient/TouchScrollGestureConfig.swift client/AgentDeskClientTests/TouchScrollGestureConfigTests.swift
git commit -m "feat(client): add pure finger-count routing seam for touch-scroll

$(printf 'One finger scrolls host at any zoom; two fingers keep native pinch. The\nscroll view stays zoom-capable in both modes. Pure + unit-tested so the\nUIKit apply step stays a trivial translator.')

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Rewire recognizer + apply config; correct base spec

**Files:**
- Modify: `client/AgentDeskClient/PairingViewController+TouchScroll.swift` (`attachTouchScrollRecognizer` ~lines 14-31, `applyTouchScrollMode` ~lines 86-95)
- Modify: `docs/superpowers/specs/2026-07-03-touch-scroll-mode-design.md` (the "Scope is scroll only" sentence)

**Interfaces:**
- Consumes: `touchScrollGestureConfig(touchScrollMode:) -> TouchScrollGestureConfig` from Task 1.
- Produces: nothing new (behavior change only).

- [ ] **Step 1: Swap the recognizer to a standard pan**

In `client/AgentDeskClient/PairingViewController+TouchScroll.swift`, inside `attachTouchScrollRecognizer`, replace the recognizer construction:

Replace:
```swift
        // Same recognizer the strip uses: promotes to .began on touch-down so
        // the prime fires immediately and the first move maps 1:1.
        let pan = InstantPanGestureRecognizer(
            target: self,
            action: #selector(handleVideoTouchScroll(_:))
        )
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
```
With:
```swift
        // Standard pan (NOT InstantPanGestureRecognizer): it waits for a few px
        // of one-finger slop before .began. That wait is what distinguishes a
        // one-finger scroll from a pinch — a two-finger pinch lands its second
        // finger before the first crosses the slop, so maximumNumberOfTouches=1
        // fails this recognizer before it primes (no spurious .cursorSet, no
        // phantom scroll). A finger added mid-scroll cancels it, and the
        // existing .cancelled path emits scroll(phase:.ended).
        let pan = UIPanGestureRecognizer(
            target: self,
            action: #selector(handleVideoTouchScroll(_:))
        )
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
```

- [ ] **Step 2: Apply the config in `applyTouchScrollMode`**

In the same file, replace the body of `applyTouchScrollMode`:

Replace:
```swift
    func applyTouchScrollMode() {
        let on = SettingsStore.shared.touchScrollMode
        touchScrollRecognizer?.isEnabled = on
        sinkScrollView?.isScrollEnabled = !on
        for control in [trackpadView, scrollStripView] {
            control.alpha = on ? 0.4 : 1.0
            control.isUserInteractionEnabled = !on
        }
        updateTouchScrollButtonAppearance()
    }
```
With:
```swift
    func applyTouchScrollMode() {
        let on = SettingsStore.shared.touchScrollMode
        let config = touchScrollGestureConfig(touchScrollMode: on)
        touchScrollRecognizer?.isEnabled = config.touchScrollRecognizerEnabled
        if let scroll = sinkScrollView {
            // Keep the scroll view zoom-capable at all times (isScrollEnabled =
            // false would also kill pinch). Route by finger count instead:
            // minimumNumberOfTouches = 2 means one finger never pans the local
            // view, so the touch-scroll recognizer owns single-finger drags and
            // two fingers drive native pinch + pan-while-pinched.
            scroll.isScrollEnabled = config.scrollViewScrollEnabled
            scroll.panGestureRecognizer.minimumNumberOfTouches = config.scrollViewPanMinimumTouches
        }
        for control in [trackpadView, scrollStripView] {
            control.alpha = on ? 0.4 : 1.0
            control.isUserInteractionEnabled = !on
        }
        updateTouchScrollButtonAppearance()
    }
```

- [ ] **Step 3: Correct the base spec's false pinch-zoom claim**

In `docs/superpowers/specs/2026-07-03-touch-scroll-mode-design.md`, replace:
```
Scope is scroll only: no tap-to-click, no pinch-zoom changes beyond disabling
the scroll view's own pan while the mode is active. Vertical only; direction
follows the existing `scrollInverted` tuning.
```
With:
```
Scope is scroll only: no tap-to-click. Vertical only; direction follows the
existing `scrollInverted` tuning. (Correction: the original claim that pinch-zoom
was preserved was false — `isScrollEnabled = false` also disabled zoom. Pinch is
restored via a finger-count state machine; see
`2026-07-03-touch-scroll-pinch-zoom-design.md`.)
```

- [ ] **Step 4: Build + run the client test suite**

Run: `just sim-test`
Expected: PASS — the client builds with the standard `UIPanGestureRecognizer` and the config-driven `applyTouchScrollMode`; `TouchScrollGestureConfigTests` and all existing client tests pass.

- [ ] **Step 5: Full gate before commit**

Run: `just check-all`
Expected: PASS — wire tests, host build/test, and client sim tests all green.

- [ ] **Step 6: Commit**

```bash
git add client/AgentDeskClient/PairingViewController+TouchScroll.swift docs/superpowers/specs/2026-07-03-touch-scroll-mode-design.md
git commit -m "feat(client): pinch-zoom in touch-scroll mode via finger-count split

$(printf 'One finger scrolls the host at any zoom; two fingers drive native pinch +\npan-while-pinched. Keep the scroll view zoom-capable (isScrollEnabled stays\ntrue) and route by pan minimumNumberOfTouches=2; swap the InstantPan for a\nstandard maxTouches=1 pan whose slop lets a pinch fail it before priming.\nCorrects the false pinch-zoom claim in the base touch-scroll spec.')

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (user-gated device feel run)

Unit tests cover the routing decision; the two-finger→zoom hand-off and "a pinch never primes" are device-feel behaviors that unit tests cannot judge. After Task 2 is committed and green, propose a physical-device run and **wait for the user's explicit go-ahead** before launching (per `AGENTS.md`):

- Prepare: `just fresh-release-diagnostic-run` (full Release host rebuild + clean client reinstall + attached console), then in touch-scroll mode verify on-device:
  1. One finger on the video scrolls the host (unchanged), at 1x and after zooming in.
  2. Two fingers pinch-zoom the local view and pan while pinched.
  3. Starting a pinch does not jump the Mac cursor or emit a phantom scroll (watch host `owned-media` / `postScroll` traces + client console).
  4. Adding a second finger mid-scroll cleanly ends the host scroll and hands off to zoom.
- If a pinch ever fails to start while a finger is mid-scroll, add a `UIGestureRecognizerDelegate` allowing the pinch to recognize simultaneously with (or require failure of) the touch-scroll pan — the one contingency flagged in the spec.

---

## Self-Review

**Spec coverage:**
- Finger-count model (1f host scroll / 2f native zoom) → Task 1 config + Task 2 `applyTouchScrollMode`. ✓
- `isScrollEnabled` stays true, `minimumNumberOfTouches = 2` on / 1 off → Task 1 values + Task 2 apply. ✓
- Recognizer swap (InstantPan → standard maxTouches=1 pan) → Task 2 Step 1. ✓
- Doc cleanup of the false claim → Task 2 Step 3. ✓
- Simultaneous-recognition contingency → Final verification note. ✓
- Client-only, no wire/host change → Global Constraints + no host/wire files touched. ✓
- Device-feel verification, user-gated → Final verification section. ✓

**Placeholder scan:** none — all code and commands are concrete.

**Type consistency:** `touchScrollGestureConfig(touchScrollMode:)` and the three fields (`touchScrollRecognizerEnabled`, `scrollViewScrollEnabled`, `scrollViewPanMinimumTouches`) are named identically in Task 1's definition, Task 1's tests, and Task 2's consumption. ✓
