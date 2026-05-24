# TASKS: v0 daily-driver replacement of AnyDesk (S0 active, S1 through S8 captured)

`R<N>` is remaining. Flip to `D<N>` once landed and verification passes. Numbers are stable; retire dropped IDs in the promotion log, never reuse.

## Position

v0 is one iteration. Acceptance is the author using AgentDesk as a daily driver for 7 consecutive days without reaching for AnyDesk (per `PRD.md`). The iteration is sliced into nine vertical phases that mirror GitHub issues #2 through #10:

- Phase 0 (S0, #2): bootstrap. ADR-0001, Xcode projects, signing, LaunchAgent. No product behavior.
- Phase 1 (S1, #3): QR pairing end-to-end.
- Phase 2 (S2, #4): hello-pixels.
- Phase 3 (S3, #5): cursor and basic click.
- Phase 4 (S4, #6): full trackpad gestures.
- Phase 5 (S5, #7): Spaces enumeration and 3-finger swipe.
- Phase 6 (S6, #8): keyboard and accessory row.
- Phase 7 (S7, #9): lifecycle and reconnect.
- Phase 8 (S8, #10): distribution and 7-day self-test.

Phase 0 is the gate. Nothing else lands until ADR-0001 is committed and both Xcode projects build clean. Phase 1 (pairing) ships before Phase 2 (pixels) because pixels require a connected WebRTC peer and a verified `SessionToken`, both produced by pairing. Phase 5 (Spaces) ships after Phase 4 (gestures) because the 3-finger swipe is a gesture, so the gesture vocabulary must exist first. Phase 7 (lifecycle) ships before Phase 8 (distribution) because the 7-day daily-driver test in Phase 8 cannot start until foreground reconnect is reliable.

Signing pivot for Phase 0: Apple Developer Program enrollment is throttled (~48hr+ from 2026-05-20), so Phase 0 uses Xcode automatic free signing per `agent-memory/project_signing_pivot.md`. Developer ID notarized DMG and TestFlight upload acceptance items fold into Phase 8 when the paid cert lands. The free 7-day provisioning profile reinstall cadence is operational overhead during the throttle window; if it persists into the 7-day daily-driver test, it becomes a real risk for Phase 8 acceptance.

Authoritative dependency edges for each phase live in the issue's "Blocked by" section, not here.

## v0 Phase 0: bootstrap (S0, #2). Gate.

Phase goal: lock the stack in an ADR, scaffold both Xcode projects with free signing, confirm both apps launch on real hardware. No product behavior.

- [x] D0a. Write `architecture-decisions/0001-stack-and-transport.md`. Captures the locked decisions from `SPEC.md`: native Swift on both ends, libwebrtc via SPM, ScreenCaptureKit + VideoToolbox HEVC on host, `AVSampleBufferDisplayLayer` on client at native DPR, Tailscale-only network, QR + Keychain pairing, primary-display-only capture in UI but multi-display-aware in protocol, drop-on-background lifecycle, paid Apple Developer Program distribution. Status `accepted`. Cross-link from `SPEC.md` by ADR number, not by path. ADR-0002 (`pairing crypto for v0`) landed in the same change as a Phase 1 prerequisite; both are indexed in `architecture-decisions/README.md`.
- [x] D1. Scaffold macOS host Xcode project at `host/AgentDeskHost.xcodeproj`. Menu bar app via `NSStatusItem` with placeholder popover. Bundle ID `com.example.agentdesk.AgentDeskHost`. Landed bundled with R7 in a single Codex turn because the project skeleton is not independently verifiable without a build target.
- [x] D2. Scaffold iOS client Xcode project at `client/AgentDeskClient.xcodeproj`. UIKit, placeholder `PairingViewController`. Bundle ID `com.example.agentdesk.AgentDeskClient`. Landed bundled with R7.
- [x] D3. Add `Justfile` at repo root. `just check` drives `xcodebuild build test` on both targets. iOS test destination is configurable via `AGENTDESK_IOS_TEST_DESTINATION` env var, default `platform=iOS Simulator,name=iPhone 17,OS=latest`. `just dev` opens both Xcode projects.
- [x] D4. Configure Xcode automatic free signing on both projects per `agent-memory/project_signing_pivot.md`. Both targets build clean against the developer's local cert; on-device install via Xcode Run will use the personal team when the user runs it. No App Store provisioning, no Developer ID, no TestFlight.
- [x] D5. Register macOS host LaunchAgent plist at `~/Library/LaunchAgents/com.example.agentdesk.AgentDeskHost.plist`. `LaunchAgentInstaller` writes the plist on first run (idempotent by content match) and shells to `/bin/launchctl bootstrap gui/$UID/<plist>`. Plist dictionary: `Label`, `ProgramArguments` (Bundle.main.executablePath), `RunAtLoad=true`, `KeepAlive=false`, `ProcessType=Interactive`, `LimitLoadToSessionType=Aqua`. `AppDelegate.installLaunchAgent` calls into the installer inside a do/catch with os.Logger; failure logs and continues. Reboot survival test is HITL; runs as part of R6.
- [ ] R6. Verify on-device launch. Host menu bar icon is visible on the developer's Mac after `just dev`. iOS client placeholder view launches on the developer's personally-owned iPhone via Xcode Run. Capture both confirmations in `HANDOVER.md`: one Mac screenshot of the menu bar icon, one iPhone screenshot of the placeholder view.

### Deferred from Phase 0, fold into Phase 8 (S8, #10) when paid cert lands

- Developer ID-signed `.app` for the host.
- TestFlight internal upload for the iOS client.

Both are blocked on Apple Developer Program enrollment landing. They belong to Phase 8 acceptance, not Phase 0, so they do not carry R-numbers here.

## v0 Phase 1 through 8: captured, not started

Each captured phase expands into a sub-task block (`R7.1`, `R7.2`, ...) when its phase opens. The R-number reserves the slot so cross-references survive renumbering avoidance.

- [x] D7. Phase 1 (S1, #3): QR pairing end-to-end. AFK. Landed in one bundled Codex turn alongside D1, D2, D3, D4. `Pairing` and `PairingClient` modules implement ADR-0002 verbatim, P-256 with Secure Enclave plus Keychain fallback, in-memory nonce map with 90s TTL, FQDN-then-IPv4 host resolution, no token expiry, `agentdesk://pair?p=<base64url>` QR URL. Five Pairing tests and two PairingClient tests pass via Swift Testing. S1 shipped without a per-connection session layer; that gap is the failure mode ADR-0003 closes and R8.1 through R8.5 implement.

### Phase 2 (S2, #4): hello-pixels. AFK. Blocked by R7.

Phase goal: a single frame of the host's active display rendered on the iPhone, end-to-end, gated by an authenticated session. The session layer lands first because S1's bearer-token reconnect model is the failure shape ADR-0003 closes; WebRTC SDP and ICE inherit their trust from the session, so the session must exist before any libwebrtc code does. R8.6 is the pixel slice itself and only opens after R8.1 through R8.5 close.

- [x] D8.1. Write `architecture-decisions/0003-session-establishment.md`, status `accepted`. Update `SPEC.md` in the same change: add `SessionAuthenticator` on the host and `SessionDialer` on the client to the module list, add the session wire shapes block after the QR-encoding paragraph, rewrite the lifecycle bullet that claimed bearer-token reconnect.
- R8.2. Introduce `host/AgentDeskHost/SessionAuthenticator.swift`. Public surface: `authenticate(on: NWConnection) async throws -> ActiveSession`. Encapsulates the four-message exchange (`SessionInit` → `SessionChallenge` → `SessionProof` → `SessionReady`) on the `/session` path of the existing TLS WebSocket established by `PairingSignalingServer`. Rejection reasons emitted as the closed set `{ revoked, unknown-device, replay, bad-signature, malformed }` per ADR-0003 decision 5. No code path emits `SessionReady` without verifying `clientSignature` against the allowlist's stored device public key.
- R8.3. Introduce `client/AgentDeskClient/SessionDialer.swift` mirroring the host. Delete `PairingClient.loadStoredSessionIfPresent`'s direct transition to `.connected`; replace with a `loadStoredPairingMaterial` that returns `paired-disconnected`. Add `dial(host:)` that runs the client side of the four-message exchange and verifies `hostSignature` against the cached `hostPublicKey` before sending `SessionProof`. On `revoked` / `unknown-device` / `bad-signature`, clear the stored token and host pubkey and transition to `unpaired`.
- R8.4. Rewrite the UI state machines on both sides. Host `PopoverViewController` carries `{ unpaired, paired-no-active-session, connecting, connected }`. Client `PairingViewController` carries `{ unpaired, paired-disconnected, connecting, connected, revoked }`. Add a "Forget host" action on the client for `paired-disconnected`. Remove the assumption "have token equals connected" wherever it appears, including the implicit one in `loadStoredSessionIfPresent`.
- R8.5. Tests on `Pairing` and `SessionAuthenticator` per `AGENTS.md`'s named-modules list, with mirroring tests on `PairingClient` and `SessionDialer`. Assertions: fresh handshake against an allowlisted fingerprint produces `SessionReady`; revoked fingerprint produces `SessionRejected { revoked }`; replayed `clientNonce` produces `SessionRejected { replay }`; tampered `hostNonce` fails client-side verification and never sends `SessionProof`; `SessionToken` presented without a valid `clientSignature` produces `SessionRejected { bad-signature }`. The last assertion is the one that catches a regression to bearer-token authentication.
- R8.6. The pixel slice itself, expanded into R8.6.1 through R8.6.7 per ADR-0004 (media transport seams). SDP and ICE travel only over an `ActiveSession`; the DTLS fingerprint binding is structural per ADR-0003 decision 3. Acceptance: a single frame of the host's active display renders on the iPhone with the session shown as `connected` on both ends, and severing the network mid-stream returns both UIs to `paired-disconnected` / `paired-no-active-session` rather than leaving a stale `connected`.
  - R8.6.1. ADR-0004 accepted, `SPEC.md` updated, four protocol files (`MediaTransport`, `SignalingChannel`, `VideoFrameSource` host, `VideoFrameSink` client) and the `MediaStack` composition root with stub factories landed on both sides. `WebRTCSignalingFrame` added to `SharedTypes.swift` on both sides. No runtime behavior change. `just check` clean.
  - R8.6.2. `WebSocketSignalingChannel` impl on both sides. `PairingSignalingServer` carries a per-connection `activeSessionFrameHandler`; `SessionDialer` returns a `SessionConnection { active, signaling }` instead of a bare `ActiveSession`. Tests: `SignalingFrameDispatchTests`.
  - R8.6.3. `LibWebRTCTransportFactory` and `LibWebRTCMediaTransport` (host) with `TestPatternFrameSource`. `stasel/WebRTC` SPM dep added.
  - R8.6.4. `LibWebRTCTransportFactory` and `LibWebRTCMediaTransport` (client) with `RTCMTLVideoSink`. Test-pattern frames render on iPhone over the authenticated session.
  - R8.6.5. `ScreenCaptureKitFrameSource` swaps in via `MediaStack.makeFrameSource()`. `NSScreenCaptureUsageDescription` added; popover renders `screenRecordingDenied` when TCC is not granted.
  - R8.6.6. `MediaConnectionState.failed` propagates to `signalingServer.endSession(fingerprint:)` on host and `PairingClient.state = .pairedDisconnected` on client, with a 5s ICE-disconnected grace.
  - R8.6.7. HITL on-device hello-pixels: real frame visible, both UIs `connected`, screenshots captured for HANDOVER.

### Phase 3 (S3, #5): cursor and basic click. AFK. Blocked by R8.

Phase goal: a single-finger drag on the iPhone trackpad zone moves the Mac cursor, a single-finger tap left-clicks. Relative motion only, no absolute coordinate mapping; the trackpad zone occupies the empty space below the video frame in the iPhone client.

Two-finger gestures (right-click, scroll) and double-tap-drag belong to Phase 4 per SPEC §3.2 and stay out of scope here. Keyboard and modifier-arm belong to Phase 6. The `NormalizedInput` schema per SPEC §13.1 carries those kinds already; only `cursorMove` and `click(.left)` are implemented in R9.

R9.1 lands the input data channel before R9.2 and R9.3 because both the gesture translator and the dispatcher need the transport surface to exist. R9.2 (translator) ships before R9.3 is wired into `MediaStack` so the channel has a producer to feed it. R9.4 (Accessibility TCC flow) ships in the same commit as R9.3 because the dispatcher cannot post `CGEvent`s without the permission and we do not want code that fails silently. R9.5 (tests) closes the slice; the test obligation in SPEC §13 names `InputDispatcher` and `GestureTranslator` explicitly.

- R9.1. Introduce the input data channel on both sides. Host: in `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, create a reliable+ordered `RTCDataChannel` labelled `"input"` after the peer connection is constructed and before the offer is created (so the data channel travels in the offer SDP); expose an `onInputEvent: (Data) -> Void` callback through `MediaTransport` in `host/AgentDeskHost/MediaTransport.swift`. Client: in `client/AgentDeskClient/LibWebRTCMediaTransport.swift`, receive the remote-opened channel via `RTCPeerConnectionDelegate.peerConnection(_:didOpen:)`, retain a strong ref to it for the connection lifetime, and expose `send(_ input: NormalizedInput)` on the client `MediaTransport` protocol.
- R9.2. Define `NormalizedInput` as a Codable enum per SPEC §13.1 (kinds `cursorMove`, `click`, `scroll`, `dragStart`, `dragEnd`, `switchSpace`, `key`, `modifierArm`). Add to `host/AgentDeskHost/SharedTypes.swift` and mirror in `client/AgentDeskClient/SharedTypes.swift`. Introduce `client/AgentDeskClient/GestureTranslator.swift` with public surface `attach(to view: UIView)` and a `delegate: GestureTranslatorDelegate` that receives `NormalizedInput`. Behavior in R9: `UIPanGestureRecognizer` produces `cursorMove(dx, dy)` per `.changed` callback with deltas since the previous callback; `UITapGestureRecognizer` produces `click(.left)`. Add a `UIView` trackpad zone below the video frame in `client/AgentDeskClient/PairingViewController.swift`, distinct background so it reads as a trackpad surface, and wire it to the translator.
- R9.3. Introduce `host/AgentDeskHost/InputDispatcher.swift` with public surface `dispatch(_ input: NormalizedInput)` and a `eventPoster: (CGEvent) -> Void` constructor seam defaulting to `{ $0.post(tap: .cghidEventTap) }` so tests can capture posted events without touching the real HID tap. `cursorMove(dx, dy)`: read the current cursor location via `CGEventSource.location`, construct a `.mouseMoved` `CGEvent` at offset `(x + dx, y + dy)`, post via the seam. `click(.left)`: post `.leftMouseDown` then `.leftMouseUp` at the current location. Wire into `host/AgentDeskHost/MediaStack.swift` so the host transport's `onInputEvent` callback decodes JSON to `NormalizedInput` and calls `dispatcher.dispatch(_:)`.
- R9.4. Accessibility permission flow. On first `dispatch` call, `InputDispatcher` checks `AXIsProcessTrusted()` and no-ops the event with an `os.Logger` warning when untrusted. `host/AgentDeskHost/AppDelegate.swift` calls `AXIsProcessTrustedWithOptions` with the prompt-enabled options dict at startup so the user is asked once. `host/AgentDeskHost/PopoverViewController.swift` gains an `accessibilityRequired` view state parallel to the existing `screenRecordingDenied`, rendering a button that opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`. No `Info.plist` change is required for `CGEvent` posting.
- R9.5. Tests. `host/AgentDeskHostTests/InputDispatcherTests.swift`: inject a recording `eventPoster`; feed `cursorMove(10, 20)` and assert exactly one `CGEvent` posted with type `.mouseMoved` and the expected offset; feed `click(.left)` and assert a `.leftMouseDown` followed by `.leftMouseUp` at the same location. `client/AgentDeskClientTests/GestureTranslatorTests.swift`: drive the translator with synthetic `UIPanGestureRecognizer` state transitions (`.began`, `.changed` with successive translations, `.ended`) and assert the emitted sequence of `cursorMove(dx, dy)` events use deltas-since-last, not absolute translation; drive a `UITapGestureRecognizer` recognized state and assert one `click(.left)`.

- R10. Phase 4 (S4, #6): full trackpad gestures (two-finger right-click, two-finger scroll, double-tap drag). AFK. Blocked by R9.
- R11. Phase 5 (S5, #7): Spaces enumeration via private CGS and 3-finger swipe via synthesized `Ctrl+Arrow`. AFK. Blocked by R10.
- R12. Phase 6 (S6, #8): compact keyboard and accessory row with sticky-tap modifiers. AFK. Blocked by R11.
- R13. Phase 7 (S7, #9): drop-on-background and foreground reconnect under 5 seconds. AFK. Blocked by R12.
- R14. Phase 8 (S8, #10): distribution (notarized DMG, TestFlight) and the 7-day daily-driver self-test. HITL. Blocked by R13 and by Apple Developer Program enrollment landing.

---

## v1 scope (captured, not started until v0 7-day acceptance passes)

v1 unlocks the agent-native UX that `mock-design/` shows and the protocol-already-supports features deferred from v0. R15 onward reserves the number block for v1.

- R15. Per-agent carousel and reasoning ticker. Mirrors the visual target in `mock-design/`. Adds the agent-identity model to the host (one agent equals one Space in v1).
- R16. Multi-display picker on the iOS client. Protocol already carries `displays[]` and `activeDisplayId`; this slice is UI only.
- R17. iPad-optimized layout. Same codebase, anchor sizes adapt.
- R18. Sparkle-based auto-update for the macOS host. Replaces the v0 manual download-and-replace.

### Alternative arc (rejected for v0, captured)

- Code-aware crisp-text overlay. Text rendered separately from the HEVC video track and composited on the client. Useful because HEVC's 4:2:0 chroma subsampling blurs syntax-highlighted edges on small fonts. Rejected for v0 because the 7-day daily-driver test is the empirical decider on whether HEVC's text crispness is good enough as it stands. Revisit if any day during the daily-driver window fails the "can comfortably read code" qualitative check.

---

## Promotion log

```
R0a      2026-05-20  committed   ADR-0001 accepted; ADR-0002 pairing crypto accepted alongside
R1       2026-05-20  committed   macOS host Xcode project skeleton (bundled with R7)
R2       2026-05-20  committed   iOS client Xcode project skeleton (bundled with R7)
R3       2026-05-20  committed   Justfile with configurable iOS test destination
R4       2026-05-20  committed   Xcode automatic free signing on both projects
R5       2026-05-20  committed   LaunchAgent plist install and reload-on-stale; reboot test deferred to R6
R6       pending     pending     on-device launch verified, screenshots in HANDOVER (HITL)
R7       2026-05-20  committed   S1 QR pairing host and client per ADR-0002 (#3)
R8       pending     pending     Phase 2 expanded into R8.1 through R8.6 (S2, #4)
R8.1     2026-05-20  committed   ADR-0003 session establishment accepted; SPEC updated in same change
R8.2     2026-05-20  committed   SessionAuthenticator on host with first-frame dispatcher
R8.3     2026-05-20  committed   SessionDialer on client; state machine rewritten; pairedDisconnected on launch
R8.4     2026-05-20  committed   four-state UI machines on both ends, auto-dial on foreground, dev affordances
R8.5     2026-05-20  committed   SessionAuthenticator tests including bearer-token regression guard
R8.6     pending     pending     hello-pixels, expanded into R8.6.1 through R8.6.7
R8.6.1   2026-05-20  committed   ADR-0004 media-transport seams accepted; SPEC updated; protocol files + stubs landed
R8.6.2   2026-05-20  committed   WebSocketSignalingChannel + SessionConnection + SignalingFrameRouting tests
R8.6.3   2026-05-20  committed   LibWebRTCMediaTransport host + TestPatternFrameSource + stasel/WebRTC 130.0.0 SPM dep
R8.6.4   2026-05-20  committed   LibWebRTCMediaTransport client + RTCMTLVideoSink + PairingViewController wiring
R8.6.5   2026-05-20  committed   ScreenCaptureKitFrameSource + TCC handling + popover screenRecordingDenied state
R8.6.6   2026-05-20  committed   MediaConnectionState observers with 5s ICE-disconnected grace on both ends
R8.6.7   pending     pending     HITL hello-pixels on-device verification
R9       pending     pending     Phase 3 expanded into R9.1 through R9.5 (S3, #5)
R9.1     pending     pending     input data channel on both sides; onInputEvent + send surfaces
R9.2     pending     pending     NormalizedInput Codable; GestureTranslator; trackpad UIView wired
R9.3     pending     pending     InputDispatcher posting CGEvents; MediaStack wiring
R9.4     pending     pending     Accessibility TCC prompt at launch; popover accessibilityRequired state
R9.5     2026-05-21  committed   InputDispatcher and GestureTranslator tests
R10      pending     pending     Phase 4 captured (S4, #6)
R11      pending     pending     Phase 5 captured (S5, #7)
R12      pending     pending     Phase 6 captured (S6, #8)
R13      pending     pending     Phase 7 captured (S7, #9)
R14      pending     pending     Phase 8 captured (S8, #10) including deferred S0 items
```
