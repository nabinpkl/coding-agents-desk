# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit menu-bar app via `NSStatusItem` plus a floating `NSPanel` Space Agent | Fresh implementation, owned end-to-end. The menu-bar host remains the server/status process; Space Agent is a local desktop navigator. |
| iOS client | Swift, UIKit, current `AVSampleBufferDisplayLayer` baseline with a retained BGRA compositor target in this worktree | Native required for text crispness and gesture fidelity. Browser path rejected in `PRD.md`. The branch target decodes HEVC through `VTDecompressionSession` into one retained compositor surface. |
| Capture | `ScreenCaptureKit` on macOS 26+ | First-party selected-display capture without composition tricks. |
| Encode / decode | Hardware-required VideoToolbox, HEVC by default and H.264 as an explicit owned-media codec setting | Rest-state text crispness depends on hardware screen-content quality. In this worktree HEVC remains the full-frame refresh path while retained graphics commands target scroll motion. |
| Transport | One authenticated `NetworkConnection<QUIC>` per live session, ALPN `agentdesk-session-quic-v2` | ADR-0030 is the current live-session architecture. Control and input use ordered QUIC streams. HEVC media uses the same connection's datagram lane. Session liveness belongs to the QUIC connection, not to media, so media loss or decode failure must not end input. |
| Network | Tailscale only | No public rendezvous, relay, or internet routing. Both peers are on the tailnet. |
| Pairing | Mac-initiated tailnet device picker (ADR-0019), QR fallback | The Mac enumerates online iOS tailnet peers, probes each on the plain-TCP offer port (`AGENTDESK_OFFER_PORT`, default 41890) for a self-reported display name, and pushes a pre-approved signed offer to the picked device. The pick is the authorization. The iPhone runs the unchanged signed handshake. Signed token stored in Keychain on both sides. |
| Wire compatibility | Protocol version 3 only (ADR-0020, ADR-0030) | Host and client version independently; the wire protocol, not the app version, is the compatibility contract. `SessionInit`/`SessionChallenge` advertise `protocolVersion` and `minCompatibleProtocolVersion`; v0 rejects any peer below `3` with `incompatible-protocol`. There is no legacy WebSocket fallback. |
| Spaces enumeration | Private SkyLight/CoreGraphics symbols bound with `dlopen` and `dlsym` | No public API exists. Risk is acceptable because App Store distribution is not the v0 target. |
| Spaces switch | Synthesize Dock swipe `CGEvent`s via `SpacesProvider.postDockSwipeFrame` and `commitStep(delta:)` | Stock macOS path that preserves live Space transition animation. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One host code path for all remote input. |
| Distribution | Developer ID notarized DMG for Mac, TestFlight internal for iOS | One author, one device. |

ADR-0001 records the original v0 stack decision. ADR-0015 records the owned single-surface media baseline. ADR-0016 records the scroll-first hybrid retained-graphics worktree architecture that has since been narrowed by the video-primary work. ADR-0019 records Mac-initiated tailnet pairing with a host-side device picker. ADR-0020 records the handshake-negotiated wire protocol version. ADR-0021 through ADR-0025 record the retained-graphics and motion-carrier iterations. ADR-0026 through ADR-0029 record the video-primary, adaptive bitrate, NACK, and slow-link survival work. ADR-0030 records the current live-session transport: a single authenticated QUIC connection with control, input, and media lanes, protocol version `3`, and no WebSocket or separate media/graphics fallback. ADR-0031 records client-visible selected-display projection, keeping display choice separate from Spaces sliding. ADR-0032 records bounded durable client diagnostics with on-demand host retrieval over the input lane and a foreground tailnet control fallback. ADR-0033 records the adaptive media quality ladder that chooses bitrate, FPS, and capture resolution together from host-owned heuristics.

## Module Boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

### Host

1. **CaptureEngine.** Owns ScreenCaptureKit. Produces `CMSampleBuffer` frames for the selected display. In the hybrid worktree the same capture stream feeds HEVC full-frame refresh and the planned scroll delta engine. Display switches restart the capture stream and force the first post-switch frame to be a keyframe.
2. **Encoder.** Wraps VideoToolbox and produces `OwnedMediaFrameEnvelope` payloads for HEVC full-frame refreshes. It fails the media path if the required hardware encoder cannot start.
3. **SpacesProvider.** Enumerates Spaces through SkyLight/CoreGraphics bindings and forwards Space-swipe gestures through Dock-handled events. It reports host display labels, bounds, main-display status, active display id, and selected display id in `DesktopState`.
4. **InputDispatcher.** Consumes `NormalizedInput` and emits `CGEvent`. Space-switch gestures stream through the injected `SpacesProvider` handler. Cursor input is clamped against the selected display bounds.
5. **Pairing.** Generates pairing payloads, validates approval tokens, and stores allowlisted devices in Keychain-backed state. Holds the in-memory pre-approval set: a Mac-side device pick marks the offer's one-time nonce pre-approved, so the signaling server issues the token without a prompt when the iPhone dials back with it. The nonce is still consumed once, in `issueApprovedSessionToken`. Records the client-reported display name on the paired record so the host UI shows which device it is.
6. **TailnetDiscovery.** Parses `tailscale status --json` into online tailnet peers (`TailnetDeviceOption`), keeping iOS peers with a tailnet IPv4 and ordering online ones first. The JSON parser is split out for unit testing without running `tailscale`.
7. **PairingOfferSender.** Outbound plain-TCP `NWConnection` to a picked peer's offer port. Writes one length-prefixed `PairingPayload` and closes. Plaintext is acceptable: WireGuard encrypts the peer hop, the host public key in the payload is already public, and the nonce is one-use and pre-approval-gated.
8. **TailnetIdentityProber.** Outbound `whois` probe on the offer port. An unpaired client whose listener is running replies with a display-only `DeviceIdentity`; the picker lists only the peers that answered, by their reported name. Display-only and pre-auth: tailnet membership is the trust boundary and the signed handshake still gates pairing.
9. **ClientDiagnosticsRequester.** Host-side on-demand diagnostics collector. It requests diagnostics from the active paired client over the session input lane first, then falls back to the foreground tailnet control path on the offer port using the stored paired host key for request signing. Dev automation writes retrieved runs under `/tmp/agentdesk-client-diagnostics-<timestamp>/`.
10. **SessionAuthenticator.** Runs the per-connection mutual challenge-response on the session QUIC control stream. Rejects a peer whose advertised `protocolVersion` is below the host's `minCompatibleProtocolVersion` with `incompatible-protocol` (ADR-0020). Produces `SessionReady` with the session id, memory-only resume id, resume secret, resume expiry, and media key salt.
11. **QuicSessionTransport.** Owns the single live `NetworkConnection<QUIC>` and routes lanes by role. The control stream carries session init, challenge, proof, ready, resume, revoke, and heartbeat. The input stream carries `InputChannelEvent`, `ClientConfig`, diagnostics requests, and host pushes. The datagram lane carries authenticated `ADMD` media packets, packet resend requests, keyframe requests, ACKs, and link-health reports.
12. **MediaTransport.** Sends HEVC full-frame refreshes over the session datagram lane. The media packet key is derived per session from fresh handshake material, the session id, and the `SessionReady.mediaKeySalt`; no static datagram key or separate media listener remains.
13. **ScrollDeltaEngine.** Rest-state retained-graphics producer (ADR-0025), retained as local crisp-repair/compositor machinery. Damage tiles through the content-cache ladder (`cacheTile`/`drawCachedTile`/`bitmapTile`), omitting cells that already match the retained baseline. It does not own a separate network connection.
14. **InputChannelServer.** Owns the host side of the session input stream. Drains `InputChannelEvent` frames into `NormalizedInput`, and pushes desktop state, thumbnails, cursor image updates, cursor-position corrections, agent speech events, and diagnostics responses on the same ordered lane.
15. **SignalingChannel.** Supplies length-prefixed QUIC stream framing and role routing for the session control and input streams. It is not a WebSocket wrapper.
16. **VideoFrameSource.** Concrete implementation `ScreenCaptureKitFrameSource` captures one stream for the selected display and exposes a display-selection hook. `TestPatternFrameSource` exists as a diagnostic source.
17. **SpaceThumbnailProvider.** Host-local thumbnail source for Spaces, enabled by owner-scoped demand.
18. **SpaceAgent.** Host-local overlay under `host/AgentDeskHost/SpaceAgent/`, showing the draggable spaceship and active-display Spaces strip.
19. **DictationBar.** Host-local push-to-talk overlay under `host/AgentDeskHost/DictationBar/`, independent of the iPhone media and input channels.

### Client

1. **VideoFrameSink.** Concrete implementation `OwnedMediaVideoSink` owns one `AVSampleBufferDisplayLayer`, decodes `OwnedMediaFrameEnvelope` payloads, and renders the selected display surface. This is the current baseline. It preserves delta continuity by enqueuing complete deltas, and flushes queued display history only when the layer reports failure or requires flush to resume. Attached console traces split the owned-media lifecycle into host capture/admission/encode/send/ACK, transport packet completion and repair, client complete-to-render enqueue, and estimated display-layer state. Display traces explicitly mark `displayPresentation=estimated`; true on-screen presentation timing is not claimed with the current `AVSampleBufferDisplayLayer` renderer.
2. **GestureTranslator.** Converts UIKit gestures on the trackpad and scroll-strip surfaces to `NormalizedInput`. It does not send media quality hints.
3. **DisplayRailView.** Tap-based display selector driven by `DesktopStatePush` from the input channel. It labels host displays separately from the Spaces strip.
4. **SpacesDotsView.** One-handed Spaces switch surface driven by `DesktopStatePush` from the input channel. It filters Spaces by `selectedDisplayId` when present, falling back to `activeDisplayId`.
5. **KeyboardSurface.** Compact keyboard plus accessory row. Emits key and modifier input frames.
6. **PairingClient.** QR decode, token verification, and Keychain write. Reports the device display name (`UIDevice` name or hardware model identifier plus a short per-device id) in the handshake so the host labels the paired record. Its `TailnetServerTrustDelegate` applies strict TLS validation to FQDN dials and, for a tailnet CGNAT IPv4 literal (100.64.0.0/10), validates the cert chain but skips the hostname match, because the FQDN-only `tailscale cert` cannot pass a hostname check on an IP literal (ADR-0019). The L3 WireGuard peer auth plus the signed handshake are the real authentication.
7. **PairingOfferListener.** `NWListener` on the offer port, running only while the app is foregrounded. When the app is unpaired it routes pairing offers and `whois` probes. When paired, it additionally accepts authenticated `diagnostics-request` frames from the paired host and returns diagnostics summaries and chunks. It prefers the `utun` tailnet IPv4 (100.x) over a carrier-CGNAT address when reporting its own address.
8. **SessionDialer.** Client mirror of session authentication. Rejects a host whose `protocolVersion` is below the client minimum with `incompatible-protocol` (ADR-0020). Opens the single QUIC session connection, authenticates on the control stream, resumes with a memory-only token inside the grace window, and clears stored credentials on terminal rejection.
9. **QuicSessionTransport.** Owns the connected client QUIC session. Input/control sends are immediate. Media datagrams are paced and are the first lane to drop or degrade under pressure.
10. **MediaTransport.** Uses the session datagram lane to verify `ADMD` v2 packets, repair missing packet indexes before deadline, skip stale delta frames, and ask for keyframe recovery only when decoder continuity requires it.
11. **OwnedHEVCFrameDecoder.** Planned `VTDecompressionSession` bridge for the hybrid worktree. It decodes HEVC refreshes into `CVPixelBuffer` output instead of enqueueing directly into `AVSampleBufferDisplayLayer`.
12. **OwnedSurfaceCompositor.** Planned `@MainActor` single writer for the retained BGRA surface. It applies HEVC full-surface refreshes and retained graphics commands in strict `(surfaceGeneration, frameId)` order, then commits the visible layer.
13. **InputChannel.** Reliable input lane inside the authenticated session QUIC connection. It stays logically independent from media even though both lanes share the same connection. It sends `ClientConfig.selectedDisplayId` when the user picks a display, receives cursor-position corrections and `DiagnosticsRequest` from the host, and returns diagnostics summaries and chunks.
14. **ClientDiagnosticsStore.** Bounded durable client diagnostics store in `Application Support/Diagnostics`. It persists structured NDJSON essentials for the current run plus two prior runs, rotates unclean exits on bootstrap, mirrors essentials to OSLog, summarizes delayed MetricKit payloads, and serves prior-run tails on demand over the input lane or the foreground tailnet control listener.

Tests required for v0: **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView.** Additional owned-media contract tests pin wire shapes, packet repair, and decoder recovery behavior where regressions are expensive.

## Wire Shapes

These schemas are load-bearing. Renaming requires an ADR.

```
DisplayMetadata { id, name, label, isMain, originX, originY, nativePixelSize }
SpaceMetadata   { id, displayId, index }
DesktopState    { displays: [DisplayMetadata],
                  spaces: [SpaceMetadata],
                  activeDisplayId, selectedDisplayId, activeSpaceId }
```

```
NormalizedInput =
  | { kind: "cursorSet", displayId: String, x: Float, y: Float }
  | { kind: "cursorMove", dx: Float, dy: Float }
  | { kind: "click", button: "left" | "right" | "double" }
  | { kind: "scroll", dx: Float, dy: Float, phase?: "began"|"changed"|"ended"|"momentumBegan"|"momentumChanged"|"momentumEnded" }
  | { kind: "dragStart" } | { kind: "dragEnd" }
  | { kind: "switchSpaceGesture", phase: "began"|"changed"|"ended"|"cancelled", progress: Float, velocityX: Float }
  | { kind: "key", code: KeyCode, modifiers: ModifierMask }
  | { kind: "modifierArm", mod: "cmd" | "ctrl" | "option" | "shift" }
```

Pairing crypto details are locked in ADR-0002.

```
PairingPayload {
  hostFingerprint
  hostPublicKey
  tailnetFQDN
  tailnetIPv4
  oneTimeNonce
  expiresAt
}

SessionToken {
  hostFingerprint
  deviceFingerprint
  issuedAt
  signature
}
```

Mac-initiated pairing rides a dedicated plain-TCP offer port (ADR-0019), separate from the TLS signaling channel so it sidesteps the IP-literal certificate problem. Every message is one length-prefixed frame; the body's `t` tag routes it.

```
OfferPortFrame    = UInt32BE length || body          // length-prefixed JSON body

// body, routed by OfferPortMessage.classify:
PairingOffer      = PairingPayload                    // untagged; the offer itself
DeviceIdentityRequest { t: "whois" }                 // Mac probes a peer
DeviceIdentity        { t: "id", n: displayName }     // client's display-only reply
SignedDiagnosticsRequest { t: "diagnostics-request", rid, sr?, pr, mb?,
                           hf, ts, n, hs }
DiagnosticsSummary      { t: "diagnostics-summary", rid, r, de, db, mk? }
DiagnosticsChunk        { t: "diagnostics-chunk", rid, s, f, run, ub, p }
DiagnosticsError        { t: "diagnostics-error", rid, r }
```

The offer is an untagged `PairingPayload`; the iPhone synthesizes its `pairingURL()` locally and reuses the QR handshake path. `whois`/`id` carry only a display name for the picker and are pre-auth; the signed handshake still gates pairing.
Foreground diagnostics fallback reuses the same offer port only when the app is paired and foregrounded. The host signs the request body with the paired host key; the client rejects a request whose host fingerprint does not match the stored pairing, whose signature fails, or whose timestamp is older than 60 seconds.

Session establishment is locked by ADR-0003, ADR-0011, ADR-0020, and ADR-0030. Frames on QUIC streams are length-prefixed JSON payloads.

```
QuicStreamFrame   = UInt8 role || UInt32BE length || body
role              = 1 control | 2 input

SessionInit       { deviceFingerprint, sessionToken, clientNonce,
                    protocolVersion, minCompatibleProtocolVersion }   // pv must be >= 3
SessionChallenge  { hostNonce, hostSignature, protocolVersion }
SessionProof      { clientSignature }
SessionReady      { sessionId, resumeId, resumeSecret, resumeExpiresAt, mediaKeySalt,
                    hostSignature }
SessionResumeInit { deviceFingerprint, sessionId, resumeId, clientNonce,
                    protocolVersion }
SessionResumeChallenge { hostNonce, resumeExpiresAt, hostSignature }
SessionResumeProof     { proof }
SessionRejected   { reason }   // reason includes "incompatible-protocol", "expired-resume"
```

`SessionResumeInit` does not carry a bearer secret. The host accepts the public
`resumeId` only long enough to issue one pending `SessionResumeChallenge`, then
signs the challenge over the session id, device fingerprint, resume id, client
nonce, host nonce, expiry, protocol version, ALPN, and host fingerprint. The
client verifies that signature with the stored paired host public key before it
sends `SessionResumeProof`. The proof is an HMAC over the session id, device
fingerprint, resume id, client nonce, host nonce, protocol version, and session
ALPN using the memory-only `resumeSecret`. Success consumes the pending challenge
and rotates resume id, resume secret, and media key salt in the next signed
`SessionReady`; the client verifies the ready signature before accepting the new
material.

Each side rejects with `incompatible-protocol` when the peer's advertised `protocolVersion` is below its own `minCompatibleProtocolVersion`. v0 now sets both to `3`; older builds parse only far enough to be rejected. Matching marketing versions across host and client is not a compatibility signal; the protocol version is.

Owned media travels over the unified QUIC session's datagram lane after `SessionReady`.

```
OwnedMediaControlMessage { kind: "keyframe-request", frameId }                    // t: "owned-media-control"
OwnedMediaControlMessage { kind: "packet-resend-request", frameId, packetIndexes } // compact key px
OwnedMediaControlMessage { kind: "frame-ack", frameId, totalFramesDecoded,
                           renderGapMs, clientBacklogFrames,
                           clientBacklogBytes }                                  // compact keys td, rg, qf, qb

The host derives `frameAgeMs` for admission by matching `frame-ack.frameId` to
its sent-frame table and comparing the original capture timestamp with host
uptime when the ACK arrives. The iPhone does not send this value because host
and device monotonic clocks are not comparable.

The media packet HMAC key is derived per session from the authenticated handshake
material, session id, and `SessionReady.mediaKeySalt`. Static datagram keys are
not valid in protocol version 3.

ADMD packet =
  "ADMD" || version=2 || kind=3 || flags: UInt8 ||
  generation=0: UInt32BE || frameId: UInt64BE ||
  packetIndex: UInt16BE || packetCount: UInt16BE ||
  sentAtUptimeNs: UInt64BE || payloadLength: UInt16BE ||
  hmacSha256(headerWithoutMac || payload) || payload

flags bit 0 = keyframe

OwnedMediaFrameEnvelope =
  "ADMF" || version=1 || headerLength: UInt32BE || headerJSON || payload

OwnedMediaFrameHeader {
  frameId,
  codec: "hevc" | "h264",
  width, height,
  capturedAtUptimeNs,
  presentationTimeNs,
  isKeyframe,
  parameterSets?,
  payloadFormat: "length-prefixed-nal"
}
```

The payload is the VideoToolbox access-unit sample data with length-prefixed NAL units. Keyframes carry codec parameter sets in the JSON header so the iOS receiver can create or refresh its `CMVideoFormatDescription` before enqueueing the sample buffer.

Retained-graphics payload shapes remain as local crisp-repair/compositor contracts. They are not a separate live-session transport in ADR-0030.

```
OwnedSurfaceUpdateId { surfaceGeneration, frameId }

OwnedMediaFrameHeader {
  ...
  surfaceGeneration,
  frameId,
  capturedAtUptimeNs,   // diagnostics only
  refreshReason: "initial" | "rest" | "scroll-correctness" | "reset"
}

ADGC frame =
  "ADGC" || version=1 || headerLength: UInt32BE || headerJSON || payload

OwnedGraphicsFrameHeader {
  surfaceGeneration,
  frameId,
  capturedAtUptimeNs,   // diagnostics only
  commandCount,
  payloadLength
}

OwnedGraphicsCommand =
  | { kind: "resetSurface", surfaceGeneration, width, height, pixelFormat: "bgra" }
  | { kind: "bitmapTile", x, y, width, height, compression: "lzfse", byteRange }
  | { kind: "cacheTile", slot, x, y, width, height, compression, byteRange }
  | { kind: "drawCachedTile", slot, x, y, width, height }

// ADR-0025 motion carrier, on the session QUIC datagram lane:
OwnedMediaFrameEnvelope { header: OwnedMediaFrameHeader, payload }  // length-prefixed NAL
MediaDatagramFramePacket  // "ADMD", HMAC-authenticated MTU fragments of an envelope
OwnedMediaControlMessage { kind: "keyframe-request" | "packet-resend-request", frameId, packetIndexes }

OwnedGraphicsFrameAck { surfaceGeneration, frameId, compositorMs, staleDiscardCount }
OwnedGraphicsResetRequest { reason, lastCommittedSurfaceGeneration, lastCommittedFrameId }
```

All tile updates compare only `(surfaceGeneration, frameId)`. `capturedAtUptimeNs` is never an ordering key. `resetSurface` accepts only a strictly newer `surfaceGeneration`, initializes committed order to `(surfaceGeneration, 0)`, then applies reset tiles. Rest-state damage tiles through the content-cache ladder (`cacheTile`/`drawCachedTile`/`bitmapTile`). Scrolling motion does not ride a retained-graphics stream: it plays as full-surface hardware HEVC over the session QUIC datagram lane (`OwnedMediaFrameEnvelope` fragmented into `MediaDatagramFramePacket`s), decoded by display on the client. Local retained surface code remains available for crisp repair.

Input-lane wire shapes are locked by ADR-0005, ADR-0011, and ADR-0030.

```
InputChannelEvent  { event: NormalizedInput }                         // t: "input-event"
InputChannelClose  { reason }                                         // t: "input-close"
DesktopStatePush   { state: DesktopState }                            // t: "desktop-state"
CursorPositionPush { displayId?, cursorX, cursorY }                    // t: "cursor-position"
ClientConfig        { thumbnailsEnabled, thumbnailRefresh?,
                      selectedDisplayId? }                             // t: "client-config"
DiagnosticsRequest  { requestId, sinceRunId?, includePreviousRuns,
                      maxBytes? }                                      // t: "diagnostics-request"
DiagnosticsSummary  { requestId, runs, droppedEvents, droppedBytes,
                      latestMetricKitPayloadAt? }                      // t: "diagnostics-summary"
DiagnosticsChunk    { requestId, sequence, isFinal, runId,
                      uncompressedBytes, payloadBase64 }               // t: "diagnostics-chunk"
DiagnosticsError    { requestId, reason }                             // t: "diagnostics-error"
```

`NormalizedInput.cursorSet { displayId, x, y }` is an absolute cursor retarget in host/global display points, same coordinate space as `DesktopState.cursorX/cursorY`. The host accepts it only when `displayId` matches the currently selected display, clamps it to that display bounds, posts one mouse move, and uses the set point as the base for subsequent relative cursor moves. The iPhone uses it after manual zoomed-viewport pan: viewport browsing stays local, then the next pointer-location-dependent action sends `cursorSet` before the original pointer input so the host cursor starts from the visible region.

`DiagnosticsChunk.payloadBase64` is gzipped NDJSON. The client caps each encoded payload chunk at 48 KB and the total response at 768 KB unless the host requests less.

## Diagnostics Retention

- The client persists structured essentials to `Application Support/Diagnostics`.
- Retention is fixed for v0: current run plus two previous runs, 2 MB per run, 6 MB total.
- When the current run exceeds its cap, oldest events are dropped from that run first.
- On next launch, an unfinished current run is rotated to the archive set and surfaced as `previousRunUncleanExit`.
- Prior unclean runs remain requestable until the host retrieves them or bounded retention evicts them.

## Recovery Policy

- Packet repair is first resort. The client sends one missing-index request per frame repair window.
- The host resend ring keeps exact authenticated datagrams and resends only requested indexes still in the ring.
- Capture freshness is enforced before VideoToolbox. The host keeps one latest raw capture frame, coalesces stale pending captures while transport is busy or the client is behind, and only encodes frames it intends to send.
- Motion budget can downscale capture before VideoToolbox while link pressure is active. This is a media-quality rung, not a client zoom mode: rest recovers toward native capture, the client remains a single surface, and input coordinates stay in host logical space.
- Frame ACKs are the host-side admission fence and latency signal. Normal cadence allows two unacknowledged frames, behind cadence allows one, and draining cadence allows none until ACKs clear or the drain timeout reopens latest-frame admission. The host derives ACK age from its own sent-frame timestamps; the client does not report frame age because peer monotonic clocks are not comparable.
- If a behind or draining frame stays unacknowledged past the stale-unacked deadline, the host abandons it for admission accounting and holds encode admission while the raw capture mailbox keeps coalescing. This prevents one late lifecycle ACK from freezing capture admission without amplifying congestion with large recovery keyframes.
- Explicit keyframe requests are counted as quality pressure and deferred while draining. Periodic keyframes are suppressed while behind or draining, and a second keyframe is blocked while a prior keyframe is unacknowledged.
- The adaptive quality controller owns one target `{ bitrateKbps, fps, resolutionScale, rung, reason }`. It spends bitrate first, then shifts through fixed readable resolution/FPS rungs under sustained loss, repair expiry, keyframe fallback, or ACK queueing plus loss. High ACK age alone holds the current rung. Recovery raises bitrate before resolution and FPS.
- A resolution rung restarts ScreenCaptureKit for the selected display, clears stale pending capture/encode state, and forces the next video frame to be a keyframe. The client accepts a new video resolution only at a keyframe; a delta at unexpected dimensions is dropped and triggers bounded keyframe recovery.
- Once a frame is encoded, the host sends the whole frame. Backpressure adjusts encode cadence and datagram pacing; it does not drop encoded delta frames.
- A frame repaired before the deadline renders in order.
- An expired delta frame is skipped as stale output.
- An expired keyframe, decoder failure, malformed packet, or authentication failure requests keyframe recovery.
- Stale unacknowledged host frames and drain timeouts do not force keyframe recovery. Keyframe recovery is reserved for decoder continuity failures, incomplete keyframes, malformed/auth failures, and explicit client requests.
- Media lane failure or decoder failure does not end the session. Control and input stay live unless the QUIC session itself is revoked, fails auth, is backgrounded by iOS policy, or exceeds the resume grace window.

## Performance Budgets

- End-to-end glass-to-glass: under 80 ms on Tailscale over local Wi-Fi 6.
- Space-swipe to visible Space change on the iPhone: under one frame at 60 Hz after host commit.
- Text crispness: native Retina-scale capture at rest, no client-side upscaling trick.
- Foreground reconnect after background drop: under 5 seconds.

## Lifecycle

- Host runs only when the user opens it. No auto-launch on boot.
- Space Agent appears while the host runs and captures thumbnails only through owner-scoped demand.
- Session states are `connecting`, `connected`, `suspended`, `resuming`, and `ended`.
- QUIC `.waiting` and short path loss map to `suspended`, not `ended`. The host keeps session state and frame/input plumbing suspended for a 20 second grace window.
- A foreground client can resume inside the grace window by re-dialing QUIC with the public `SessionReady.resumeId`, answering a one-time resume challenge with an HMAC proof using the memory-only `SessionReady.resumeSecret`; the host reattaches lanes to the same session id and rotates resume material.
- Grace expiry, background policy, revoke, auth failure, user forget, or terminal connection close ends the session.
- Client suspends on background; the QUIC session closes within one second while Keychain token and host public key persist. Foreground starts a fresh connect or grace-window resume using stored pairing.

## Risks Tracked Outside This Doc

- Private CoreGraphics API drift between macOS versions. Mitigation: `SpacesProvider` is the only consumer.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback in v0.

## Cross-References

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: `TASKS.md`
