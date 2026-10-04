# Web trackpad and scroll strip: porting the iPhone client's behaviour

Date: 2026-10-04. Status: **built** (see §6). Requested by the owner, relayed by a peer session.

**Goal.** Give the web desktop viewer (`packages/AgentPanel/Web/src/features/desktop-viewer/`) a
dedicated trackpad and a dedicated scroll strip that behave like the iPhone client's, not just
look like them.

**Why it needs a plan and not a port.** The Swift client (`client/AgentDeskClient/`, dormant per
`FEATURE-MAP.md`) holds a set of tuned numbers and small decisions that are easy to lose:
- when a drag starts
- how speed turns into distance
- how a flick coasts and stops
- which axis a scroll locks to
- what the puck swaps
- how the drawn cursor agrees with the Mac's

About half of this already reached the web through Pointer mode on the picture. The other half,
including both dedicated controls, did not.

Every claim below names its file and function. Behaviour that I inferred from how UIKit works,
rather than read in our code, is marked **(UIKit, unverified)**.

---

## 1. What the Swift trackpad and scroll strip do

### 1a. Trackpad pad

Source: `GestureTranslator.attach` in `GestureTranslator.swift`. The pad's layout is in
`PairingViewController+Layout.swift`.

| # | Behaviour | Constants | Where |
|---|---|---|---|
| T1 | One-finger relative cursor move. Reads every hardware sample, sums them per display frame, and computes velocity once per frame (total delta / frame dt), not per sample. | dt floor 1ms | `CoalescingTrackpadGestureRecognizer.touchesMoved`, `tick`, `emitPending` |
| T2 | Movement slop before any delta counts. Measured from touch-down. Travel inside the slop is dropped; counting starts from the sample that crosses it. | 3pt | `CoalescingTrackpadGestureRecognizer.slopThreshold` |
| T3 | Movement still pending when the finger lifts is sent, so the tail of a short flick is kept. | | `flushPending` |
| T4 | Pointer acceleration: `gain = 1.5 + min(v * 0.005, 8.5)`, with v in pt/s. Floor 1.5, cap 10 at about 1700 pt/s. | 1.5, 0.005, 8.5 | `GestureAcceleration.mac` |
| T5 | User tuning. `cursorAcceleration` multiplies the gain. `cursorSpeed` multiplies the result. The UI range is 0.5x to 3x. | default 1.0 | `GestureTuning`, `emitCursorDelta` |
| T6 | Tap: one finger, one tap, sends `click(.left)`. A double click is two taps; the host counts click state. | | `processTap`. Host side: `DesktopInputController` uses a 0.5s and 5pt double-click window. |
| T7 | Press and hold to drag. Sends `dragStart`; movement goes out as unaccelerated `cursorMove` (finger delta x cursorAcceleration x cursorSpeed); lift sends `dragEnd`. The pan is muted while dragging, so motion is not sent twice. | hold 0.25s, allowableMovement 25pt | `processDrag`, `isDragging`. **(UIKit, unverified)**: the pan claims the finger at 3pt, so the real "hold still" tolerance is probably 3pt, not 25. |
| T8 | Drag edge auto-pan. While dragging, if the finger is within 44pt of the pad's edge and moving outward, the cursor keeps moving in that direction on a display link at the finger's speed, clamped to 180-1400 pt/s. Moving back inward stops it. | 44pt, 180, 1400 | `updateDragEdgePan`, `nearestDragEdge`, `isMovingOutward`, `processDragEdgePanTick` |
| T9 | Three-finger swipe up sends `systemCommand(.missionControl)`. | 3 touches, up | `processMissionControlSwipe` |
| T10 | Right click is a button in the bottom row, not a gesture, because two fingers are out of reach for one-handed use. | | Comment block "One-handed affordances" in `GestureTranslator.swift` |
| T11 | Pad geometry. 12pt hit outset on the left. Sits left of the strip with an 8pt gap, 12pt from the screen edge, above the button row. Shows a hint label. | 12, 8 | `trackpadView` in `PairingViewController.swift`; constraints in `+Layout.swift` |
| T12 | Hidden and disabled when the layout is full-bleed (Full or Pointer) or the keyboard is up. | | `videoTouchGestureConfig` (`relativeControlsHidden`), `applyVideoTouchState` |

### 1b. Scroll strip

Source: `GestureTranslator.attachScrollStrip` and `processScrollPan`.

| # | Behaviour | Constants | Where |
|---|---|---|---|
| S1 | Instant start. The gesture begins on touch-down, with none of the usual roughly 10pt pan slop. | | `InstantPanGestureRecognizer` |
| S2 | It works like a clutch. The touch has to start on the strip, but then the finger can travel anywhere and still scroll. | | `attachScrollStrip`, comment above `scrollAxisSlop` |
| S3 | Axis lock (`.dominantAxis`). Nothing is sent until the finger has moved 12pt in total. Then whichever axis is 1.25x bigger than the other wins. Until one wins, the gesture stays undecided and sends nothing. Velocity and delta are projected onto the winning axis. | 12pt, 1.25 | `lockedScrollAxis`, `projectedScrollVelocity`, `projectedScrollDelta` |
| S4 | Scroll acceleration: `gain = 1 + min(v * 0.0045, 11)`, using the recognizer's velocity at each move callback. Floor 1, cap 12 at about 2667 pt/s. | 1, 0.0045, 11 | `GestureAcceleration.scroll` |
| S5 | Tuning. `scrollSpeed` multiplies the scroll. `naturalScrolling` flips the sign on both axes. It defaults to off, which sends a sign of +1. That sign is calibrated to the direction this Mac actually delivers, because LinearMouse reverses scrolling. | default off | `projectedScrollDelta` comment |
| S6 | Phases. The first non-zero send is `began`, the rest are `changed`. Lifting sends `ended(0,0)`, but only if `began` went out. A cancel does the same. | | `didEmitScrollBegan` |
| S7 | Momentum seed. The recognizer's velocity at lift is unreliable, so the last non-zero velocity seen during the drag is used instead. | | `lastScrollVelocity` |
| S8 | Momentum runs only if the lift speed is at least 200 pt/s. Decay is `v *= e^(-2.8 dt)` per frame. It stops below 30 pt/s. Phases go `momentumBegan`, `momentumChanged`, `momentumEnded`. Each step is `v * dt * gain(v) * scrollSpeed * sign`. | 200, 2.8, 30 | `startMomentum`, `processScrollMomentumTick` |
| S9 | A new touch on the strip cancels any momentum still running and sends `momentumEnded`. | | `processScrollPan(.began)` calls `stopMomentum(emitEnd: true)` |
| S10 | Geometry. 60pt wide, the same height as the pad, 12pt hit outset to the right (into the safe-area gutter), 12pt from the trailing edge. Corner radius 16, 0.5pt separator border, icon hint. | 60, 12, 16 | `scrollStripView`, `+Layout.swift:212-216, 330` |

### 1c. Pointer mode on the picture, puck, cursor and viewport

These are not the dedicated controls, but the dedicated controls share their state.

| # | Behaviour | Constants | Where |
|---|---|---|---|
| P1 | Pointer mode. One finger anywhere on the video, letterbox included, moves the pointer. It uses the trackpad's state machine with the same curve and tuning. | | `handleVideoPointerPan` calls `processPan` |
| P2 | Pointer mode tap. Clicks where the pointer already is, with no retarget. | | `handleVideoPointerTap`, `videoTouchTapInputs(retargetsCursor: false)` |
| P3 | Pointer mode two-finger scroll, free axis. It competes with pinch-zoom and never runs at the same time as one. It stays available while the puck is engaged. | 2 touches | `handleVideoTwoFingerScroll`, `twoFingerRemoteScrollEnabled` |
| P4 | Puck (scroll clutch). When engaged, one finger sends free-axis scroll and the cursor is not moved first. Single tap toggles it (after the double-tap wait). Double tap zooms to 2.5x at the pointer. Drag moves the puck (standard pan slop). It is clamped on screen and its position is saved on every drag frame. Leaving Pointer mode disengages it. | side 56, alpha 0.35 idle / 0.9 engaged, default offset (-16, -120) | `PointerScrollPuck.swift`, `movePointerScrollPuck`, `applyVideoTouchState` |
| P5 | Edge follow. When zoomed past 1x, the view pans so the cursor stays out of the outer 12% band. It is skipped during a manual pan. | 0.12 | `EdgeFollow.contentOffset`, `applyEdgeFollow`, `advanceCursorModel` |
| P6 | Local cursor model. Applies the delta, then clamps to `[0, w-1] x [0, h-1]`, mirroring the host. | | `EdgeFollow.advanceCursor` |
| P7 | Cursor reconciliation (ADR-0058). Every move or set gets a revision and is queued as pending (at most 4096). When the host applies a revision, older pending entries drop, and the position is corrected only once the host has caught up. A host-side move rebases the cursor and replays newer pending operations on top. If a move goes unconfirmed for 250ms, or a send fails, the cursor turns into a grey ghost. | 4096, 250ms (`AGENTDESK_CURSOR_CONFIRMATION_TIMEOUT_MS`) | `CursorReconciliationStateMachine.swift`, `sendInput`, `applyCursorApplied`, `applyHostCursorMoved` |
| P8 | Cursor overlay. Mirrored host image at 0.7x with the hotspot from fractions. The fallback is a drawn 8x12 arrow with a blue glow. A grey ghost look shows when unconfirmed. | 0.7, 8x12 | `CursorPointerView.swift` |
| P9 | Zoom. 1x to 4x; double tap goes to 2.5x. Vertical slack is `fillFarFirst`, horizontal is centred. | 4.0, 2.5 | `PairingViewController.swift:100-105`, `EdgeFollow.verticalAlignment` |
| P10 | Pan-follow ("Option E"). While a zoomed picture is panned by hand, the host cursor follows a fixed viewport anchor. Overscroll becomes accelerated `cursorMove`. | | `PointerRetargeting.panFollow*`, `+EdgeFollow.swift` scroll delegate |
| P11 | Touch mode (the absolute alternative to Pointer mode). A tap moves the cursor to the finger, then clicks. A one-finger drag moves the cursor to the finger, then scrolls with the strip's state machine. | | `handleVideoTouchTap`, `handleVideoRemoteScrollPan` |

### 1d. Host side

- `host/AgentDeskHost/ScrollActivityTracker.swift` turns scroll input into a motion signal (axis and
  sign, 180ms active window) for the owned-media encoder. `ScrollQualityTests.swift` tests encode
  quality. **Neither applies to the web path.** The web path's host is the grid-encoder, and
  `tools/grid-encoder/DesktopInputController.swift` already handles every scroll phase:
  - `scrollWheelEventScrollPhase` and `MomentumPhase` mapped from the wire phase
  - continuous events
  - sub-pixel remainders kept between events
  - a double-click state machine
- `GestureSurface.swift` is the InteractionPanel webview (voice and Space-switch gestures), not
  trackpad input. Out of scope.

---

## 2. How the web compares today

Legend: **Same**, **Different** (with how), **Missing**.

### Trackpad pad

| # | Status | Notes |
|---|---|---|
| T1 | Same, but only on the picture in Pointer mode | `tileViewportPointerHandlers.move` reads `getCoalescedEvents`. `createCursorMirror.flushPointer` batches per `requestAnimationFrame` and computes speed = total delta / frame time. There is no dedicated pad. |
| T2 | Same | `POINTER_SLOP = 3`. Travel inside the slop is dropped the same way. |
| T3 | Same | `up` calls `flushPointer()`. |
| T4 | Same | `pointerAccelerationGain` in `tileViewportMath.ts`. |
| T5 | Missing | No speed or acceleration settings. |
| T6 | Different | The tap counts as long as the finger never moved 3px. UIKit's tap allows more movement **(UIKit, unverified: about 10pt)**. A sloppy tap that clicks on the phone becomes a tiny move on the web. |
| T7 | Different | `armTouchHold`: 500ms hold (not 250), 3px slop, then `mouse-down`. Movement while held stays **accelerated**, where Swift sends 1:1. The web adds a priming ring at 150ms and a halo. Commit `40334544` explains the 500ms but it was never felt on a phone. |
| T8 | Missing | No drag edge auto-pan. |
| T9 | Missing, and the wire cannot carry it | `DesktopControlInput` has no system-command input. A three-finger swipe on iOS Chrome may also be taken by the OS (three-finger undo). |
| T10 | Missing on touch | `click` with `button: "right"` exists on the wire, but only a real mouse button can send it. |
| T11, T12 | Missing | There is no pad. |

### Scroll strip

| # | Status | Notes |
|---|---|---|
| S1, S2 | Missing | No strip. The puck clutch scrolls on the picture with a 10px slop (`SCROLL_SLOP`), not an instant start. |
| S3 | Different | The web only scrolls free-axis. That matches Swift's free policy on the picture (P3, P4), but there is no dominant-axis lock, which is what the strip uses. |
| S4 | Different input to the same curve | `scrollAccelerationGain` is identical. The web feeds it per-frame displacement / frame time (`flushScroll`). Swift feeds it the recognizer's smoothed velocity at each callback **(UIKit, unverified on smoothing)**. |
| S5 | Different | The sign is hard-coded to +1, equal to Swift's default. There is no `naturalScrolling` toggle and no `scrollSpeed`. |
| S6 | Same | `flushScroll`, `endScroll`. |
| S7 | Different | The momentum seed is the last single sample's dx / dt (`tileViewportPointerHandlers.move`). One noisy sample at lift sets the whole coast. Swift uses the recognizer's estimate. |
| S8 | Same | Same constants (`SCROLL_MOMENTUM_*`). Steps are per animation frame. |
| S9 | Same, while the puck is engaged | `down` calls `stopMomentum(true)`. |
| S10 | Missing | No strip. |
| (web only) | | Mouse wheel goes to the Mac while the puck is engaged, and ends after 150ms of silence (`WHEEL_SCROLL_IDLE_MS`). Swift has no equivalent; keep it. |

### Picture, puck, cursor, viewport

| # | Status | Notes |
|---|---|---|
| P1, P2 | Same | |
| P3 | Different, on purpose | On the web, two fingers always pinch and pan the local view, never scroll the Mac (TileViewport docblock; test "keeps two fingers exclusively local while the scroll clutch is engaged"). |
| P4 | Same | Size 56, opacity 0.35/0.9, default offset {right 16, bottom 120}, 300ms and 24px double-tap window, 10px drag slop that keeps the first travel, clamp, localStorage, disengages when leaving Pointer mode (`TileViewport.tsx:248`). |
| P5 | Same | Margin 0.12 in `followRemoteCursor`. |
| P6 | Same | `advanceRemoteCursor`. |
| P7 | Different, much simpler | `createCursorMirror.applyCursorEvent` only accepts `cursor-applied` when its revision is the newest. It ignores `cursor-position` until every move is acked. There is no pending queue, no replay, no ghost, and no timeout. `cursor-position` on the wire has no `afterRevision`, so a replay is impossible without a wire change. |
| P8 | Partly | The mirror scale of 0.7 is the same. There is no ghost presentation. |
| P9 | Different | `MAX_SCALE = 8` against Swift's 4. Double tap 2.5 is the same. Vertical slack is centred, not `fillFarFirst`, and `clampPan` counts the letterbox as content. |
| P10 | Missing | View mode pans locally and never moves the cursor. |
| P11 | Missing for touch | "Follow" only does absolute positioning for a mouse (`absoluteMouse`). |

---

## 3. What the dedicated web trackpad and scroll strip are

### Where they sit

They form a **Trackpad deck**, which is a new layout of the desktop viewer and the web version of
Swift's "As Is":
- The video box ends above the deck, the same way it already ends above the dock (`chromeHeight`).
- The deck is a row: the pad fills the width, then an 8px gap, then the 60px strip on the right.
- Below that is a short button row: Right click, plus whatever else the owner wants (open question
  Q4).
- The deck is chosen by a mode button next to View, Follow and Pointer in
  `DesktopViewerSurface.tsx`.
- It hides while the keyboard is presented (T12), using the `keyboard.occludedBottom` the surface
  already tracks.
- The picture above keeps Pointer mode's bindings, so the deck adds input surfaces and takes none
  away.

### How input reaches them

All three input types arrive as Pointer Events. They differ like this:
- **Touch** (iPhone Chrome, which runs WebKit underneath):
  - `pointerType === "touch"`
  - one `pointerId` per finger
  - `touch-action: none` on both controls
  - `setPointerCapture` on down, which is how the strip clutch (S2) keeps following a finger that
    leaves the strip
  - `getCoalescedEvents` with the existing `?.` fallback. Whether WebKit provides it needs checking
    on the phone.
- **Mouse** (Mac Chrome):
  - Dragging on the pad moves the cursor relatively, like a trackpad.
  - Dragging on the strip scrolls.
  - A Mac trackpad's two-finger scroll over either control arrives as `wheel` events. It should go
    to the Mac through the existing wheel path (`sendWheelScroll` and `armWheelIdle`), not through
    the finger curve.
- **Pen**: handled as touch.

Timing:
- UIKit's `CADisplayLink` becomes `requestAnimationFrame`. That is fine, because the deck is only
  used in a visible tab.
- The time of each sample comes from `event.timeStamp`.
- Velocity comes from one shared estimator that looks at the last ~100ms of samples. It replaces
  both the per-sample web seed (S7) and the stand-in for UIKit's recognizer velocity (S4), and it
  is the one number that has to be judged by feel.

### How they reach the host

The path is the existing one: `sendPointerInput`, then the WebRTC control data channel
(`tile-stream/tileControlChannel.ts`), then the sidecar `http/tile-control/webrtcDesktopControl.ts`,
then grid-encoder stdin, then `DesktopInputController`. No new route.

| Swift `NormalizedInput` | Web `DesktopControlInput` |
|---|---|
| `cursorMove(dx, dy)` | `pointer-move {revision, dx, dy}` |
| `cursorSet` | `pointer-warp {revision, x, y}` |
| `click(.left / .right)` | `click {button}` |
| `dragStart` / `dragEnd` | `mouse-down` / `mouse-up` (left) |
| `scroll(dx, dy, phase)` | `scroll {dx, dy, phase}`, same six phases |
| `systemCommand(.missionControl)` | **none** (Q5) |

### One cursor model, not two

The predicted cursor, its revision counter and edge-follow live inside `TileViewport`'s runtime
(`ctx.remoteCursor`, `cursorRevision`, `applyRemoteMove`). If the pad kept its own copy, the
overlay and the Mac would drift apart. So the first structural step lifts that model out into one
owner that both the picture and the deck drive.

### Where the code lives

- **`tile-gestures/` gets a DOM-free translator, `gestureTranslator.ts`.** It is the TS twin of
  `GestureTranslator.swift`: cursor emission, scroll with an axis policy, momentum, drag with edge
  auto-pan, and phases. Time and the frame scheduler are passed in, just as Swift's
  `processPan(state:translation:velocity:)` seam lets tests drive it without UIKit. The tile's
  handlers then call it instead of doing the same maths inline. That directory has 4 source files,
  so there is room.
- **The deck UI is a new cluster, `desktop-viewer/trackpad/`.** It starts at three or more files
  (`TrackpadDeck.tsx`, `TrackpadPad.tsx`, `ScrollStrip.tsx`, plus a hook binding pointer events to
  the translator), so it earns its own directory under the fan-out rule.
- **`TileViewport.tsx` is at 449 lines.** Lifting the cursor model out of it gives it room, and
  nothing new goes into it.
- **The constants stay in `tile-viewport/tileViewportConstants.ts`.** Grep first; it already holds
  most of them. The new ones each cite their Swift source.

---

## 4. Order of work

Each step is small, lands green on its own, and states how it is checked against Swift. Three
kinds of check are used:
- **Constants parity.** A Vitest that reads the named constants out of the Swift source with a
  regex and asserts the TS values match. It catches drift for as long as `client/` exists; if
  `client/` is deleted, delete the test with it.
- **Golden vectors.** The Swift tests' inputs and expected outputs, copied by hand into Vitest.
  The Swift translator imports UIKit and cannot run on macOS, so copying them is the only way to
  replay them.
- **Feel on the phone.** The owner judges it. A side-by-side with the iOS app is optional (Q8).

| Step | What | How it is checked |
|---|---|---|
| 1 | Constants parity test for everything in §1 that already has a TS twin (T2, T4, S4, S8, P4, P5, mirror scale). | The test fails if anyone retunes one side. |
| 2 | Extract `gestureTranslator.ts` from the tile handlers. The only behaviour change is the shared velocity estimator, which replaces the per-sample momentum seed (S7). | All existing tile tests stay green. Copy the 23 `GestureTranslatorTests` cases that apply (pan deltas, tap, free and locked axis, direction both axes, wait for dominant axis, ended-without-changed, momentum stays on its axis, drag and its suppression, drag edge-pan continues). |
| 3 | Lift the cursor model out of `TileViewport` into one shared owner. No behaviour change. | `tileViewportCursor.test.tsx` unchanged. A new test where a move from outside the tile moves the overlay and triggers edge-follow. |
| 4 | `ScrollStrip`: instant start, pointer-capture clutch, dominant-axis lock (12px, 1.25), momentum, a new touch cancels momentum, 60px wide with 12px of extra hit area on the right. | Golden vectors S3, S6, S8, S9. A Chrome for Testing run with touch emulation (CDP `Input.dispatchTouchEvent`) against the live panel at phone width, checked by a screenshot showing the Mac's content scrolled. |
| 5 | `TrackpadPad`: tap click, relative move, hold to drag with 1:1 drag motion, drag edge auto-pan (44px, 180-1400). | Golden vectors T6-T8. The same CfT touch run, with the cursor overlay moving and a window title bar dragged. |
| 6 | `TrackpadDeck` layout mode plus the Right click button; hides under the keyboard. | `taste:frontend-layout-sweep` at phone and desktop widths, and with the keyboard up. Verified on the Desktop surface in CfT, not in the owner's Chrome. |
| 7 | Tuning: cursor speed, acceleration, scroll speed, natural scrolling, stored in a preferences module like `desktopKeyboardPreferences.ts`. The wire sign stays calibrated to LinearMouse (S5). | Golden vectors for the direction both axes and with tuning applied. |
| 8 | Cursor reconciliation parity (P7, P8 ghost). This needs `afterRevision` on `cursor-position`, which means a wire, sidecar and grid-encoder change. The grid-encoder install is **stop and wait** under AGENTS.md. | A TS port of the 9 `CursorReconciliationStateMachineTests`, then a ghost seen when the sidecar is paused. |
| 9 | The deliberate divergences, one at a time, only once Q1-Q3 are answered. | Per decision. |

Steps 1-6 need no wire change and no native build. Step 8 is the only one that touches hardware.

---

## 5. Decisions (owner, 2026-10-04)

1. **Hold to drag: 250ms, then 1:1, everywhere.** The pad and the picture both press after 250ms
   held still, and the drag motion is unaccelerated (finger delta x tuning). This replaces the
   web's 500ms accelerated hold from `40334544`. The priming-ring delay (150ms) is re-derived
   against 250ms in step 5.
2. **Two fingers on the picture stay local** (pinch and pan). P3 remains a deliberate divergence;
   remote scrolling is the strip's and the puck's job.
3. **Zoom stays as the web has it**: 8x, centred slack. P9 remains a deliberate divergence.
4. **Button row: Right click only.**
5. **Mission Control: left out.** T9 is dropped; no wire change.
6. **The trackpad layout is offered on touch devices only**, decided by the primary pointer being
   coarse (`matchMedia("(pointer: coarse)")`). A Mac with a mouse keeps Follow and Pointer.
7. **Pan-follow (P10) and Touch mode (P11) are a later arc.** They stay listed as missing.
8. **Checked by ported test cases, the constants parity test, Chrome for Testing touch runs, and
   the owner's feel on the phone.** No side-by-side with the iPhone app, so no native client build.

9. **Trackpad is a mode of its own** (added after the first build): View, Trackpad and Pointer
   are exclusive, like the iPhone's layouts. In Trackpad mode the picture behaves like "As Is" with
   Touch off: one finger pans a zoomed picture, two pinch, a double tap zooms, a tap sends nothing,
   and the cursor the pad moves is still drawn on it.

What this changes in section 4:
- Step 5 sets the hold to 250ms and 1:1 drag motion on the picture as well as the pad.
- Step 6 shows the deck's mode button only on a coarse pointer, and the row holds Right click only.
- Step 9 is now empty: every divergence has an answer. It is dropped.
- Step 8 (cursor reconciliation) is still the only step that needs a native install, and is still
  stop and wait.

---

## 6. What was built (2026-10-04)

Steps 1-8 landed in one change; step 9 was dropped once every divergence had an answer.

- **`desktop-viewer/pointer-input/`** is the shared model:
  - `gestureConstants.ts` holds every finger number, each naming its Swift symbol.
  - `gestureTranslator.ts` and `scrollTranslator.ts` are the TS twin of `GestureTranslator.swift`:
    cursor batching, tap, hold and 1:1 drag with edge auto-pan, axis-locked or free scroll, the
    coast, and the wheel.
  - `velocityTracker.ts` is the 100ms velocity estimate.
  - `cursorReconciliation.ts` ports ADR-0058's state machine.
  - `remoteCursor.ts` is the one cursor model per viewer.
  - `pointerInputSession.ts` ties them together and is shared by the picture and the deck.
  - `gestureTuning.ts` stores the four knobs with zustand `persist` (ADR-0114).
- **`desktop-viewer/trackpad/`** is the deck: pad, 60px strip, Right click, and a Tuning panel. It
  is offered on a coarse primary pointer only, in the slot where a mouse gets Follow.
- **The picture now drives the same translator.** Its hold is 250ms with 1:1 drag motion. Its puck
  scroll drops the slop travel as UIKit's pan does, and its coast is seeded from the velocity
  estimate.

**Step 8 needed no wire change and no native install.** The Swift reconciliation needed the host
to name which revision a Mac-side move came after, because its input and cursor reports travelled
on different streams. On the web both travel on one ordered data channel
(`tileControlChannel.ts`, `ordered: true`; the sidecar relays one encoder's stdout in order). So by
the time a `cursor-position` arrives, every `cursor-applied` sent before it has already arrived,
and what is still pending is exactly what the Mac had not applied. `cursorReconciliation.ts`
records this.

**Checks:**
- `swiftParity.test.ts` reads 27 numbers out of the Swift source.
- 20 of the 23 `GestureTranslatorTests` and all 9 `CursorReconciliationStateMachineTests` are
  replayed vector for vector. The other three test Mission Control (left out) and UIKit
  recognizer states that a browser does not have.
- Deck and surface tests cover the rest.
- Mutating the dominance ratio, the hold, or the scroll sign fails the suite.
- `just trackpad-deck-verify` drives the deck with real touch in phone-sized Chrome for Testing
  against the live panel. It drops every pointer input in the page, so the Mac is never touched.
  It checks the layout, tap, accelerated move, the ghost, the 250ms hold with 1:1 drag, the axis
  lock, the coast and its cancel, and Right click.
