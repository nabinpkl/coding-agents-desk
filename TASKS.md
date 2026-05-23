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

- [x] D10.1. Right-click. Bottom button row in `client/AgentDeskClient/PairingViewController.swift` directly under the trackpad surface, hosting a `[Right-click]` button as its first occupant (R12.3 will add `[Show keyboard]` to the same row). Tap routes through a `sendInput(_:)` helper that wraps the existing `mediaTransport?.send(_:)` call site shared with `GestureTranslatorDelegate`. Host `InputDispatcher.postClick(_:)` handles `.right` by posting `.rightMouseDown` then `.rightMouseUp` at the current cursor location. Rationale: two-finger gestures are not reachable one-handed on iPhone; a thumb-reachable button matches the existing right-edge scroll strip precedent.
- [x] D10.2. Press-and-hold drag, iOS-native pattern. `UILongPressGestureRecognizer` in `GestureTranslator` with `numberOfTapsRequired = 0` and `minimumPressDuration = 0.25` recognises a bare press-and-hold (no preceding tap required); `processDrag` arms an `isDragging` gate that suppresses pan-driven cursor emission for the duration, emits `.dragStart` on `.began`, flat-gain `cursorMove` deltas on `.changed` for selection precision, and `.dragEnd` on `.ended` / `.cancelled` / `.failed`. The old Mac-trackpad muscle-memory pattern (tap, then tap-and-hold-drag) still works for free because the second touch-hold is itself a bare long-press. Host `InputDispatcher.inDrag` flag flips `postCursorMove` to emit `.leftMouseDragged` with the captured drag click state instead of `.mouseMoved` while a drag is open; `.dragStart` / `.dragEnd` post `.leftMouseDown` / `.leftMouseUp` through `postClickEvent`. Host click-state tracking means a bare hold opens drag at state 1 (char selection), a tap-then-hold opens at state 2 (word extension), and tap-tap-hold opens at state 3 (paragraph extension); double / triple / quadruple raw click selects word / line / all in apps that wire it.
- [x] D10.3. Reconciled with issue #6. Issue body rewritten to describe the bottom-row `[Right-click]` button, right-edge scroll strip, consecutive-click state increment (1 → 4 = click / word / line-or-paragraph / select-all), and bare press-and-hold drag (replacing the two-finger and double-tap-drag vocabulary from the original spec). Inline `// MARK: - One-handed affordances` block in `client/AgentDeskClient/GestureTranslator.swift` and `client/AgentDeskClient/PairingViewController.swift` captures the rationale and the mapping back to the unchanged wire shapes (`NormalizedInput.click(.right)`, `NormalizedInput.scroll`).
- [x] D10.4. Tests landed alongside the feature commits: `InputDispatcherTests` covers `.click(.right)` (D10.1), the consecutive-click state increment to 4 plus the location-far and time-out resets (D10.1 / quad-click), `.dragStart` / `.dragEnd` posting and `.cursorMove` promotion to `.leftMouseDragged` during drag (D10.2), and the tap-then-drag opens-at-state-2 case. `GestureTranslatorTests` covers `processDrag` `.began` / `.changed` / `.ended` transitions and the `pan-suppressed-during-drag` invariant. The right-click button itself stays untested in isolation per plan; covered by the host-side `.click(.right)` assertion and HITL.

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

- [x] D12.1. Host key dispatch. `InputDispatcher.performDispatch` handles `.key(code:, modifiers:)` by synthesising `CGEvent(keyboardEventSource:, virtualKey:, keyDown:)` pairs with OR-composed `CGEventFlags` set directly on the event (not OR-ed into the OS-current flag state so a held physical modifier on the host doesn't leak in). `host/AgentDeskHost/KeyCodeMap.swift` maps the closed wire string set (`escape`, `tab`, `return`, `delete`, `space`, arrows, `ansi-A..Z`, `ansi-0..9`, ANSI punctuation `ansi-comma` through `ansi-grave`) to `kVK_*` constants from `Carbon.HIToolbox`. `.modifierArm` stays a no-op with comment pointing at issue #8 (iOS composes modifiers).
- [x] D12.2. Client `KeyboardSurface`. First-responder `UIView` conforming to `UIKeyInput` + `UITextInputTraits` with auto-correct / auto-cap / smart dashes / smart quotes / smart insert-delete / spell-check all off; `keyboardType = .asciiCapable`. `insertText(_:)` maps each character to `(code, shifted)` via `CharacterToKey`: lowercase letters and digits → unshifted ANSI wire codes; uppercase letters and shifted digit-row punctuation (`!@#$%^&*()`) → same wire code + `.shift`; ANSI punctuation has both unshifted (`,./;'[]\\-=\``) and shifted (`<>?:\"{}|_+~`) variants. Sticky-tap state per modifier: `off → armed (single tap) → locked (double tap) → off (third tap)`; on key emit, armed ∪ locked attach, armed clears, locked persists. Wire never carries `.modifierArm`.
- [x] D12.3. PairingViewController integration. `[Show keyboard]` joins `[Right-click]` in the bottom button row. Tap toggles `KeyboardSurface.setVisible(_:)`. Hidden zero-size `KeyboardSurface` mounted as a permanent subview so the responder chain routes through it. `keyboardWillChangeFrame` and `keyboardWillHide` notifications animate `buttonRowBottomConstraint` to keep the trackpad above the soft keyboard (computes overlap in view coords, subtracts safe area so the safe-area anchor doesn't double-count). `KeyboardSurfaceDelegate.keyboardSurface(_:didProduce:)` forwards `.key` events through the same `sendInput(_:)` path the gesture and right-click paths use. `KeyboardAccessoryView` is the `inputAccessoryView`: horizontal stack of Esc, Tab, 2×2 arrow cluster, Cmd, Ctrl, Option. Modifier buttons render `off / armed (tinted background) / locked (solid tint + inset border)` states; Cmd / Ctrl / Option route through `surface.tapModifier(_:)`, Esc / Tab / arrows route through `surface.sendKey(code:)` so armed modifiers attach to them.
- [x] D12.4. Tests landed across D12.1 and D12.2 commits. `host/AgentDeskHostTests/InputDispatcherTests.swift` gains: `keyDown` + `keyUp` posting at the mapped `virtualKey`; single modifier flag carries; multi-modifier composition (`.cmd` + `.shift` both set); no-modifier-bleed regression guard between a key event and the next cursor move; unknown wire code drops with a warning; `modifierArm` is a no-op. `client/AgentDeskClientTests/KeyboardSurfaceTests.swift`: lowercase / uppercase letters, shifted digit-row punctuation, unshifted ANSI punctuation, return, deleteBackward, sticky-tap three-state cycle (single-tap arms-then-clears, double-tap locks, triple-tap clears), multi-modifier composition, locked + armed coexistence with armed clearing, multi-character insertText, and silent drop of out-of-table characters.

## v0 Phase 7 (S7, #9): lifecycle + reconnect. AFK. Blocked by R9 (per issue #9). Parallel with R10, R11, R12.

Phase goal: client tears down its peer within 1s of backgrounding; foregrounding reconnects in under 5s (PRD acceptance bullet 6).

R13 sub-tasks:

- [ ] R13.1. On `UIApplication.didEnterBackgroundNotification`, `PairingViewController` calls `mediaTransport?.close()` and `sessionDialer?.cancel()`. Keychain credentials persist (no mutation on background). Host observes `MediaConnectionState.failed` and runs the existing 5s ICE-disconnected grace already wired in D8.6.6. Verify the WebRTC peer tears down within 1s by logging the close-to-`disconnected` interval through `os.Logger`.
- [ ] R13.2. On `UIApplication.willEnterForegroundNotification`, transition to `paired-disconnected` and re-run the auto-dial path landed in D8.4 (`SessionDialer.dial(host:)`). The session handshake plus WebRTC setup (DTLS, SDP, ICE) must complete in under 5s on Tailscale-over-LAN. Measure on hardware; if the budget is exceeded, identify the dominant wait and shave it inline rather than opening a separate optimisation slice.
- [ ] R13.3. Hardware verification (HITL). Measure background-to-teardown and foreground-to-pixels with a stopwatch over three iterations on the developer's iPhone. Capture timings in `HANDOVER.md`. Fail the slice and open an investigation R-task if either budget is missed.

## v0 input transport refactor (R19, ADR-0005). AFK. Blocked by R12 landing. Blocks R14.

Phase goal: move input off the shared WebRTC PeerConnection onto its own WebSocket Secure connection so typing latency stops varying with video bandwidth. Driven by ADR-0005. R12 hardware testing surfaced a "sometimes fast, sometimes slow" typing pattern; the data-channel input shares a DTLS/UDP 5-tuple with the SRTP video track and queues behind video bursts at the OS socket plus the WebRTC pacer. Industry split (Moonlight, Steam Remote Play) puts input on its own transport with ordered delivery; ADR-0005 picks a dedicated WSS on the existing signaling port 41888 as the implementation.

Pre-v0 affordance applies: rip-and-replace, no feature flag, both ends ship in one slice. `NormalizedInput` wire schema is invariant; only the transport that carries it moves. `MediaTransport` protocol (ADR-0004) loses its `send(_:)` and `inputEvents` surface and becomes video-only.

R19 sub-tasks:

- [x] D19.1. Wire shape. Three frame discriminators on the new WSS: `input-hello` (first frame, carries `SessionToken`), `input-event` (carries one `NormalizedInput` per frame), `input-close` (optional, server-initiated). Compact JSON keys (`t`, `tk`, `ev`, `r`) per ADR-0003 convention. Add `InputChannelFrame` enum to `SharedTypes.swift` on both sides, mirrored. No `RTCDataChannel` references in any new code.
- [x] D19.2. Host. Introduce `host/AgentDeskHost/InputChannelServer.swift`. Owns one `NWConnection` per session, accepts `input-hello` as the first frame, validates token against `SessionRegistry`, and exposes `events: AsyncStream<NormalizedInput>` for `InputDispatcher` consumption. Extend `PairingSignalingServer.handleFirstFrame` to recognise `input-hello` and bind the connection to a new `InputChannelServer`. Update `SessionRegistry` to own one `InputChannelServer` per session and tear it down on revocation. `AppDelegate.attachInputTask` switches source from `transport.inputEvents` to `inputChannelServer.events`; the `InputDispatcher.dispatch(_:)` contract is unchanged.
- [x] D19.3. Client. Introduce `client/AgentDeskClient/InputChannel.swift` protocol + `WebSocketInputChannel` concrete impl that owns one `URLSessionWebSocketTask`. `send(_ input:)` is synchronous-from-caller, encodes one `input-event` per call, pushes through the task. `state` is `AsyncStream<InputChannelState>` (`connecting | open | reconnecting | closed`); reconnect uses the same exponential-backoff policy `SessionDialer` already implements (no new module). `PairingClient.attemptSession` constructs the `InputChannel` alongside the existing `MediaTransport` and exposes it on the returned `ActiveSession`. `PairingViewController.sendInput` routes through `activeSession.inputChannel.send(_:)`; the previous `mediaTransport?.send(_:)` call site is deleted.
- [x] D19.4. Remove the input data channel from both sides. Delete the `RTCDataChannel` creation in `host/AgentDeskHost/LibWebRTCMediaTransport.swift` (the `dataChannel(forLabel: "input", ...)` block and its delegate methods). Delete `client/AgentDeskClient/LibWebRTCMediaTransport.swift`'s `inputDataChannel`, `send(_:)`, `inputEvents` stream, and the matching `RTCDataChannelDelegate` methods. Remove `MediaTransportError.inputChannelNotOpen` and `MediaTransportError.inputEncodeFailed` from the protocol. The video PC's SDP shrinks (no `m=application` line); confirm renegotiation is clean against an existing stale session.
- [x] D19.5. Tests. Drop the data-channel-input tests. Add `host/AgentDeskHostTests/InputChannelServerTests.swift`: first-frame must be `input-hello` (anything else closes the connection); valid token attaches and forwards events; invalid token closes with `unauthorized`; multiple events stream in order to the dispatcher. Add `client/AgentDeskClientTests/InputChannelTests.swift`: `send(_:)` emits one `input-event` per call; the `state` stream transitions `connecting → open → reconnecting → open` on simulated drop+recover; `send` during `reconnecting` queues or throws (decide and assert). Use an in-memory `URLSessionWebSocketTask` fake; do not spin a real WebSocket in unit tests.
- [x] D19.6. End-to-end verification. Re-run the `just ui-flow type-tap-keys` Maestro flow against the simulator after the refactor; the trackpad+keyboard path must still complete with input events reaching the host log. On the developer's iPhone, type a paragraph and observe the latency cadence (subjective: characters should land at the same beat the user is typing, not in bursts). If variance is still visible, open a follow-up R-task; do not paper it.
- [x] D19.7. SPEC.md updates. `§Module boundaries` gains `InputChannel` (client) and `InputChannelServer` (host) as named modules. The transport seam diagram updates to show two transports per session (video PC + input WSS) instead of one. The `MediaTransport` surface in `§Wire shapes` loses `send` and `inputEvents`. Cross-reference ADR-0005 by number.

## v0 Phase 8 (S8, #10): distribution + 7-day self-test. HITL. Blocked by R10, R11, R12, R13, R19 and by Apple Developer Program enrollment landing.

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
D10       2026-05-22  committed   Phase 4 (S4, #6) shipped: right-click + drag + scroll + multi-click selection
D10.1     2026-05-22  committed   bottom-row [Right-click] button + InputDispatcher .right dispatch + test
D10.2     2026-05-22  committed   bare press-and-hold drag: GestureTranslator + InputDispatcher inDrag promotion + tests
D10.3     2026-05-22  committed   issue #6 acceptance rewritten; one-handed-affordances MARK comments inline
D10.4     2026-05-22  committed   tests landed across D10.1 / D10.2 / click-state commits
R11       pending     pending     Phase 5 (S5, #7): SpacesProvider, 3-finger swipe, Ctrl+Arrow synthesis
R11.1     pending     pending     SpacesProvider over private CGS symbols via CGSPrivate.h bridging header
R11.2     pending     pending     3-finger horizontal swipe recognizer; switchSpace emission with debounce
R11.3     pending     pending     InputDispatcher .switchSpace via Ctrl+Arrow keyboard synthesis
R11.4     pending     pending     SpacesProvider smoke test + GestureTranslator 3-finger swipe tests
D12       2026-05-22  committed   Phase 6 (S6, #8) shipped: soft keyboard + accessory row + sticky-tap modifiers
D12.1     2026-05-22  committed   InputDispatcher .key handling + KeyCodeMap (Carbon kVK_*)
D12.2     2026-05-22  committed   KeyboardSurface UIView with sticky-mod state and CharacterToKey table
D12.3     2026-05-22  committed   PairingViewController integration + KeyboardAccessoryView + keyboard-frame layout
D12.4     2026-05-22  committed   tests landed across D12.1 / D12.2
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
