---
status: accepted
date: 2026-05-20
---

# AgentDesk v0 stack and transport

## Context and Problem Statement

`PRD.md` commits to a v0 acceptance test: the author replaces AnyDesk for 7 consecutive days controlling a single macOS host from a single iPhone, with macOS Spaces as a first-class primitive via 3-finger swipe. `SPEC.md` records the architectural shape that delivers that. This ADR locks the seven coupled stack decisions that the v0 architecture rests on, captures the alternatives that were considered and rejected, and records the rationale so a future reader does not reopen any of them without an ADR that supersedes this one. Scope of the decisions: both Xcode projects (`host/` and `client/`), every wire-shape module named in `SPEC.md`, and the distribution channel for both ends.

## Decision Drivers

- Glass-to-glass latency under 80 ms on Tailscale over local Wi-Fi 6.
- Text crispness on Retina-scale content close to AnyDesk's DeskRT (~95% qualitatively).
- 3-finger-swipe-to-visible-Space-change under one frame at 60 Hz after the host commits the switch.
- Foreground reconnect under 5 seconds after iOS app returns from background.
- Solo developer; ~half a dev-week per year is the realistic maintenance budget for any private-API surface.
- Distribution path that does not require Apple App Store review, since macOS Spaces enumeration uses private CoreGraphics APIs that cannot be sandboxed.
- One user, one host, one client. No accounts, no marketplace, no internet rendezvous.

## Considered Options

The seven decisions are coupled but distinct. Each one had its own option set:

1. **App architecture.** Native Swift on both ends; React Native; Flutter; native Mac host plus mobile browser client; fork RustDesk.
2. **Transport.** libwebrtc over Tailscale; libwebrtc with public STUN/TURN; custom UDP/QUIC; raw WireGuard tunnel.
3. **Codec.** VideoToolbox HEVC; VideoToolbox H.264; VP9 software; AV1; DeskRT-style custom codec.
4. **Spaces access.** Private CGS reads (`CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners`) plus keystroke injection (`Ctrl+Arrow` via `CGEventPost`) for switching; AppleScript; direct private CGS space-switch calls; third-party helpers.
5. **Pairing.** QR code on Mac, bearer token in iOS Keychain; WebAuthn/passkeys; iCloud Drive shared secret; manual token paste; magic link via email.
6. **iOS lifecycle.** Drop WebRTC on background, reconnect on foreground; VoIP entitlement to stay alive; PiP to stay alive in foreground; APNs wake.
7. **Distribution.** Developer ID notarized DMG (Mac) plus TestFlight internal (iOS); Mac App Store plus iOS App Store; unsigned with manual security override; commercial cross-platform SaaS.

## Decision Outcome

**1. App architecture: native Swift on both ends.** Native UIKit on iOS for the client, native AppKit menu-bar host on macOS using `NSStatusItem`. Both targets import libwebrtc via Swift Package Manager. React Native and Flutter are rejected because they cannot match VideoToolbox hardware codec integration without native bridges, and the bridges defeat the cross-platform savings. A browser client is rejected because crisp HEVC text rendering in Safari iOS is historically finicky, and neither AnyDesk nor TeamViewer ship a mobile browser client; chasing it for v0 is the wrong fight. Forking RustDesk is rejected on license grounds (AGPL-3.0 contamination of any closed-source direction) and architecture grounds (RustDesk is a complete product wrapped around its `hbbs/hbbr` rendezvous service, not a library to embed). RustDesk's architecture remains useful reference material; nothing more.

**2. Transport: libwebrtc over Tailscale only.** Both peers are on the user's tailnet. The host opens an in-process signaling WebSocket on its tailnet hostname; the iOS client connects directly. No STUN, no TURN, no external signaling server, no VPS. libwebrtc was chosen over a custom UDP/QUIC stack because it carries audio/video tracks and data channels in one transport with mature ICE, congestion control, and packet pacing; replicating that is months of work outside scope. WireGuard alone is rejected because it gives a tunnel, not the framing and congestion control needed for a smooth video session.

**3. Codec: VideoToolbox HEVC, hardware path on both ends.** Decoded into `AVSampleBufferDisplayLayer` on iOS sized to the device's native pixel resolution; no client-side upscaling. H.264 hardware is rejected because its bitrate-vs-crispness curve on Retina text is worse at the 15-25 Mbps the LAN can comfortably carry. VP9 and AV1 are rejected because Apple Silicon hardware decode for both is partial (AV1 decode arrived on iPhone 15 Pro but encode is not hardware-accelerated). A DeskRT-style custom codec is rejected on the maintenance budget; AnyDesk's DeskRT exists because they have a codec team.

**4. Spaces access: private CGS reads plus keystroke injection writes.** The host wraps `CGSGetActiveSpace`, `CGSCopySpaces`, and `CGSSpaceCopyOwners` behind the `SpacesProvider` interface in `SPEC.md`. Switching is done by synthesizing `Ctrl+Arrow` events via `CGEventCreateKeyboardEvent` plus `CGEventPost`, which is the same path the OS uses for the keyboard shortcut. Direct private CGS space-switch calls are rejected because mutating the most fragile private surface costs more across macOS majors than synthesizing a documented public-API keystroke. AppleScript is rejected because Mission Control's AppleScript surface is incomplete and lags actual behavior. The maintenance budget for the read side is ~half a dev-week per year; if the enumeration API breaks, the fallback is blind keystroke switching (no indicators) until repair.

**5. Pairing: QR code on Mac, bearer token in iOS Keychain.** Host popover shows a QR encoding `{hostFingerprint, tailscaleHostname, oneTimeNonce, expiresAt}`. iPhone scans it, contacts the host over the tailnet, host raises an approval sheet on the Mac, and on approval issues a `SessionToken` signed with the host's private key. The iOS app stores the token in the Keychain (Secure Enclave-backed when available). WebAuthn/passkeys are rejected because we have no relying party server; both ends are clients of each other. iCloud Drive is rejected because it adds a third-party trust dependency for what is a two-device problem. Magic links and manual paste are rejected on UX grounds for a one-time setup that should take one camera scan.

**6. iOS lifecycle: drop on background, reconnect on foreground.** WebRTC peer connection tears down within 1 second of the iOS app entering background; reconnect target is under 5 seconds end-to-end when foregrounded, including ICE restart and first keyframe. No VoIP entitlement, no PiP for background continuity, no APNs wake. These alternatives all keep the connection alive at battery cost without a real use case for v0 (the author is glancing at the phone, not running a 24/7 session). The reconnect overlay shows the dimmed last-received frame so the wait is grounded.

**7. Distribution: Developer ID notarized DMG (Mac) plus TestFlight internal (iOS).** Apple Developer Program at $99/yr funds both. The Mac App Store is closed because the host uses private CoreGraphics APIs and cannot be sandboxed. TestFlight internal (one device) is sufficient for the iOS side; App Store submission is out of scope for v0. The pre-cert pivot recorded in `agent-desk/agent-memory/project_signing_pivot.md` uses Xcode automatic free signing during the enrollment throttle, with the Developer ID DMG and TestFlight upload deferred to S8 acceptance.

### Consequences

- Good, because every load-bearing decision aligns with the 7-day daily-driver acceptance test in `PRD.md`. There is no architectural branch left for a future "v0.5 cross-platform" pivot to muddle.
- Good, because each decision has a named module owning the surface (`Transport`, `Encoder`, `SpacesProvider`, `Pairing`, etc., per `SPEC.md`). Future ADRs supersede this one at the decision level by replacing one module's interface; the rest stay.
- Bad, because private CGS API access is a maintenance liability across macOS majors. Mitigation: keystroke injection for switching keeps the mutating surface on a public API, and `SpacesProvider` localizes the read-side surface to one module.
- Bad, because Mac App Store distribution is permanently foreclosed by the private API choice. Acceptable for v0; if App Store distribution ever becomes a goal, a new ADR with a different SpacesProvider backend is required.
- Bad, because libwebrtc is large (~5 MB) and famously painful to update. Mitigation: pin a known-good version for v0; do not chase upstream during the iteration.
- Neutral, because Tailscale-only networking means AgentDesk does not work outside the tailnet. Explicitly accepted in `PRD.md` non-goals; not a regression.

### Confirmation

The decision is being followed if all of the following hold during a code review:

- `host/` and `client/` are both Swift targets with no React Native, Flutter, or web framework dependencies.
- `Package.swift` in both targets lists libwebrtc and no alternate WebRTC implementation.
- The host imports `ScreenCaptureKit` and `VideoToolbox`; the client imports `AVFoundation` for `AVSampleBufferDisplayLayer`. No software H.264, VP9, or AV1 codec dependencies appear.
- The host's `SpacesProvider` module is the sole consumer of private CGS symbols; no other file references `CGSGetActiveSpace`, `CGSCopySpaces`, `CGSSpaceCopyOwners`, or any direct space-switch CGS call.
- The host's `InputDispatcher` performs Spaces switching via `CGEventCreateKeyboardEvent` plus `CGEventPost` and no other path.
- No `Info.plist` declares the VoIP background mode or the PiP entitlement.
- No code calls STUN or TURN servers, and no configuration file lists a STUN/TURN URL.

Any pull request introducing a new transport, codec, network rendezvous, distribution channel, or Spaces-access backend requires a new ADR that supersedes this one.

## Pros and Cons of the Options

Most decisions in this ADR are forced by the drivers; pros/cons only earn their place where the call was genuinely close.

### App architecture: native Swift versus React Native or Flutter

- Native Swift, good: VideoToolbox, ScreenCaptureKit, private CoreGraphics, Keychain, and AVSampleBufferDisplayLayer are all first-party APIs reachable without bridging. UIKit and AppKit gesture stacks are mature. App Store path is open if ever needed (modulo the private CGS choice).
- Native Swift, bad: two codebases to maintain (host and client) even though they share `NormalizedInput`, `PairingPayload`, and `SessionToken` shapes. Solo developer pays full cost on both ends.
- React Native, good: one codebase for the iOS client. JS ecosystem has more contributors than Swift on the mobile side.
- React Native, bad: every load-bearing decision (VideoToolbox HEVC integration, libwebrtc native binding, gesture recognizer behavior at 60+ fps, Keychain with Secure Enclave) requires a native bridge. The bridges are the actual work; React Native saves nothing for this product.
- Flutter, good: better rendering performance than React Native, mature native interop story.
- Flutter, bad: same native-bridge tax as React Native, plus a Dart codebase the developer does not maintain elsewhere. No reuse benefit.

### Codec: HEVC versus H.264

- HEVC, good: ~30-40% better compression at equivalent perceptual quality, which buys text crispness at LAN-class bitrates without saturating Wi-Fi. Apple Silicon hardware encode and decode are first-class. AnyDesk's text-crispness reputation rests on HEVC on Retina.
- HEVC, bad: licensing carries patent exposure if commercial distribution ever scales. Acceptable for v0 (one user, no commercial distribution).
- H.264, good: universal, lower CPU on older hardware.
- H.264, bad: the bitrate-vs-crispness curve on Retina text is worse. Hitting AnyDesk-class crispness in H.264 would require 30-40 Mbps where HEVC needs 15-25, eating headroom that should belong to gesture responsiveness.

## Links

- `PRD.md`: v0 acceptance test, user surface, explicitly deferred.
- `SPEC.md`: stack table, module boundaries, wire shapes, performance budgets. This ADR is referenced from the SPEC stack table.
- `agent-desk/agent-memory/project_signing_pivot.md`: temporary Xcode free signing during Apple Developer Program throttle.
- GitHub issue #1: original PRD with 44 user stories, including the RustDesk rejection rationale and the "code-aware crisp-text overlay" v1+ escape hatch.
- GitHub issue #2 (S0): the slice this ADR is gating.
