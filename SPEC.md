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

ADR-0001 (to be written under S0) records this stack decision.

## Module boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

### Host (macOS)

1. **CaptureEngine.** Owns `ScreenCaptureKit`. Produces `CMSampleBuffer` frames for the active Space on the active display. Interface: `start(displayId) -> AsyncStream<Frame>`, `stop()`.
2. **Encoder.** Wraps VideoToolbox HEVC. Interface: `encode(Frame) -> EncodedChunk`. Hides hardware vs software fallback, keyframe cadence, bitrate adaptation.
3. **SpacesProvider.** Hides the private CoreGraphics calls and the `DesktopState` shape. Interface: `current() -> DesktopState`, `observe() -> AsyncStream<DesktopState>`.
4. **InputDispatcher.** Consumes `NormalizedInput`, emits `CGEvent`. Interface: `dispatch(NormalizedInput)`. Hides the `Ctrl+Arrow` synthesis for Spaces switch and the modifier-arm state machine.
5. **Pairing.** Generates QR payload, validates incoming tokens, stores in Keychain. Interface: `mintPairingPayload() -> PairingPayload`, `validate(token) -> SessionToken?`.
6. **Transport.** Wraps libwebrtc. Multiplexes video track, input data channel, control data channel.

### Client (iOS)

1. **VideoRenderer.** Wraps `AVSampleBufferDisplayLayer`, renders at native DPR.
2. **GestureTranslator.** Converts UIKit gesture recognizers to `NormalizedInput`. Owns the 3-finger swipe interpretation and the modifier-arm UI state.
3. **KeyboardSurface.** Compact keyboard plus accessory row. Emits `NormalizedInput { kind: "key" }` and `modifierArm`.
4. **PairingClient.** Camera, QR decode, Keychain write.
5. **Transport.** Mirror of host Transport.

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

```
PairingPayload { hostFingerprint, tailscaleHostname, oneTimeNonce, expiresAt }
SessionToken   { hostFingerprint, deviceFingerprint, signature, issuedAt }
```

## Performance budgets

- End-to-end glass-to-glass: **under 80 ms** on Tailscale over local Wi-Fi 6.
- 3-finger swipe to visible Space change on the iPhone: **under one frame at 60 Hz** after the host commits the switch.
- Text crispness: 1080p HEVC at the host's native pixel size, no client-side upscaling tricks.
- Foreground reconnect after background drop: **under 5 seconds**.

## Lifecycle

- Host runs only when the user opens it. No auto-launch on boot (charging-while-docked behavior excluded from v0).
- Client suspends on background; the WebRTC peer is torn down within 1 second; Keychain token persists.
- On foreground, reconnect uses the stored `SessionToken`; no re-pairing.

## Risks tracked outside this doc

- Private CoreGraphics API access changes between macOS versions. Mitigation: SpacesProvider is the only consumer, so a future ADR can swap the backend.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback; v0 accepts the dependency.

## Cross-references

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: GitHub issues #2 through #10
