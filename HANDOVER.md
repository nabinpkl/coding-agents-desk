## Handover (post-R19 input transport split)

Snapshot of what landed in the current session and what is left, for the next session or the next pair of eyes. Read after `AGENTS.md`. Authoritative state lives in `PRD.md`, `SPEC.md`, the ADRs, and `TASKS.md`; this file points at them and adds only what those do not already say.

## Where v0 is now

Phases 0 through 4 and 6 landed. Phase 5 (R11 Spaces switching) is the remaining unstarted slice. Phase 7 (R13 lifecycle) is mostly done: R13.1 + R13.2 (background teardown + foreground re-dial) landed this session; R13.3 (HITL hardware timing on the iPhone) is open and only the human can close it. Phase 8 (R14 distribution + 7-day self-test) is blocked on the Apple Developer Program cert and on R11 + R13.3.

ADR-0005 is accepted as of this session. The input transport architecture is now two transports per session: video on a libwebrtc PeerConnection, input on a dedicated WebSocket Secure connection at the existing signaling port. The previous bundled SCTP data channel is deleted on both sides.

## What landed in this session

### ADR-0005: input channel separation (`d76a173`)

Architectural pivot motivated by a typing latency observation. After R12 keyboard landed, hardware testing on the physical iPhone showed "sometimes fast, sometimes slow" cadence for keystrokes. The cause was head-of-line / pacer contention: the SCTP input data channel shared a DTLS/UDP 5-tuple with the SRTP video track. A keyframe burst could deprioritise data packets enough to be visible to a human typist. `RTCDataChannelConfiguration.priority` does not undo OS-level queueing on a shared socket; only a separate transport does. NVIDIA GameStream / Moonlight / Steam Remote Play all reach the same conclusion (input on its own ordered transport). The pre-v0 affordance from `universal-AGENTS.md` (iteration over compatibility) made this the right time to fix the shape rather than tweak around it.

ADR open questions resolved as: first-frame discriminator (not URL path), session-token-in-first-frame auth, exponential backoff reuse from `SessionDialer`, no enforced send-queue bound.

### R19 implementation, end to end (`6388c62`)

Rip-and-replace, both ends in one commit, no compat shim.

**Wire shape (`SharedTypes.swift`, mirrored both sides):**

```
InputChannelHello  { sessionToken }   // t: "input-hello"
InputChannelEvent  { event }          // t: "input-event"
InputChannelClose  { reason }         // t: "input-close"  (optional, server-initiated)
```

`SessionRejectionReason` gains `.unauthorized` for token-mismatch on the input-hello path.

**Host new pieces:**

- `host/AgentDeskHost/InputChannelServer.swift`. Owns one `NWConnection` per session, drains `InputChannelEvent` frames into `events: AsyncStream<NormalizedInput>`. One instance per active session, owned by `SessionRegistry`.
- `PairingSignalingServer.handleInputHello`. First-frame router classifies `input-hello`, validates via `Pairing.validate(token:)`, detaches the connection from the signaling router's tracking, hands it to a fresh `InputChannelServer`.
- `SessionRegistry.attachInputChannelServer` and `endSession` close it.
- `AppDelegate.handleInputChannelReady`. Wires `server.events` into the existing `InputDispatcher.dispatch` path off-MainActor.

**Client new pieces:**

- `client/AgentDeskClient/InputChannel.swift`. Protocol + `WebSocketInputChannel` impl owning one `URLSessionWebSocketTask`. `InputChannelOpener.open` performs the handshake (sends `InputChannelHello` first, returns ready channel).
- `SessionConnection` carries the input channel alongside the signaling channel. `SessionDialer` now returns `SessionHandshakeOutcome` (active + signaling); `PairingClient.attemptSession` assembles the full `SessionConnection` by opening the input channel after the handshake completes.
- `PairingClient.activeInputChannel` exposed; teardown paths (`clearStoredCredentials`, `handleMediaSessionFailed`) close it.
- `PairingViewController.sendInput` routes through `pairingClient.activeInputChannel` instead of the deleted `mediaTransport.send`.

**Deleted on both sides:**

- All `RTCDataChannel` plumbing in `LibWebRTCMediaTransport.swift` (data-channel creation, delegate methods, send path).
- `MediaTransport.send(_:)` (client), `MediaTransport.inputEvents` (host).
- `MediaTransportError.inputChannelNotOpen`, `MediaTransportError.inputEncodeFailed`.

The `MediaTransport` protocol surface now matches its name: video only.

**Tests:**

- `SignalingFrameRoutingTests` gains input-hello classification and round-trips for all three new frame structs.
- `client/AgentDeskClientTests/InputChannelTests.swift` (new) covers compact-key encoding and `NormalizedInput` round-trip via the event frame.
- Old data-channel-input tests deleted alongside the deleted code.
- Full suite still green via `just check`.

**SPEC.md updated:** §Stack (two transports), §Module boundaries (gains `InputChannelServer` host + `InputChannel` client), §Wire shapes (new frames + `.unauthorized`), §Lifecycle (independent input-channel reconnect).

### R13.1 + R13.2 lifecycle (`e685c01`)

`PairingViewController` previously only observed foreground notifications. iOS suspends the app on background and the WebRTC PC / input WS quietly die in some network conditions; without an explicit teardown on background, state stayed `.connected` and the foreground `triggerSessionIfPaired` short-circuited (its precondition is `.pairedDisconnected`), leaving a zombie session.

Added `applicationDidEnterBackground` that cancels every in-flight task, calls `teardownMediaTransport()`, then calls `pairingClient.handleMediaSessionFailed()` to close both `activeSignaling` and `activeInputChannel` and flip state. The next foreground reliably re-attempts the session and the input channel re-opens.

Verified via new `client/maestro/background-foreground-loop.yaml`. Host log shows the full cycle ending with `input recv key(code: "tab")` after the post-foreground keystroke.

### End-to-end verification (`R19.6` + `D13.1/.2`)

Two Maestro flows now cover the input path end to end. Both live under `client/maestro/` and run via `just ui-flow <name>`:

- `type-tap-keys.yaml`. Launches paired app, opens keyboard, taps Esc + Tab on the accessory row. Proves the dedicated WSS reaches the host (the `tapOn "a"` style for QWERTY letters fails on the simulator because the simulator suppresses the on-screen keyboard when "Connect Hardware Keyboard" is on; accessory row taps exercise the wire equivalently).
- `background-foreground-loop.yaml`. Launches → Home → Launch → reads Trackpad → types. Proves reconnect lands.

`trackpad-swipe.yaml` proves cursor moves flow.

### Other landings this session

- Earlier in the session: keyboard text input was bypassing our `insertText` override on real iPhones. iOS routes UITextField mutations through `UITextInput.replace(_:withText:)` (autocorrect, QuickType, ordinary typing) which the UIKeyInput override never sees. Switched `KeyboardSurface` to use `UITextFieldDelegate.shouldChangeCharactersIn` as the catch-all (`83d353a`). Unit tests follow the delegate path.
- Locked the app to dark mode. The Light/Dark/System picker was a research artifact; the answer is dark, and `SceneDelegate` hardcodes `window.overrideUserInterfaceStyle = .dark`. Picker + enum + persisted preference all removed (`93d941a`).
- Settings appearance section uses the iOS plain `.systemBackground` / `.secondarySystemBackground` palette with `.separator` hairlines (`53bd9f8`). The grouped palette was inverted in light mode (grey canvas, white cards) and read as "papers stuck onto grey paper". Plain palette puts canvas and cards in the same tonal family in both modes.
- Simulator pair via `localhost` override. `PairingClient.resolvedHost` honours `AGENTDESK_DEV_HOST_OVERRIDE` (env or `UserDefaults`) under `#if targetEnvironment(simulator)`. `SceneDelegate` persists the env-var to defaults at launch so it survives Maestro relaunches that do not forward env. `pair-sim` recipe passes the override via `SIMCTL_CHILD_AGENTDESK_DEV_HOST_OVERRIDE=localhost` (`5fa72b3`, `53bd9f8`).
- Justfile gained `client-sim-install`, `client-sim-reinstall`, `pair-sim`, `sim-fresh-install`, `ui-flow` recipes (`a787e4c`, `1db84ba`).
- New `agent-learning/` notes:
  - `ios-keyboard-oversized-from-missing-launch-screen.md`. Missing `UILaunchScreen` puts iOS in 320x480 compatibility scaling which upscales the system keyboard. Symptom looks like accessory-bar / text-field config bugs but the cause is one line of Info.plist (`7454efe`, `2cd275a`).
  - `maestro-ios-ui-automation.md`. Maestro is the Playwright equivalent for iOS UI automation. Install path, JAVA_HOME gotcha, `--udid` flag, `tapOn` selectors.

## How it was done (path the next agent should know)

The diagnosis arc, written out so the next agent does not need to re-derive it:

1. R12 keyboard slice landed first. Tests passed; the wire (NormalizedInput key events over the SCTP data channel) was correct. Cursor moves through the same channel felt smooth.
2. User reported variable typing latency on physical iPhone. Traced the iPhone-to-Mac send path, confirmed it was synchronous-on-main and not async, but observed that nothing in our code would produce the bimodal "fast / slow" pattern. The signal pointed downstream.
3. Researched industry patterns (NVIDIA GameStream, Moonlight, Steam Remote Play, Google Meet, RFC 8831, W3C webrtc-priority). Conclusion: shared transport at the OS-socket level is the root cause; the canonical fix is a separate transport for input.
4. User rejected the cheap `RTCDataChannelConfiguration.priority` tweak per `universal-AGENTS.md` (iteration over compatibility); ADR-0005 captured the architectural decision.
5. R19 implementation in one slice, rip-and-replace. Order: wire shape (R19.1) → host server side (R19.2) → client channel side (R19.3) → delete old SCTP path (R19.4) → tests (R19.5) → end-to-end verify (R19.6) → SPEC.md (R19.7). Pre-v0 affordance means no feature flag, no compat shim.
6. R19.6 hit a stale `host-signing-key.dev` file with `com.apple.provenance` xattr that blocked the rebuilt host from writing. `AppDelegate.startPairing` silently swallowed the EPERM in its catch block; added a `signalingLogger.error` line so the error surfaces next time. Resolution: wipe `~/Library/Application Support/AgentDesk/` to clear xattrs.
7. After R19 landed, user asked to fix the background/foreground loop. Same pattern: state machine had `.connected` → no foreground re-dial. Added the background observer + teardown.

## What needs the human now (HITL)

**R13.3 hardware timing measurement.** Background-to-teardown and foreground-to-pixels timings on the physical iPhone, three iterations each, captured here. Budgets per SPEC §Performance: background tear < 1s, foreground re-pair < 5s on Tailscale-over-LAN.

Procedure:

1. `just fresh-install` (host-run + client-reinstall + pair-iphone). Wait until the trackpad is visible on the phone with live screen-share.
2. Tap home. Stopwatch start. Wait for the host log to show `session ended`. Stop. Note delta.
3. Foreground the app. Stopwatch start when you tap the icon. Wait for live screen-share to return. Stop. Note delta.
4. Type a paragraph. Subjective: characters should land at the same beat you type, not in bursts.
5. Repeat steps 2-4 three iterations.
6. Append numbers to this file under a new `### R13.3 measurements` section.
7. If background > 1s or foreground > 5s, open a follow-up R-task; do not paper.

If typing latency variance is still visible after the R19 transport split: open a follow-up R-task with the specific cadence pattern. Do not regress to the bundled-transport shape.

## Open in v0

| Task | Status | Notes |
| --- | --- | --- |
| R11.1-R11.4 | Open | Spaces enumeration + 3-finger swipe. AFK. Not started this session. |
| R13.3 | Open | HITL hardware timing. Only the human can close. |
| R14.1-R14.4 | Open | Distribution + 7-day self-test. Blocked by Developer cert + R11. |

## Gotchas the next agent should know

- The `~/Library/Application Support/AgentDesk/` directory accumulates xattrs (`com.apple.provenance`) that block writes from a freshly-resigned host build. If `startPairing failed: ... Operation not permitted`, wipe the dir and let the host regenerate.
- Simulator `Connect Hardware Keyboard` defaults to on, which suppresses the on-screen QWERTY. The accessory-row keys (Esc, Tab, arrows, Cmd, Ctrl, Opt) are still visible and tappable via Maestro; QWERTY letter taps are not. The `type-tap-keys.yaml` flow uses the accessory row for this reason.
- Simulator cannot reach the host's Tailscale hostname (no Tailscale daemon inside the simulator sandbox). The localhost override is mandatory for sim testing and is automatic via `pair-sim` (which `sim-fresh-install` chains). Physical iPhone uses real Tailscale.
- SourceKit in Xcode warns about missing types in `SharedTypes.swift` and `PairingClient.swift` constantly; these are spurious because the indexer does not have the mirrored-file context. `xcodebuild` builds clean.
- Maestro CLI requires `JAVA_HOME` pointing at brew openjdk; the `ui-flow` recipe sets it. Direct `maestro` invocations from a fresh shell hang with a "Java not found" message otherwise. See `agent-learning/maestro-ios-ui-automation.md`.

## Cross-references

- ADR-0005: `architecture-decisions/0005-input-channel-separation.md`
- Maestro flows: `client/maestro/*.yaml`
- Just recipes: `Justfile` (look for `client-sim-*`, `pair-sim`, `sim-fresh-install`, `ui-flow`)
- TASKS.md: phases 4 through 8, plus R19 (now D19) for the input transport refactor
- Recent commits: `git log --oneline -15`
