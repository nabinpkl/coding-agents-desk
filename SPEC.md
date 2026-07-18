# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit `LSUIElement` menu-bar app with workspace sidebar/top-bar panels, editable file windows, and Space Agent | One process owns the workspace, local UI, ATC, PTYs, Spaces, and paired-client services while focused controllers keep `AppDelegate` as composition. |
| iOS client | Swift, UIKit, current `AVSampleBufferDisplayLayer` baseline with a retained BGRA compositor target in this worktree | Native required for text crispness and gesture fidelity. Browser path rejected in `PRD.md`. The branch target decodes HEVC through `VTDecompressionSession` into one retained compositor surface. |
| Capture | `ScreenCaptureKit` on macOS 26+ | First-party selected-display capture without composition tricks. |
| Encode / decode | Hardware-required VideoToolbox, HEVC by default and H.264 as an explicit owned-media codec setting | Rest-state text crispness depends on hardware screen-content quality. In this worktree HEVC remains the full-frame refresh path while retained graphics commands target scroll motion. |
| Workspace | Host-owned workspace domain plus shared wire and WebKit packages | Workspace roots and filesystem authority stay inside the Mac host. `AgentDeskWire` shares only transport DTOs, while AgentPanel shares WebKit behavior and resources behind platform adapters. ADR-0052. |
| Transport | One authenticated `NetworkConnection<QUIC>` per live session, ALPN `agentdesk-session-quic-v2` | Control, input, DOM, terminal, and files use ordered QUIC streams. HEVC media uses the same connection's datagram lane. File payloads cannot head-of-line block input. ADR-0030 and ADR-0052. |
| Network | Tailscale only | No public rendezvous, relay, or internet routing. Both peers are on the tailnet. |
| Pairing | Mac-initiated tailnet device picker (ADR-0019), QR fallback | The Mac enumerates online iOS tailnet peers, probes each on the plain-TCP offer port (`AGENTDESK_OFFER_PORT`, default 41890) for a self-reported display name, and pushes a pre-approved signed offer to the picked device. The pick is the authorization. The iPhone runs the unchanged signed handshake. Signed token stored in Keychain on both sides. |
| Wire compatibility | Current protocol version is 9 (ADR-0020, ADR-0057, ADR-0058) | Protocol v8 changes the Files body codec to carry native document bytes. Protocol v9 sequences cursor input and separates applied feedback from independently observed Mac movement. Host and client reject peers below `9` with `incompatible-protocol`; matching app versions remain irrelevant. |
| Spaces enumeration | Private SkyLight/CoreGraphics symbols bound with `dlopen` and `dlsym` | No public API exists. Risk is acceptable because App Store distribution is not the v0 target. |
| Spaces switch | Synthesize Dock swipe `CGEvent`s via `SpacesProvider.postDockSwipeFrame` and `commitStep(delta:)` | Stock macOS path that preserves live Space transition animation. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One host code path for all remote input. |
| Distribution | Developer ID notarized DMG for Mac, TestFlight internal for iOS | One author, one device. |

ADR-0001 records the original v0 stack decision. ADR-0015 records the owned single-surface media baseline. ADR-0016 records the scroll-first hybrid retained-graphics worktree architecture that has since been narrowed by the video-primary work. ADR-0019 records Mac-initiated tailnet pairing with a host-side device picker. ADR-0020 records the handshake-negotiated wire protocol version. ADR-0021 through ADR-0025 record the retained-graphics and motion-carrier iterations. ADR-0026 through ADR-0029 record the video-primary, adaptive bitrate, NACK, and slow-link survival work. ADR-0030 records the current live-session transport: a single authenticated QUIC connection with ordered role streams and media datagrams. ADR-0031 records client-visible selected-display projection. ADR-0032 records bounded client diagnostics. ADR-0033 records the adaptive media quality ladder. ADR-0035 records the phone Agent feed. ADR-0051 (superseded by ADR-0053) records the terminal lane. ADR-0052 makes AgentDesk the workspace owner and adds the authenticated files lane at protocol version `6`. ADR-0053 moves the terminal `pty-manager` and `pty-client-swift` packages in-tree, removing the last build dependency on the retired `agent-workspace-ide` donor. ADR-0054 locks the shared workspace-data and platform-presentation boundary. ADR-0056 adds host-coordinated leased Agent Panel terminals and raises the session target to protocol version `7`. ADR-0057 adds the shared responsive DOCX renderer, a binary Files codec, and protocol version `8`. ADR-0058 sequences cursor input, separates feedback provenance, and raises the session target to protocol version `9`. ADR-0059 isolates Dock desktop-content mutation behind a transactional yabai adapter without changing the wire protocol or the single SkyLight reader. ADR-0060 keeps the input frame ceiling at 4 MiB while fragmenting only large on-demand Agent raw events.

## Module Boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

The shared wire types (pairing, session, owned-media, retained-graphics, input, DOM-mirror, agent-feed shapes below) live in one local Swift package, `packages/AgentDeskWire`, imported by both apps, rather than hand-mirrored per project (ADR-0050). The package is the single source of truth for the wire contract; host and client diverging on a shared type is a compile error. Side-specific behavior types (host graphics pacing, client render/transport state) stay in their app targets.

### Host

1. **CaptureEngine.** Owns ScreenCaptureKit. Produces `CMSampleBuffer` frames for the selected display. In the hybrid worktree the same capture stream feeds HEVC full-frame refresh and the planned scroll delta engine. Display switches restart the capture stream and force the first post-switch frame to be a keyframe.
2. **Encoder.** Wraps VideoToolbox and produces `OwnedMediaFrameEnvelope` payloads for HEVC full-frame refreshes. It fails the media path if the required hardware encoder cannot start.
3. **SpacesProvider.** Enumerates Spaces through SkyLight/CoreGraphics bindings and forwards Space-swipe gestures through Dock-handled events. It reports host display labels, bounds, main-display status, active display id, and selected display id in `DesktopState`.
4. **InputDispatcher.** Consumes `NormalizedInput` and emits `CGEvent`. Space-switch gestures stream through the injected `SpacesProvider` handler. Cursor input is clamped against the selected display bounds and returns its applied position only after posting the event, so the originating input channel can acknowledge that revision.
5. **Pairing.** Generates pairing payloads, validates approval tokens, and stores allowlisted devices in Keychain-backed state. Holds the in-memory pre-approval set: a Mac-side device pick marks the offer's one-time nonce pre-approved, so the signaling server issues the token without a prompt when the iPhone dials back with it. The nonce is still consumed once, in `issueApprovedSessionToken`. Records the client-reported display name on the paired record so the host UI shows which device it is.
6. **TailnetDiscovery.** Parses `tailscale status --json` into online tailnet peers (`TailnetDeviceOption`), keeping iOS peers with a tailnet IPv4 and ordering online ones first. The JSON parser is split out for unit testing without running `tailscale`.
7. **PairingOfferSender.** Outbound plain-TCP `NWConnection` to a picked peer's offer port. Writes one length-prefixed `PairingPayload` and closes. Plaintext is acceptable: WireGuard encrypts the peer hop, the host public key in the payload is already public, and the nonce is one-use and pre-approval-gated.
8. **TailnetIdentityProber.** Outbound `whois` probe on the offer port. An unpaired client whose listener is running replies with a display-only `DeviceIdentity`; the picker lists only the peers that answered, by their reported name. Display-only and pre-auth: tailnet membership is the trust boundary and the signed handshake still gates pairing.
9. **ClientDiagnosticsRequester.** Host-side on-demand diagnostics collector. It requests diagnostics from the active paired client over the session input lane first, then falls back to the foreground tailnet control path on the offer port using the stored paired host key for request signing. Dev automation writes retrieved runs under `/tmp/agentdesk-client-diagnostics-<timestamp>/`.
10. **SessionAuthenticator.** Runs the per-connection mutual challenge-response on the session QUIC control stream. Rejects a peer whose advertised `protocolVersion` is below the host's `minCompatibleProtocolVersion` with `incompatible-protocol` (ADR-0020). Produces `SessionReady` with the session id, memory-only resume id, resume secret, resume expiry, and media key salt.
11. **QuicSessionTransport.** Owns the single live `NetworkConnection<QUIC>` and routes lanes by role. The control stream carries session init, challenge, proof, ready, resume, revoke, and heartbeat. The input stream carries `InputChannelEvent`, `ClientConfig`, diagnostics requests, and host pushes. The datagram lane carries authenticated `ADMD` media packets, packet resend requests, keyframe requests, ACKs, and link-health reports.
12. **MediaTransport.** Sends HEVC full-frame refreshes over the session datagram lane. The media packet key is derived per session from fresh handshake material, the session id, and the `SessionReady.mediaKeySalt`; no static datagram key or separate media listener remains.
13. **ScrollDeltaEngine.** Rest-state retained-graphics producer (ADR-0025), retained as local crisp-repair/compositor machinery. Damage tiles through the content-cache ladder (`cacheTile`/`drawCachedTile`/`bitmapTile`), omitting cells that already match the retained baseline. It does not own a separate network connection.
14. **InputChannelServer.** Owns the host side of the session input stream. Preserves each `InputChannelEvent` cursor revision through dispatch, acknowledges the applied revision only to its originating channel, and tags independently observed Mac cursor movement with that channel's last applied revision. It also pushes desktop state, thumbnails, cursor image updates, text-input focus metadata, agent speech events, diagnostics responses, and bounded Agent raw-event fragments on the same serialized lane.
15. **SignalingChannel.** Supplies length-prefixed QUIC stream framing and role routing for the session control and input streams. It is not a WebSocket wrapper.
16. **HostPtyManagerProcess.** Reuses a live Rust `pty-manager` on the host variant's Application Support socket or launches the bundled AgentDesk `pty-manager` (`terminal/pty-manager`, ADR-0053) when no process is listening. The manager, not the host lifecycle or iOS app, spawns commands and owns host PTYs. Persistent workspace PTYs survive detach and host relaunch. Under the ADR-0056 target, leased Agent Panel PTYs survive only while a client lease exists or the configured final-lease grace is pending; manager shutdown reaps leased children.
17. **TerminalClientBridge.** Bridges a dedicated `.terminal` QUIC stream to the `pty-manager` Unix socket as opaque length-prefixed PTY protobuf frames. It does not decode terminal protocol payloads; it only enforces stream role and frame bounds. Persistent full-screen terminal clients remain trusted multiplexer clients with the existing session-management controls. Agent Panel creation and kill authority stays behind `AgentSessionTerminalCoordinator`; its iOS renderer attaches only to the deterministic PTY returned by that coordinator.
18. **VideoFrameSource.** Concrete implementation `ScreenCaptureKitFrameSource` captures one stream for the selected display and exposes a display-selection hook. `TestPatternFrameSource` exists as a diagnostic source.
19. **SpaceThumbnailProvider.** Host-local thumbnail source for Spaces, enabled by owner-scoped demand.
20. **SpaceAgent.** Host-local overlay under `host/AgentDeskHost/SpaceAgent/`, showing the draggable spaceship and active-display Spaces strip.
21. **DictationBar.** Host-local push-to-talk overlay under `host/AgentDeskHost/DictationBar/`, independent of the iPhone media and input channels.
22. **WorkspaceStore.** Host-local authoritative ordered workspace roots and active workspace under the host variant's Application Support directory. It imports the retiring AWI store once, then never reads donor state again.
23. **WorkspaceShell.** AppKit sidebar and top bar composed at host launch. It uses AgentDesk Spaces, PTY, terminal launcher, and ATC ownership instead of donor implementations.
24. **DockDesktopSwapExecutor.** Host-only yabai adapter (ADR-0059). It accepts stable Space IDs, resolves current indices at transaction time, captures eligible windows, verifies every move, rolls back partial failure, and returns a conservative in-memory Undo receipt. It invokes the configured executable directly without a shell and does not reorder or create Spaces.
25. **WorkspaceFiles.** Walks workspace-relative path components from an open registered-root descriptor with `openat` and no-follow semantics, rejects traversal and symlinks, reads bounded UTF-8 content or read-only DOCX bytes, and performs atomic revision-checked text writes.
26. **WorkspaceFilesStream.** Owns the host `.files` stream endpoint and request correlation. It never runs file I/O on the input or media lanes.
27. **AgentPanel.** Reusable WebKit surface. The macOS adapter reads the local ATC sidecar directly; the iOS adapter carries the same request/push contract over the authenticated session. For the bottom terminal it emits session-scoped open, close, and context-ended intent only; it never renders a terminal or forwards terminal keystrokes.
28. **AgentSessionTerminalCoordinator.** Host-only authority for Agent Panel resume terminals (ADR-0056). It validates project/source/session context, derives `agent-resume-<source>-<session-id>`, constructs the fixed Claude or Codex argv, serializes create-or-attach, holds a bootstrap client through native renderer handoff, rejects `activeElsewhere`, and owns immediate explicit kill. macOS calls it directly; iOS reaches the same coordinator through the terminal messages introduced in protocol v7 and carried by current protocol v9.

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
13. **InputChannel.** Reliable input lane inside the authenticated session QUIC connection. It stays logically independent from media even though both lanes share the same connection. Main-actor input sends are chained so cursor revision order is the order presented to the QUIC stream. It sends `ClientConfig.selectedDisplayId` when the user picks a display and sends client-owned media preferences (`crispTextOverlayEnabled`, `showHostCursorInVideo`, `mediaQuality`) on input-channel open and settings changes. `mediaQuality` carries adaptive on/off plus an optional fixed target. When adaptive is on, the host still owns rung selection; when adaptive is off, the host pins the video bitrate/FPS/resolution to the fixed target while packet repair and backpressure stay active. The lane receives revisioned cursor application acknowledgements, independently observed Mac cursor movement, host text-input focus metadata, `DiagnosticsRequest`, and Agent raw-event responses. It reassembles only raw-event fragment envelopes before delivering one logical response to the shared webview.
14. **CursorReconciliationStateMachine.** UIKit-free owner of pending cursor operations and prediction confidence (`confirmed`, `awaitingHost`, or `ghost`). It ignores stale applied positions as visible corrections, rebases genuine Mac movement and replays only newer client operations, uses the oldest pending deadline, and bounds its pending window. `PairingViewController` owns only transport/lifecycle wiring and the displayed cursor point.
15. **ClientDiagnosticsStore.** Bounded durable client diagnostics store in `Application Support/Diagnostics`. It persists structured NDJSON essentials for the current run plus two prior runs, rotates unclean exits on bootstrap, mirrors essentials to OSLog, summarizes delayed MetricKit payloads, and serves prior-run tails on demand over the input lane or the foreground tailnet control listener.
16. **TerminalSurface.** Full-bleed SwiftTerm renderer selected from the Control | Agent | Terminal | Browser switcher. It opens `.terminal` QUIC streams, wraps them in `PtyClientSwift`, and gives each app-owned split pane its own persistent `agentdesk-N` PTY session with the default host login shell. A drawer overlays the terminal and subscribes to the PTY manager session tree: sessions expand to client rows, Open joins an existing manager-owned session as a new iOS pane/client with `createIfMissing=false`, close-client asks the manager to detach that exact client id, and close-session asks the manager to kill the session. User close on a pane still detaches only when other PTY clients remain attached to that session; when the pane is the only client, user close kills the PTY session. Teardown and view deallocation detach only, which is correct for these persistent workspace PTYs and does not apply to leased Agent Panel PTYs.
17. **FilesTransport.** Opens the authenticated `.files` stream, correlates workspace list/directory/read/write responses, and cancels pending operations when the session ends.
18. **FilesSurface.** UIKit workspace and directory navigation plus the shared WebKit file viewer/editor. DOCX is responsive and read-only through the same SPA used by macOS. Text saves carry the last observed file revision and surface conflicts instead of overwriting host changes.
19. **AgentFeedSurface.** UIKit vertical container for the AgentPanel webview, native resize handle, and shared `PtyTerminalSwiftTerm` content. It requests a host-coordinated leased PTY over protocol v7, attaches over `.terminal` with `createIfMissing=false`, acknowledges handoff, and owns iOS layout and explicit/involuntary lifecycle mapping. It does not construct harness commands or own process lifetime.

Tests required for v0: **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView.** Additional owned-media contract tests pin wire shapes, packet repair, and decoder recovery behavior where regressions are expensive.

## Agent Panel Terminal Flow

ADR-0056 locks the v5 target below. R59-R70 implement it; at the R58 decision gate the checked-in PTY
pair still speaks protocol v3 and the checked-in AgentDesk session still speaks v6. There is no compatibility
mode after each implementation bump lands.

1. The thread-view AgentPanel webview emits open intent containing project path, source, and harness
   session id. It cannot supply an executable, arguments, PTY name, or terminal input.
2. The macOS AppKit adapter calls the host coordinator directly. The iOS UIKit adapter sends the same
   normalized context over the authenticated input lane using the terminal contract introduced in protocol v7.
3. The host accepts only source `claude` or `codex`, a UUID harness session id, and an absolute project
   directory beneath the user's home. It derives `agent-resume-<source>-<session-id>` and constructs
   the fixed resume command. The session id remains a positional argument through the login-zsh
   forwarding wrapper and PTY protocol; no joined command string or terminal-input injection exists.
4. The coordinator serializes opens by deterministic PTY name. It attaches an existing panel-owned
   PTY or creates one `leased + CommandLaunch` PTY and holds a bootstrap attachment until the native
   renderer acknowledges attachment. A failed or timed-out handoff kills the new PTY. If ATC says the
   harness is live and the deterministic PTY is absent, open fails with `activeElsewhere`.
5. AppKit and UIKit each compose the AgentPanel webview above a native resize handle and shared
   `PtyTerminalSwiftTerm` content. The feed shrinks as the terminal grows. Shared SwiftTerm content owns
   input delegation, paste, selection, output feeding, focus, and PTY resize; React owns none of them.
6. Explicit panel/context exit asks the coordinator to kill immediately. Unexpected renderer/socket
   loss detaches. A leased PTY is reaped only after its final client lease is absent for the configured
   grace, and a reattach during grace preserves its PID.

Platform ownership remains explicit:

| Owner | Responsibility |
| --- | --- |
| AgentPanel WebKit | Feed presentation and session-scoped terminal intent/status only. |
| Shared `PtyTerminalSwiftTerm` | Native SwiftTerm rendering, input, output, paste, focus, and resize. |
| macOS AppKit adapter | Vertical layout, local coordinator calls, window/back/hide/close lifecycle. |
| iOS UIKit adapter | Vertical and keyboard-safe layout, v7 request routing, surface/background lifecycle. |
| Host coordinator | Context validation, deterministic identity, command construction, handoff, explicit kill, and `activeElsewhere`. |
| Rust `pty-manager` | Direct process launch, PTY state, client leases, final-lease grace, natural-exit cleanup, and reaping. |

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
  | { kind: "systemCommand", command: "missionControl" }
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

The offer is an untagged `PairingPayload`; the iPhone synthesizes its `pairingURL()` locally and reuses the QR handshake path. `whois`/`id` carry only a display name for the picker and are pre-auth; the signed handshake still gates pairing. The payload carries the host's bound signaling port (`sp`), so the client dials the advertised port rather than a hardcoded default; this is what lets the stable and dev hosts run concurrently on tier-derived ports (ADR-0037).
Foreground diagnostics fallback reuses the same offer port only when the app is paired and foregrounded. The host signs the request body with the paired host key; the client rejects a request whose host fingerprint does not match the stored pairing, whose signature fails, or whose timestamp is older than 60 seconds.

Session establishment is locked by ADR-0003, ADR-0011, ADR-0020, and ADR-0030. Frames on QUIC streams are length-prefixed. Protocol v8 encodes Files request/response bodies as binary property lists so `Data` stays binary. Protocol v9 changes the input body contract for revisioned cursor causality; control, graphics, DOM, and terminal bodies are unchanged.

```
QuicStreamFrame   = UInt8 role || UInt32BE length || body
role              = 1 control | 2 input | 3 graphics | 4 dom | 5 terminal | 6 files

SessionInit       { deviceFingerprint, sessionToken, clientNonce,
                    protocolVersion, minCompatibleProtocolVersion }   // current target: pv must be >= 9
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

Agent raw records use optional protocol-v9 input messages from ADR-0060. Historical thread pages carry only a Raw JSON marker:

```
AgentRawEventRequest  { t: "agent-raw-event-get", requestId, sessionId, eventIndex }
AgentRawEventResponse { t: "agent-raw-event", requestId, sessionId, eventIndex, text }
AgentRawEventPart     { t: "agent-raw-event-part", transferId, requestId, sessionId,
                        eventIndex, partIndex, partCount, totalByteCount, base64Data }
AgentRawEventError    { t: "agent-raw-event-error", requestId, sessionId, eventIndex, reason }
```

Direct responses remain single input frames when their encoded body fits 4 MiB. Larger logical responses use 2 MiB source fragments, a 100 MiB record ceiling, four concurrent client transfers, and 30-second expiry. QUIC still owns stream packetization, ordering, retransmission, and congestion control. This envelope exists because the application frame decoder rejects a body above 4 MiB before QUIC segmentation can make it acceptable.

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

Each side rejects with `incompatible-protocol` when the peer's advertised `protocolVersion` is below its own `minCompatibleProtocolVersion`. Protocol v8 is required because the Files role changed from JSON text-only bodies to binary property-list bodies with native document bytes. Protocol v9 is required because cursor inputs now carry revisions and cursor feedback has distinct applied and host-moved frames. Older builds parse only far enough to be rejected. Matching marketing versions across host and client is not a compatibility signal; the protocol version is.

Terminal PTY frames travel over the reliable ordered `.terminal` stream as opaque PTY protobuf envelopes from AgentDesk's `terminal/pty-client-swift` and `terminal/pty-manager` pair (moved in-tree under ADR-0053). The checked-in Rust and Swift clients both enforce inner protocol v3. The v5 target is PTY inner protocol v4; R59 replaces the create/attach shape and bumps both implementations in lockstep, with no protocol-v3 compatibility path:

```
Terminal stream body = UInt32BE ptyFrameLength || Envelope {
  protocol_version: 4,
  session_name,
  payload: CreateOrAttach {
    createIfMissing,
    launch: ShellLaunch | CommandLaunch { executable, arguments: [String] },
    lifetime: persistent | leased
  }
}

SessionSummary { sessionName, lifetime, clients, ... }
```

The generated protobuf types currently retain the `pty.v1` package prefix; compatibility is governed
by `Envelope.protocol_version`, which is `3` before R59 and must be `4` after it. The package/type name
does not make the current inner protocol v1.

The outer `QuicStreamFrame` identifies the stream role. The inner PTY frame is owned by the Rust manager and Swift PTY client; AgentDesk's host bridge does not reinterpret create/attach, input, output, resize, detach, kill, close-client, subscribe, or session-list messages. `ShellLaunch` preserves the existing login-interactive shell behavior. `CommandLaunch` executes the supplied executable with its argument array directly through Rust `CommandBuilder`; argument boundaries survive protobuf decoding and no shell command string is assembled by `pty-manager`. Every caller must choose a lifetime explicitly.

Persistent full-screen/workspace terminals retain the authenticated paired client's existing multiplexer authority: they can list sessions, join with `createIfMissing=false`, detach a manager-assigned client id, or kill a session. Leased Agent Panel terminals use a narrower host-coordinated creation path. The iOS panel receives a deterministic PTY name from the host, may only attach to it with `createIfMissing=false`, and sends explicit close through the coordinator. This keeps executable construction, creation, and lifecycle policy out of the webview and iOS client even though terminal bytes still use the opaque `.terminal` bridge.

Agent Panel terminal coordination rides the authenticated input/Agent push contract and therefore requires AgentDesk session protocol v7:

```
AgentResumeTerminalContext { projectPath, source: "claude" | "codex", harnessSessionId }

AgentTerminalOpen        { t: "agent-terminal-open", requestId, context }
AgentTerminalReady       { t: "agent-terminal-ready", requestId, context, ptySessionName }
AgentTerminalAttachedAck { t: "agent-terminal-attached", requestId, context, ptySessionName }
AgentTerminalClose       { t: "agent-terminal-close", requestId, context, ptySessionName?, reason }
AgentTerminalEnded       { t: "agent-terminal-ended", requestId, context, ptySessionName, exitStatus? }
AgentTerminalError       { t: "agent-terminal-error", requestId, context, ptySessionName?,
                           code: "invalidContext" | "activeElsewhere" | "launchFailed" |
                                 "handoffTimedOut" | "sessionEnded" }
```

The iOS client sends open, attached acknowledgement, and close on the existing authenticated input lane; ready, ended, and typed errors return through the owned Agent push path. Request ids and full normalized context fence stale responses after back navigation or session replacement. macOS uses the same message semantics against the coordinator in-process rather than routing its local panel through QUIC.

Workspace files travel over the reliable ordered `.files` stream. Every request carries a correlation id and workspace id. Paths are normalized relative paths, never absolute host paths.

```
WorkspaceFilesRequest =
  | { t: "workspace-list", rid }
  | { t: "directory-list", rid, wid, path }
  | { t: "file-read", rid, wid, path }
  | { t: "file-write", rid, wid, path, revision, utf8 }

WorkspaceFilesResponse =
  | { t: "workspace-list-result", rid, workspaces }
  | { t: "directory-list-result", rid, wid, path, entries }
  | { t: "file-read-result", rid, wid, path, revision,
      content: utf8-text | docx-bytes }
  | { t: "file-write-result", rid, wid, path, revision }
  | { t: "file-conflict", rid, wid, path, revision }
  | { t: "file-error", rid, code, message }
```

The host never authorizes a file by comparing reconstructed absolute path strings. It rejects empty, absolute, `.` and `..` components, opens the registered root once, and walks beneath that descriptor with `openat` plus `O_NOFOLLOW`; regular-file and directory requirements are checked from the opened descriptors. UTF-8 text retains its 4 MiB default; DOCX has an independent configurable admission ceiling capped at 100 MiB. The Files role permits a 101 MiB application frame while every other role retains the 4 MiB frame ceiling. QUIC performs reliable stream segmentation and reassembly, so there is no AgentDesk document-chunk protocol. A revision is a digest of the exact file content returned by the last read. Writes remain text-only: they create a temporary sibling through the verified parent descriptor, fsync as required, then rename atomically within that descriptor only when the supplied content revision still matches.

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
not valid in protocol version 5.

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
InputChannelEvent  { event: NormalizedInput, cursorRevision? }        // t: "input-event"
InputChannelClose  { reason }                                         // t: "input-close"
DesktopStatePush   { state: DesktopState }                            // t: "desktop-state"
CursorImagePush    { hash, png?, hotspotXFrac, hotspotYFrac,
                      widthPoints, heightPoints, hidden, cursorKind }  // t: "cursor"
CursorAppliedPush  { cursorRevision, displayId?, cursorX, cursorY }   // t: "cursor-applied"
HostCursorMovedPush { afterCursorRevision?, displayId?, cursorX,
                       cursorY }                                      // t: "host-cursor-moved"
HostAvailability   { active | locked | captureUnavailable |
                      disconnected }                                  // t: "host-availability"
HostTextInputFocus { editability: editable | nonEditable | ambiguous,
                      secure, source, role?, subrole?, cursorKind? }  // t: "text-input-focus"
ClientConfig        { thumbnailsEnabled, thumbnailRefresh?,
                      selectedDisplayId?, crispTextOverlayEnabled?,
                      showHostCursorInVideo?, mediaQuality? }
ClientMediaQuality  { adaptiveEnabled, fixedTarget? }
ClientQualityTarget { bitrateKbps, fps, resolutionScale }
                                                                        // t: "client-config"
DiagnosticsRequest  { requestId, sinceRunId?, includePreviousRuns,
                      maxBytes? }                                      // t: "diagnostics-request"
DiagnosticsSummary  { requestId, runs, droppedEvents, droppedBytes,
                      latestMetricKitPayloadAt? }                      // t: "diagnostics-summary"
DiagnosticsChunk    { requestId, sequence, isFinal, runId,
                      uncompressedBytes, payloadBase64 }               // t: "diagnostics-chunk"
DiagnosticsError    { requestId, reason }                             // t: "diagnostics-error"
```

`NormalizedInput.cursorSet { displayId, x, y }` is an absolute cursor retarget in host/global display points, same coordinate space as `DesktopState.cursorX/cursorY`. The host accepts it only when `displayId` matches the currently selected display, clamps it to that display bounds, posts one mouse move, and uses the set point as the base for subsequent relative cursor moves. The iPhone uses it after manual zoomed-viewport pan: viewport browsing stays local, then the next pointer-location-dependent action sends `cursorSet` before the original pointer input so the host cursor starts from the visible region.

Every `cursorSet` and `cursorMove` carries a monotonically increasing `cursorRevision`; non-cursor input must not carry one. `CursorAppliedPush` is emitted by the originating host input channel only after that cursor event is posted. An older applied position advances client progress but never rewinds a newer local prediction. `HostCursorMovedPush` is emitted only for movement observed while remote cursor dispatch is idle and carries that channel's last applied revision. The client rebases at the host position and replays pending operations newer than that revision. If the oldest pending operation is not confirmed within the configured deadline, send fails, the channel is absent, or the bounded pending window fills, the locally predicted cursor becomes a grey ghost until the host catches up or the session resets (ADR-0058).

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
- If a behind or draining frame stays unacknowledged past the stale-unacked deadline, the host abandons it for admission accounting and holds encode admission while the raw capture mailbox keeps coalescing. This prevents one late lifecycle ACK from freezing capture admission. Stale admission recovery is counted as quality pressure but does not force a keyframe by itself.
- Explicit keyframe requests are counted as quality pressure and deferred while draining. Periodic keyframes are suppressed while behind or draining, and a second keyframe is blocked while a prior keyframe is unacknowledged.
- The adaptive quality controller owns one target `{ bitrateKbps, fps, resolutionScale, rung, reason }`. It spends bitrate first, then shifts through fixed readable resolution/FPS rungs under sustained loss, repair expiry, keyframe fallback, ACK queueing plus loss, or host cadence collapse. High ACK age alone holds the current rung. If the survival rung still freezes, the emergency rung prioritizes continuity over text sharpness at lower capture scale, FPS, and bitrate. Recovery raises bitrate before resolution and FPS.
- A resolution rung restarts ScreenCaptureKit for the selected display, clears stale pending capture/encode state, and forces the next video frame to be a keyframe. The client accepts a new video resolution only at a keyframe; a delta at unexpected dimensions is dropped and triggers bounded keyframe recovery.
- Once a frame is encoded, the host sends the whole frame. Backpressure adjusts encode cadence and datagram pacing; it does not drop encoded delta frames.
- A frame repaired before the deadline renders in order.
- An expired delta frame is skipped as stale output.
- An expired keyframe, decoder failure, malformed packet, or authentication failure requests keyframe recovery.
- Stale unacknowledged host frames and drain timeouts do not force keyframe recovery. Keyframe recovery is reserved for decoder continuity failures, incomplete keyframes, malformed/auth failures, explicit client requests, and capture resolution changes. Explicit client keyframe requests are coalesced while a keyframe is already in flight.
- Media lane failure or decoder failure does not end the session. Control and input stay live unless the QUIC session itself is revoked, fails auth, is backgrounded by iOS policy, or exceeds the resume grace window.

## Performance Budgets

- End-to-end glass-to-glass: under 80 ms on Tailscale over local Wi-Fi 6.
- Space-swipe to visible Space change on the iPhone: under one frame at 60 Hz after host commit.
- Text crispness: native Retina-scale capture at rest, no client-side upscaling trick.
- Foreground reconnect after background drop: under 5 seconds.

## Lifecycle

### QUIC session lifecycle

- Host runs only when the user opens it. No auto-launch on boot.
- Space Agent appears while the host runs and captures thumbnails only through owner-scoped demand.
- Session states are `connecting`, `connected`, `suspended`, `resuming`, and `ended`.
- QUIC `.waiting` and short path loss map to `suspended`, not `ended`. The host keeps session state and frame/input plumbing suspended for a 20 second grace window.
- A foreground client can resume inside the grace window by re-dialing QUIC with the public `SessionReady.resumeId`, answering a one-time resume challenge with an HMAC proof using the memory-only `SessionReady.resumeSecret`; the host reattaches lanes to the same session id and rotates resume material.
- QUIC resume-grace expiry, background policy, revoke, auth failure, or user forget ends the AgentDesk session. A `.terminal` lane or renderer closing does not by itself end the authenticated AgentDesk session.
- Client suspends on background; the QUIC session closes within one second while Keychain token and host public key persist. Foreground starts a fresh connect or grace-window resume using stored pairing.

### PTY session lifecycle

- PTY lifetime is independent of the QUIC session state. Persistent workspace PTYs survive client detach and remain manager-owned until explicit kill, natural exit, or manager replacement.
- Agent Panel resume PTYs are leased. The manager schedules the configured final-lease grace only when detach, close-client, or socket loss removes the final attached client. The production target is 30 seconds through host central config; tests inject shorter values.
- Reattach during PTY grace cancels reaping and preserves the PTY/PID. With Mac and iPhone attached, the first detach cannot schedule a reap; only loss of the final lease can do so.
- Explicit terminal close, panel back/context change, session replacement, iOS switch away from Agent or teardown, macOS Agents-window hide or close, revoke, and app termination go through the host coordinator and kill the leased PTY immediately. They do not wait for grace.
- If the final lease is still absent when grace expires, `pty-manager` kills the harness and removes its PTY, clients, and registry state. Natural harness exit, explicit kill, and manager shutdown cancel pending reap work and leave no leased child.
- An unexpected renderer failure, terminal socket loss, transport loss, or iOS suspension detaches rather than issuing explicit kill, preserving the bounded reattach path.

## Risks Tracked Outside This Doc

- Private CoreGraphics API drift between macOS versions. Mitigation: `SpacesProvider` is the only consumer.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback in v0.

## Cross-References

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: `TASKS.md`
