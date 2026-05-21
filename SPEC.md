# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit menu-bar app via `NSStatusItem` | Fresh implementation, owned end-to-end. Python sister project's pyobjc learnings reused, code is not. |
| iOS client | Swift, UIKit, `AVSampleBufferDisplayLayer` for video | Native required for HEVC crispness and gesture fidelity. Browser path rejected (see PRD). |
| Capture | `ScreenCaptureKit` (macOS 12.3+) | First-party, captures the active Space without composition tricks. |
| Encode / decode | VideoToolbox HEVC, hardware path | Apple Silicon native. Crispness target: ~95% of AnyDesk's DeskRT on Retina content. |
| Transport | libwebrtc via SPM, both ends | Single transport for video, input, control. |
| Network | Tailscale only | No STUN, TURN, VPS, relay. Both peers are on the tailnet. |
| Pairing | QR code on Mac, scanned by iPhone | One-shot. Signed bearer token stored in Keychain on both sides. |
| Spaces enumeration | Private CoreGraphics: `CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners` | No public API exists. Risk is App Store distribution, which is not the v0 target (Developer ID DMG). |
| Spaces switch | Synthesize `Ctrl+Arrow` via `CGEventCreateKeyboardEvent` + `CGEventPost` | Same path the OS uses for Mission Control's keyboard shortcut. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One code path on the host for all input types. |
| Distribution | Developer ID notarized DMG (Mac), TestFlight internal (iOS) | Apple Developer Program $99/yr. One device. |

ADR-0001 records this stack decision. Reference it for the rejection rationale on React Native, Flutter, browser clients, RustDesk fork, custom transport, H.264, AV1, AppleScript, direct CGS space-switch calls, WebAuthn pairing, VoIP/PiP background lifecycle, and Mac App Store distribution.

## Module boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

### Host (macOS)

1. **CaptureEngine.** Owns `ScreenCaptureKit`. Produces `CMSampleBuffer` frames for the active Space on the active display. Interface: `start(displayId) -> AsyncStream<Frame>`, `stop()`.
2. **Encoder.** Wraps VideoToolbox HEVC. Interface: `encode(Frame) -> EncodedChunk`. Hides hardware vs software fallback, keyframe cadence, bitrate adaptation.
3. **SpacesProvider.** Hides the private CoreGraphics calls and the `DesktopState` shape. Interface: `current() -> DesktopState`, `observe() -> AsyncStream<DesktopState>`.
4. **InputDispatcher.** Consumes `NormalizedInput`, emits `CGEvent`. Interface: `dispatch(NormalizedInput)`. Hides the `Ctrl+Arrow` synthesis for Spaces switch and the modifier-arm state machine.
5. **Pairing.** Generates QR payload, validates incoming tokens, stores in Keychain. Interface: `mintPairingPayload() -> PairingPayload`, `validate(token) -> SessionToken?`.
6. **SessionAuthenticator.** Runs the per-connection mutual challenge-response defined in ADR-0003 on the `/session` path of the existing TLS WebSocket. Interface: `authenticate(connection) -> ActiveSession`. Throws closed-set rejection reasons. Same test obligation as `Pairing`; the long-term key material is shared.
7. **Transport.** Wraps libwebrtc. Multiplexes video track, input data channel, control data channel. SDP and ICE travel only over an `ActiveSession` produced by `SessionAuthenticator`; the DTLS fingerprint binding is structural.

### Client (iOS)

1. **VideoRenderer.** Wraps `AVSampleBufferDisplayLayer`, renders at native DPR.
2. **GestureTranslator.** Converts UIKit gesture recognizers to `NormalizedInput`. Owns the 3-finger swipe interpretation and the modifier-arm UI state.
3. **KeyboardSurface.** Compact keyboard plus accessory row. Emits `NormalizedInput { kind: "key" }` and `modifierArm`.
4. **PairingClient.** Camera, QR decode, Keychain write.
5. **SessionDialer.** Mirror of host `SessionAuthenticator`. Drives the four-message handshake from the client side, owns the four-state UI machine (`unpaired | paired-disconnected | connecting | connected`, plus terminal `revoked`), and clears stored credentials on `revoked` / `unknown-device` / `bad-signature` per ADR-0003.
6. **Transport.** Mirror of host Transport.

Tests required for v0: **SpacesProvider, Pairing, InputDispatcher, GestureTranslator.** These four are where regressions are most expensive and where the contracts are most stable.

## Wire shapes

These come from the grilling prototype and are the load-bearing schemas. Implementations match them; renaming requires an ADR.

```
DisplayMetadata { id, name, isMain, nativePixelSize }
SpaceMetadata   { id, displayId, index }
DesktopState    { displays: [DisplayMetadata],
                  spaces: [SpaceMetadata],
                  activeDisplayId, activeSpaceId }
```

```
NormalizedInput =
  | { kind: "cursorMove", dx: Float, dy: Float }
  | { kind: "click", button: "left" | "right" | "double" }
  | { kind: "scroll", dx: Float, dy: Float }
  | { kind: "dragStart" } | { kind: "dragEnd" }
  | { kind: "switchSpace", direction: "left" | "right" }
  | { kind: "key", code: KeyCode, modifiers: ModifierMask }
  | { kind: "modifierArm", mod: "cmd" | "ctrl" | "option" | "shift" }
```

Pairing crypto details (algorithm, storage, lifetime, nonce TTL) are locked in ADR-0002.

```
PairingPayload {
  hostFingerprint    // SHA-256 over the host's P-256 public key (DER), hex
  hostPublicKey      // host P-256 public key, raw uncompressed, 65 bytes
  tailnetFQDN        // MagicDNS FQDN, may be empty if MagicDNS off
  tailnetIPv4        // CGNAT 100.x.y.z literal, always present
  oneTimeNonce       // 32 random bytes
  expiresAt          // unix seconds, issuedAt + 90
}

SessionToken {
  hostFingerprint    // links token to a specific host identity
  deviceFingerprint  // SHA-256 over the iOS device's P-256 public key
  issuedAt           // unix seconds, informational only (no enforcement)
  signature          // ECDSA P-256 over (hostFingerprint || deviceFingerprint || issuedAt)
}
```

QR encoding: `PairingPayload` is serialized to compact JSON, base64url-encoded, and embedded in a `agentdesk://pair?p=<base64url>` URL.

Session-establishment wire shapes are locked by ADR-0003 and travel on `wss://<host>:<port>/session`, distinct from the `/pair` path used by `PairingPayload`.

```
SessionInit       { deviceFingerprint, sessionToken, clientNonce }
SessionChallenge  { hostNonce, hostSignature }
SessionProof      { clientSignature }
SessionReady      { }
SessionRejected   { reason }   // reason in { revoked, unknown-device,
                               //             replay, bad-signature, malformed }
```

Both signatures are ECDSA-P256 over `"agentdesk-session" || clientNonce || hostNonce || hostFingerprint || deviceFingerprint`. `SessionToken` continues to be issued at pairing approval per ADR-0002 but is reframed as an approval-time receipt that identifies the device to the host's allowlist; it is not sufficient on its own to authenticate a session. The fresh `clientSignature` in `SessionProof` is the authentication. See ADR-0003 for the full canonical encoding, rejection-reason semantics, and the UI state machines.

## Performance budgets

- End-to-end glass-to-glass: **under 80 ms** on Tailscale over local Wi-Fi 6.
- 3-finger swipe to visible Space change on the iPhone: **under one frame at 60 Hz** after the host commits the switch.
- Text crispness: 1080p HEVC at the host's native pixel size, no client-side upscaling tricks.
- Foreground reconnect after background drop: **under 5 seconds**.

## Lifecycle

- Host runs only when the user opens it. No auto-launch on boot (charging-while-docked behavior excluded from v0).
- Client suspends on background; the WebRTC peer is torn down within 1 second; Keychain token and host pubkey persist.
- On foreground, the client transitions to `paired-disconnected` and runs the session-establishment exchange per ADR-0003 using the stored `SessionToken` to identify itself and a fresh `clientSignature` to authenticate. Re-pairing only occurs after a `revoked`, `unknown-device`, or `bad-signature` rejection from the host.

## Risks tracked outside this doc

- Private CoreGraphics API access changes between macOS versions. Mitigation: SpacesProvider is the only consumer, so a future ADR can swap the backend.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback; v0 accepts the dependency.

## Cross-references

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: GitHub issues #2 through #10
