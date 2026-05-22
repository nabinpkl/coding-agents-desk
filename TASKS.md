# TASKS: v0 daily-driver replacement of AnyDesk (Phases 4 through 8 active)

`R<N>` = remaining. `D<N>` = done. Numbers are stable; retire dropped IDs in the promotion log, never reuse.

## Position

v0 is one iteration. Acceptance is 7 consecutive days of daily-driver use without reaching for AnyDesk (per `PRD.md`). Nine vertical phases mirror GitHub issues #2 through #10. Phases 0 through 3 are landed and pixels-plus-input-plus-scroll work on hardware.

Per the GitHub issues, Phases 4 through 7 (#6, #7, #8, #9) are each only blocked by Phase 3 (#5, cursor + click), not by each other. They can sequence on priority, not on a forced serial chain. Phase 8 (#10) is blocked by Phases 4 and 5 (#6 and #7) plus the paid Developer ID cert. The prior serial chain in this file overstated dependencies.

Apple Developer Program enrollment was throttled from 2026-05-20; free Xcode signing covers daily-driver use during the throttle. Paid-cert distribution items live entirely under R14.

Authoritative dependency edges live in each issue's "Blocked by" section, not here.

## Done: Phases 0 through 3 (gists)

One line per landed slice. Detail lives in commits, ADRs (`architecture-decisions/`), and the code.

- [x] D0a through D6. Phase 0 bootstrap (#2): ADR-0001 stack and ADR-0002 pairing crypto accepted; host and client Xcode scaffolds; Justfile with configurable iOS test destination; Xcode free signing; `LaunchAgent` install via `LaunchAgentInstaller`; on-device launch confirmed in `HANDOVER.md`.
- [x] D7. Phase 1 (#3): QR pairing per ADR-0002. P-256 with Secure Enclave plus Keychain fallback, in-memory nonce map with 90s TTL, `agentdesk://pair?p=<base64url>` URL.
- [x] D8.1 through D8.5. Phase 2 session layer (#4): per-connection mutual ECDSA-P256 handshake per ADR-0003, four-state UI machines on both ends, `SessionAuthenticator` tests including the bearer-token regression guard.
- [x] D8.6.1 through D8.6.7. Phase 2 pixels (#4): media-transport seams per ADR-0004, `stasel/WebRTC` SPM transport on both sides, `ScreenCaptureKitFrameSource` with TCC handling, `MediaConnectionState` wired to session teardown with 5s ICE-disconnected grace, HITL pixel verification on iPhone (confirmed by the downstream color and frame-pipeline fixes that only land once pixels are visible).
- [x] D9.1 through D9.5. Phase 3 input (#5): input data channel over libwebrtc, `GestureTranslator` (cursor + tap), `InputDispatcher` posting `CGEvent`s off-MainActor on a dedicated serial queue with TCC prompt, isolation tests on both modules.

Tuning and refactors landed alongside but not against R-numbers (inferable from `git log` and the code): cursor acceleration curve driven by real `UIPan` touch velocity, settings screen for cursor and scroll feel, frame-pipeline color and perf fixes (NV12 full-range, BT.709 tagging, `SCStream` queueDepth, VP9 default codec), libwebrtc retain fixes for Swift weak-ref semantics, dev pairing affordances (SIGUSR1 + `devicectl` env-var URL delivery), refactors (`SessionRegistry` extracted from `AppDelegate`, `GestureTuning` value type, MARK section headers in `GestureTranslator`).

## v0 Phase 4 (S4, #6): full trackpad gestures. AFK. In progress. Blocked by R9.

Phase goal: round out the gesture vocabulary with two-finger right-click and double-tap-drag so the trackpad matches the AnyDesk-equivalent set on one-handed phone use.

What is already on `main`: right-edge one-finger scroll strip with momentum and `CGScrollPhase` / `CGMomentumScrollPhase` threaded end-to-end. This was a deliberate substitution for two-finger scroll (one-handed phone use favours an edge strip); the wire shape (`NormalizedInput.scroll`) is identical, so the substitution does not change the host. Issue #6 still names "two-finger scroll" and R10.3 captures the decision to resolve.

What is still no-op in the host (confirmed at `host/AgentDeskHost/InputDispatcher.swift:80` and `:126`): `.dragStart`, `.dragEnd`, `.switchSpace`, `.click(.right)`, `.click(.double)`.

R10 sub-tasks:

- [ ] R10.1. Right-click. Add a two-finger `UITapGestureRecognizer` to the trackpad in `client/AgentDeskClient/GestureTranslator.swift`; emit `.click(.right)`. Implement `.click(.right)` in `host/AgentDeskHost/InputDispatcher.swift` as `.rightMouseDown` then `.rightMouseUp` at the current cursor location.
- [ ] R10.2. Double-tap-drag. Recognise `tap-then-press-and-hold` on the trackpad as `.dragStart` on the hold, cursor moves while the finger drags, `.dragEnd` on lift. In `InputDispatcher`, post `.leftMouseDown` on `.dragStart`, treat intervening cursor moves as `.leftMouseDragged` events, post `.leftMouseUp` on `.dragEnd`. Maintain an `inDrag` flag so cursor-move events promote to `.leftMouseDragged` between `dragStart` and `dragEnd`.
- [ ] R10.3. Scroll affordance decision. Either (a) keep the right-edge strip as the primary scroll affordance and update issue #6 acceptance text, or (b) layer a two-finger pan recognizer alongside the strip with both feeding `.scroll`. Document the rationale inline as a `// MARK: Scroll affordance` comment in `GestureTranslator.swift` and reflect the chosen path in issue #6.
- [ ] R10.4. Tests. `InputDispatcherTests`: assert `.click(.right)` posts the right-button down + up pair at the current location; assert a `dragStart` → cursor moves → `dragEnd` sequence posts `.leftMouseDown`, `.leftMouseDragged`x2, `.leftMouseUp`. `GestureTranslatorTests`: assert a synthesised two-finger tap produces exactly one `.click(.right)`; assert a tap-then-hold sequence produces `.dragStart`, intervening cursor moves, then `.dragEnd`.

## v0 Phase 5 (S5, #7): Spaces enumeration + 3-finger swipe. AFK. Blocked by R9 (per issue #7). Parallel with R10.

Phase goal: the iPhone-side 3-finger horizontal swipe switches macOS Spaces on the host. This is the v0 thesis gesture (`PRD.md`).

R11 sub-tasks:

- [ ] R11.1. Introduce `host/AgentDeskHost/SpacesProvider.swift` per SPEC §3. Public surface: `func current() -> DesktopState`, `func observe() -> AsyncStream<DesktopState>`. Backend: private CoreGraphics symbols `CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners` declared via a thin `CGSPrivate.h` bridging header. `DesktopState`, `DisplayMetadata`, `SpaceMetadata` already exist in `SharedTypes.swift`; reuse verbatim.
- [ ] R11.2. 3-finger horizontal swipe in `client/AgentDeskClient/GestureTranslator.swift`. Add a `UIPanGestureRecognizer` with `minimumNumberOfTouches = 3`, `maximumNumberOfTouches = 3`. On `.ended` with horizontal travel above a 60pt threshold and a horizontal:vertical dominance ratio above 2:1, emit `.switchSpace(direction: .left | .right)` exactly once per gesture (no repeat-fire while the finger is down).
- [ ] R11.3. Implement `.switchSpace` in `host/AgentDeskHost/InputDispatcher.swift`. Synthesise `Ctrl+Left` or `Ctrl+Right` via `CGEvent(keyboardEventSource:, virtualKey: kVK_LeftArrow|kVK_RightArrow, keyDown: true|false)` with `.maskControl` set on both events. Same path Mission Control's keyboard shortcut takes (SPEC §0).
- [ ] R11.4. Tests. `host/AgentDeskHostTests/SpacesProviderTests.swift`: smoke test that `current()` returns a `DesktopState` with at least one display and one space without crashing; this catches private-API symbol regressions across macOS minor versions. `client/AgentDeskClientTests/GestureTranslatorTests.swift`: drive a synthetic 3-finger pan with rightward translation past threshold and assert exactly one `.switchSpace(direction: .right)`; drive a 3-finger pan with vertical-dominant motion and assert nothing is emitted.

## v0 Phase 6 (S6, #8): keyboard + accessory row. AFK. Blocked by R9 (per issue #8). Parallel with R10, R11, R13.

Phase goal: iOS soft keyboard plus a sticky-tap accessory row types into the connected Mac. Issue #8 acceptance is the source of truth.

`NormalizedInput.key(code: String, modifiers: [Modifier])` and `.modifierArm(mod:)` already exist in `SharedTypes.swift` on both sides. `InputDispatcher.swift:80` explicitly no-ops both today. SPEC §3 names `KeyboardSurface` as a client module that is currently absent. The "iOS composes modifiers; host treats `modifierArm` as no-op for v0" choice is captured verbatim in issue #8 and SPEC §3, so no ADR is required.

R12 sub-tasks:

- [ ] R12.1. Host key dispatch. Extend `host/AgentDeskHost/InputDispatcher.swift` to handle `.key(code:, modifiers:)`: synthesise `CGEvent(keyboardEventSource:, virtualKey:, keyDown: true)` then `keyDown: false`, OR-compose `CGEventFlags` (`.maskCommand`, `.maskControl`, `.maskAlternate`, `.maskShift`) from the modifier set, set on both events, post on the existing serial queue. New `host/AgentDeskHost/KeyCodeMap.swift` maps the closed wire string set (`"escape"`, `"tab"`, `"return"`, `"delete"`, `"left"`, `"right"`, `"up"`, `"down"`, plus `"ansi-A"`..`"ansi-Z"`, `"ansi-0"`..`"ansi-9"`, and shifted-punctuation aliases) to `kVK_*` constants from `Carbon.HIToolbox`. `.modifierArm` stays a no-op with a one-line comment pointing at issue #8. Add `Carbon` to the host target's link list in the Xcode project.
- [ ] R12.2. Client `KeyboardSurface`. New `client/AgentDeskClient/KeyboardSurface.swift` per SPEC §3. A first-responder `UIView` conforming to `UIKeyInput` and `UITextInputTraits` with `autocorrectionType = .no`, `autocapitalizationType = .none`, `smartDashesType = .no`, `smartQuotesType = .no`, `smartInsertDeleteType = .no`, `spellCheckingType = .no`, `keyboardType = .asciiCapable`. `insertText(_:)` maps each character to `(code, modifiers)` via a `CharacterToKey` table: ASCII letter → `("ansi-X", current ∪ caseShift)`; shifted punctuation (`!@#$%^&*()_+{}|:"<>?~`) → unshifted code plus `.shift`. `deleteBackward()` emits `("delete", current)`. Newline from Return emits `("return", current)`. Sticky-tap state per-modifier: `off → armed (single tap) → locked (double tap) → off (third tap)`. On key emit, `modifiers = armed ∪ locked`; armed clears after emit, locked persists. Emit `.key` only; never emit bare `.modifierArm` (iOS-side composition is the binding choice per issue #8).
- [ ] R12.3. Wire `KeyboardSurface` into `client/AgentDeskClient/PairingViewController.swift`. Add a "Show keyboard" `UIButton` in the trackpad's top-right corner (mirror the existing settings button placement). Tap toggles `KeyboardSurface.setVisible(_:)`. On `UIResponder.keyboardWillShowNotification`, shrink the trackpad bottom anchor by the keyboard end-frame height; restore on `keyboardWillHideNotification`. `KeyboardSurface.delegate = self`; forward `NormalizedInput.key` to the same `mediaTransport?.send(_:)` call site `GestureTranslatorDelegate` already uses (`PairingViewController.swift:251`). Accessory row is `inputAccessoryView` on the hidden input: one horizontal `UIStackView` with Esc, Tab, a 2×2 arrow `UIStackView`, Cmd, Ctrl, Option. Modifier buttons render `armed` and `locked` visual states distinctly (background tint plus secondary inset for locked).
- [ ] R12.4. Tests. `host/AgentDeskHostTests/InputDispatcherKeyTests.swift`: feed `key("ansi-S", [.cmd])`, assert a `.keyDown` and `.keyUp` pair with `virtualKey == kVK_ANSI_S` and `flags & .maskCommand != 0`; feed `key("ansi-S", [.cmd, .shift])`, assert both `.maskCommand` and `.maskShift`; feed a cursor move after a key event and assert the cursor event carries no modifier flags (regression guard against state bleed). `client/AgentDeskClientTests/KeyboardSurfaceTests.swift`: single-tap-Cmd then `insertText("s")` emits `key("ansi-S", [.cmd])` once and Cmd clears; double-tap-Cmd then two `insertText("s")` calls emit two `key("ansi-S", [.cmd])`; triple-tap-Cmd clears the lock; shifted `"!"` emits `key("ansi-1", [.shift])`.

## v0 Phase 7 (S7, #9): lifecycle + reconnect. AFK. Blocked by R9 (per issue #9). Parallel with R10, R11, R12.

Phase goal: client tears down its peer within 1s of backgrounding; foregrounding reconnects in under 5s (PRD acceptance bullet 6).

R13 sub-tasks:

- [ ] R13.1. On `UIApplication.didEnterBackgroundNotification`, `PairingViewController` calls `mediaTransport?.close()` and `sessionDialer?.cancel()`. Keychain credentials persist (no mutation on background). Host observes `MediaConnectionState.failed` and runs the existing 5s ICE-disconnected grace already wired in D8.6.6. Verify the WebRTC peer tears down within 1s by logging the close-to-`disconnected` interval through `os.Logger`.
- [ ] R13.2. On `UIApplication.willEnterForegroundNotification`, transition to `paired-disconnected` and re-run the auto-dial path landed in D8.4 (`SessionDialer.dial(host:)`). The session handshake plus WebRTC setup (DTLS, SDP, ICE) must complete in under 5s on Tailscale-over-LAN. Measure on hardware; if the budget is exceeded, identify the dominant wait and shave it inline rather than opening a separate optimisation slice.
- [ ] R13.3. Hardware verification (HITL). Measure background-to-teardown and foreground-to-pixels with a stopwatch over three iterations on the developer's iPhone. Capture timings in `HANDOVER.md`. Fail the slice and open an investigation R-task if either budget is missed.

## v0 Phase 8 (S8, #10): distribution + 7-day self-test. HITL. Blocked by R10, R11, R12, R13 and by Apple Developer Program enrollment landing.

Phase goal: ship a Developer ID notarized DMG (host) and a TestFlight build (client), then use AgentDesk as the daily driver for 7 consecutive days without reaching for AnyDesk for the agent-control workflow. PRD acceptance test.

R14 sub-tasks:

- [ ] R14.1. Switch both projects from Xcode automatic free signing to the Apple Developer Program team identity (host: Developer ID Application; client: iOS App Distribution). Update or retire `agent-memory/project_signing_pivot.md` to mark the throttle window closed.
- [ ] R14.2. Host distribution. Notarize the host `.app` via `xcrun notarytool submit ... --wait` and staple via `xcrun stapler staple`. Package as a signed DMG. Verify Gatekeeper acceptance on a clean account.
- [ ] R14.3. Client distribution. Archive and upload to App Store Connect; expose via internal TestFlight to the developer's iPhone. Verify install and launch from TestFlight.
- [ ] R14.4. 7-day daily-driver self-test. Use AgentDesk exclusively for the agent-control workflow for 7 consecutive days. Each day, log a one-line journal entry in `HANDOVER.md`: date, hours of use, any AnyDesk-reach events with reason, any v0-acceptance-blocking issues. The slice ships when 7 consecutive entries record no AnyDesk reach for agent control.

---

## v1 scope (captured, not started until v0 acceptance passes)

R15 onwards reserves the v1 block.

- [ ] R15. Per-agent carousel and reasoning ticker. Mirrors the visual target in `mock-design/`. Adds the agent-identity model to the host (one agent equals one Space in v1).
- [ ] R16. Multi-display picker on the iOS client. Protocol already carries `displays[]` and `activeDisplayId`; UI-only slice.
- [ ] R17. iPad-optimised layout. Same codebase; anchor sizes adapt.
- [ ] R18. Sparkle-based auto-update for the macOS host. Replaces the v0 manual download-and-replace.

### Alternative arc (rejected for v0, captured)

- Code-aware crisp-text overlay. Text rendered separately from the HEVC video track and composited on the client. Useful because HEVC's 4:2:0 chroma subsampling blurs syntax-highlighted edges on small fonts. Rejected because the 7-day daily-driver test is the empirical decider on whether HEVC text crispness is good enough. Revisit if any day during the daily-driver window fails the "can comfortably read code" qualitative check.

---

## Promotion log

```
R0a       2026-05-20  committed   ADR-0001 stack + ADR-0002 pairing crypto accepted
R1        2026-05-20  committed   macOS host Xcode skeleton (bundled with R7)
R2        2026-05-20  committed   iOS client Xcode skeleton (bundled with R7)
R3        2026-05-20  committed   Justfile with configurable iOS test destination
R4        2026-05-20  committed   Xcode automatic free signing on both projects
R5        2026-05-20  committed   LaunchAgent plist install via LaunchAgentInstaller
D6        2026-05-20  committed   on-device launch confirmed (HANDOVER refresh, commit 1e2a913)
D7        2026-05-20  committed   S1 QR pairing host + client per ADR-0002 (#3)
D8.1      2026-05-20  committed   ADR-0003 session establishment accepted; SPEC updated in same change
D8.2      2026-05-20  committed   SessionAuthenticator on host with first-frame dispatcher
D8.3      2026-05-20  committed   SessionDialer on client; state machine rewritten; pairedDisconnected on launch
D8.4      2026-05-20  committed   four-state UI machines on both ends; auto-dial on foreground; dev affordances
D8.5      2026-05-20  committed   SessionAuthenticator tests including bearer-token regression guard
D8.6.1    2026-05-20  committed   ADR-0004 media-transport seams accepted; protocol files + stubs landed
D8.6.2    2026-05-20  committed   WebSocketSignalingChannel + SessionConnection + dispatch tests
D8.6.3    2026-05-20  committed   LibWebRTCMediaTransport host + TestPatternFrameSource + stasel/WebRTC SPM dep
D8.6.4    2026-05-20  committed   LibWebRTCMediaTransport client + RTCMTLVideoSink + PairingViewController wiring
D8.6.5    2026-05-20  committed   ScreenCaptureKitFrameSource + TCC handling + popover screenRecordingDenied state
D8.6.6    2026-05-20  committed   MediaConnectionState observers with 5s ICE-disconnected grace on both ends
D8.6.7    2026-05-21  committed   HITL hello-pixels confirmed (downstream color + perf fixes only land post-render)
D9.1      2026-05-21  committed   input data channel on both sides; onInputEvent + send surfaces
D9.2      2026-05-21  committed   NormalizedInput Codable; GestureTranslator; trackpad UIView wired
D9.3      2026-05-21  committed   InputDispatcher posting CGEvents off-MainActor; MediaStack wiring
D9.4      2026-05-21  committed   Accessibility TCC prompt at launch; popover accessibilityRequired state
D9.5      2026-05-21  committed   InputDispatcher and GestureTranslator tests
R10       pending     pending     Phase 4 (S4, #6): right-click, double-tap-drag, scroll affordance decision
R10.1     pending     pending     two-finger right-click in GestureTranslator + InputDispatcher
R10.2     pending     pending     double-tap-drag (dragStart/dragEnd) on both sides with inDrag promotion
R10.3     pending     pending     scroll affordance decision (right-edge strip vs two-finger pan) reflected in #6
R10.4     pending     pending     InputDispatcher and GestureTranslator tests for right-click and drag
R11       pending     pending     Phase 5 (S5, #7): SpacesProvider, 3-finger swipe, Ctrl+Arrow synthesis
R11.1     pending     pending     SpacesProvider over private CGS symbols via CGSPrivate.h bridging header
R11.2     pending     pending     3-finger horizontal swipe recognizer; switchSpace emission with debounce
R11.3     pending     pending     InputDispatcher .switchSpace via Ctrl+Arrow keyboard synthesis
R11.4     pending     pending     SpacesProvider smoke test + GestureTranslator 3-finger swipe tests
R12       pending     pending     Phase 6 (S6, #8): keyboard + sticky-tap accessory row
R12.1     pending     pending     InputDispatcher .key handling + KeyCodeMap (Carbon link)
R12.2     pending     pending     KeyboardSurface UIView with sticky-mod state and char→key table
R12.3     pending     pending     PairingViewController integration (Show keyboard button + accessory row)
R12.4     pending     pending     KeyboardSurface and InputDispatcher key-event tests
R13       pending     pending     Phase 7 (S7, #9): drop-on-background + foreground reconnect under 5s
R13.1     pending     pending     background teardown within 1s; close peer + cancel dialer
R13.2     pending     pending     foreground reconnect under 5s via existing auto-dial path
R13.3     pending     pending     HITL stopwatch verification on hardware; timings in HANDOVER
R14       pending     pending     Phase 8 (S8, #10): paid signing + DMG + TestFlight + 7-day self-test
R14.1     pending     pending     switch to paid team identity; retire signing pivot memory
R14.2     pending     pending     host notarized + stapled DMG; Gatekeeper acceptance
R14.3     pending     pending     client TestFlight upload; install + launch verified
R14.4     pending     pending     7-day daily-driver self-test; per-day HANDOVER journal entries
```
