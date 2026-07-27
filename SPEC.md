# AgentDesk SPEC

> Authoritative for **how** v0 is built. Product intent and scope live in `PRD.md`. Repo operating rules live in `AGENTS.md`.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| macOS host | Swift, AppKit `LSUIElement` menu-bar app with workspace sidebar/top-bar panels, editable file windows, and Space Agent | One process owns the workspace, local UI, agent feed, PTYs, Spaces, and paired-client services while focused controllers keep `AppDelegate` as composition. |
| iOS client | Swift, UIKit, current `AVSampleBufferDisplayLayer` baseline with a retained BGRA compositor target in this worktree | Native required for text crispness and gesture fidelity. Browser path rejected in `PRD.md`. The branch target decodes HEVC through `VTDecompressionSession` into one retained compositor surface. |
| Capture | `ScreenCaptureKit` on macOS 26+ | First-party selected-display capture without composition tricks. |
| Encode / decode | Hardware-required VideoToolbox, HEVC by default and H.264 as an explicit owned-media codec setting | Rest-state text crispness depends on hardware screen-content quality. In this worktree HEVC remains the full-frame refresh path while retained graphics commands target scroll motion. |
| Workspace | Host-owned workspace domain plus shared wire and `WorkspaceIDE` WebKit packages | Workspace roots, revisions, observation, Git reads, and PTY authority stay inside the Mac host. One native coordinator projects the same bundled sidebar and editor regions into AppKit and UIKit while native shells own geometry and terminal lifecycle. ADR-0052 and ADR-0062. |
| Terminal presentation | Shared `PtyTerminalWebView` package with a bundled xterm.js 6.0.0 runtime | One WKWebView renders terminal tabs, recursive splits, pane chrome, session discovery, status, and terminal cells on macOS and iOS. Native shells retain lifecycle and OS integration while Rust owns replay, revisions, source sizing, and parser replies. ADR-0069. |
| Browser projection | MV3 extension, authenticated native bridge, shared `BrowserProjection` WebKit package | macOS and iOS render every normal Chrome window and tab; one selected tab supplies isolated-world rrweb batches. The last active viewer owns Chrome's emulated source viewport while zoom remains local. Focus and projection are independent, and generation fencing prevents prior pages from leaking into a new selection. ADR-0064 and ADR-0065. |
| Transport | One authenticated `NetworkConnection<QUIC>` per live session, ALPN `agentdesk-session-quic-v2` | Control, input, DOM, terminal, files, and iPhone voice use ordered QUIC streams. HEVC media uses the same connection's datagram lane. File and voice payloads cannot head-of-line block input. ADR-0030, ADR-0052, and ADR-0076. |
| Network | Tailscale only | No public rendezvous, relay, or internet routing. Both peers are on the tailnet. |
| Pairing | Mac-initiated tailnet device picker (ADR-0019), QR fallback | The Mac enumerates online iOS tailnet peers, probes each on the plain-TCP offer port (`AGENTDESK_OFFER_PORT`, default 41890) for a self-reported display name, and pushes a pre-approved signed offer to the picked device. The pick is the authorization. The iPhone runs the unchanged signed handshake. Signed token stored in Keychain on both sides. |
| Wire compatibility | Current protocol version is 15 (ADR-0020, ADR-0057, ADR-0058, ADR-0061, ADR-0062, ADR-0064, ADR-0065, ADR-0070, ADR-0075, ADR-0076) | Protocol v8 changes the Files body codec to carry native document bytes. Protocol v9 sequences cursor input. Protocol v10 adds workspace-terminal coordination. Protocol v11 generalizes Files into the workspace lane. Protocol v12 projects the complete Chrome hierarchy to iOS. Protocol v13 adds authenticated Browser viewer viewport ownership. Protocol v14 adds opt-in, on-demand paired-client screenshots. Protocol v15 replaces the eager Agent feed digest with visibility-scoped project, session, and event subscriptions. The additive role-7 voice lane keeps protocol v15 and negotiates `voice-lane-v1` independently. Host and client reject peers below `15` with `incompatible-protocol`; matching app versions remain irrelevant. |
| Spaces enumeration | Private SkyLight/CoreGraphics symbols bound with `dlopen` and `dlsym` | No public API exists. Risk is acceptable because App Store distribution is not the v0 target. Mission Control topology edits use event-driven entry and bounded exit observation under ADR-0071. |
| Spaces switch | Synthesize Dock swipe `CGEvent`s via `SpacesProvider.postDockSwipeFrame` and `commitStep(delta:)` | Stock macOS path that preserves live Space transition animation. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One host code path for all remote input. |
| Distribution | Developer ID notarized DMG for Mac, TestFlight internal for iOS | One author, one device. |

ADR-0001 records the original v0 stack decision. ADR-0015 records the owned single-surface media baseline. ADR-0016 records the scroll-first hybrid retained-graphics worktree architecture that has since been narrowed by the video-primary work. ADR-0019 records Mac-initiated tailnet pairing with a host-side device picker. ADR-0020 records the handshake-negotiated wire protocol version. ADR-0021 through ADR-0025 record the retained-graphics and motion-carrier iterations. ADR-0026 through ADR-0029 record the video-primary, adaptive bitrate, NACK, and slow-link survival work. ADR-0030 records the current live-session transport: a single authenticated QUIC connection with ordered role streams and media datagrams. ADR-0031 records client-visible selected-display projection. ADR-0032 records bounded client diagnostics. ADR-0033 records the adaptive media quality ladder. ADR-0035 records the phone Agent feed. ADR-0051 (superseded by ADR-0053) records the terminal lane. ADR-0052 makes AgentDesk the workspace owner and adds the authenticated files lane at protocol version `6`. ADR-0053 moves the terminal `pty-manager` and `pty-client-swift` packages in-tree, removing the last build dependency on the retired `agent-workspace-ide` donor. ADR-0054 established the shared workspace-data boundary; ADR-0062 supersedes only its platform-presentation decision. ADR-0056 adds host-coordinated leased Agent Panel terminals and raises the session target to protocol version `7`. ADR-0057 adds the shared responsive DOCX renderer, a binary Files codec, and protocol version `8`. ADR-0058 sequences cursor input, separates feedback provenance, and raises the session target to protocol version `9`. ADR-0059 isolates Dock desktop-content mutation behind a transactional yabai adapter without changing the wire protocol or the single SkyLight reader. ADR-0060 keeps the input frame ceiling at 4 MiB while fragmenting only large on-demand Agent raw events. ADR-0061 composes the iOS workspace workbench, shares a host-owned workspace-terminal namespace with macOS, and raises the AgentDesk session protocol to `10`. ADR-0062 adds the shared responsive Workspace IDE and raises the AgentDesk session protocol to `11`. ADR-0063 established the one-recorder multi-window Chrome projection; ADR-0064 supersedes its local-only surface boundary, projects the same hierarchy to iOS, and raises the AgentDesk session protocol to `12`. ADR-0065 adds viewer-owned responsive browser source sizing and protocol `13`. ADR-0066 raises the inner PTY protocol to `6` for bounded Rust-owned terminal checkpoints, one shared logical grid, client-local fit, and metadata-only window restoration; the outer protocol stays `13`. ADR-0067 removes client window minimums and holds local terminal rendering at a readable scale floor before cropping around the parser cursor. ADR-0075 replaces the Agent feed digest with visibility-scoped no-cache subscriptions and raises the outer protocol to `15`. ADR-0076 adds the independently negotiated role-7 voice lane while keeping protocol `15`, and makes the Mac Python sidecar authoritative for shared-panel recordings.

ADR-0068 raises the inner PTY protocol to `7`, removes manual terminal sizing, and lets the last
selected or interacted-with active terminal viewer own the shared source grid dimensions.

ADR-0069 replaces SwiftTerm and platform-specific terminal workspace chrome with one bounded
WKWebView and xterm.js runtime while retaining PTY protocol `7`, AgentDesk protocol `13`, and the Rust
manager's state authority.

ADR-0072 separates PTY descriptor custody into one common, variant-scoped vault and requires stateful
live handover for both vault and manager code updates.

ADR-0070 adds explicit-opt-in, foreground-only client screenshot capture over authenticated
protocol `14`, with bounded ephemeral transfer and private host-side temporary artifacts.

ADR-0071 adds event-driven Mission Control topology reconciliation without changing the wire
protocol. Stable Space IDs are authoritative; display and ordinal are presentation metadata only.

ADR-0065 supersedes ADR-0048's fixed mobile-toggle contract with viewer ownership and raises the
AgentDesk session protocol from `12` to `13`.

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
9. **ClientDebugAutomation.** `ClientDiagnosticsRequester` and `ClientScreenshotRequester` collect bounded evidence from the active paired client over the session input lane first, then fall back to the foreground tailnet control path on the offer port using the stored paired host key for request signing. Screenshot assembly validates manifest metadata, chunk order, byte and pixel limits, and SHA-256 before private artifacts are written under an explicitly requested `/tmp/agentdesk-client-*` directory. Dev automation exposes screenshot-only, diagnostics-only, and combined debug-bundle operations without logging payloads.
10. **SessionAuthenticator.** Runs the per-connection mutual challenge-response on the session QUIC control stream. Rejects a peer whose advertised `protocolVersion` is below the host's `minCompatibleProtocolVersion` with `incompatible-protocol` (ADR-0020). Produces `SessionReady` with the session id, memory-only resume id, resume secret, resume expiry, and media key salt.
11. **QuicSessionTransport.** Owns the single live `NetworkConnection<QUIC>` and routes lanes by role. The control stream carries session init, challenge, proof, ready, resume, revoke, and heartbeat. The input stream carries `InputChannelEvent`, `ClientConfig`, diagnostics and screenshot requests and responses, and host pushes. The datagram lane carries authenticated `ADMD` media packets, packet resend requests, keyframe requests, ACKs, and link-health reports.
12. **MediaTransport.** Sends HEVC full-frame refreshes over the session datagram lane. Per ADR-0073, video is latest-frame-wins: capacity pacing may retain one replaceable latest capture, but old ACKs and repair attempts never block a newer capture behind obsolete media state. A newer complete frame abandons an older incomplete assembly and recovery converges on one coalesced keyframe while the client keeps its last good image visible. The media packet key is derived per session from fresh handshake material, the session id, and the `SessionReady.mediaKeySalt`; no static datagram key or separate media listener remains.
13. **ScrollDeltaEngine.** Rest-state retained-graphics producer (ADR-0025), retained as local crisp-repair/compositor machinery. Damage tiles through the content-cache ladder (`cacheTile`/`drawCachedTile`/`bitmapTile`), omitting cells that already match the retained baseline. It does not own a separate network connection.
14. **InputChannelServer.** Owns the host side of the session input stream. Preserves each `InputChannelEvent` cursor revision through dispatch, acknowledges the applied revision only to its originating channel, and tags independently observed Mac cursor movement with that channel's last applied revision. It also pushes desktop state, thumbnails, cursor image updates, text-input focus metadata, agent speech events, diagnostics and screenshot requests, and bounded Agent raw-event fragments on the same serialized lane.
15. **SignalingChannel.** Supplies length-prefixed QUIC stream framing and role routing for the session control and input streams. It is not a WebSocket wrapper.
16. **HostPtyRuntimeProcess.** Reuses matching Rust `pty-vault` and `pty-manager` generations on the host variant's Application Support sockets or launches bundled candidates. A changed candidate performs the ADR-0072 private handover before the old generation exits. The vault spawns commands and retains the primary PTY masters. The manager leases duplicate masters and owns terminal state and policy. The host never terminates a changed runtime peer.
17. **TerminalClientBridge.** Bridges a dedicated `.terminal` QUIC stream to the `pty-manager` Unix socket as opaque length-prefixed PTY protobuf frames. It does not decode terminal protocol payloads; it only enforces stream role and frame bounds. Persistent full-screen terminal clients remain trusted multiplexer clients with the existing session-management controls. Agent Panel creation and kill authority stays behind `AgentSessionTerminalCoordinator`; its iOS renderer attaches only to the deterministic PTY returned by that coordinator.
18. **VideoFrameSource.** Concrete implementation `ScreenCaptureKitFrameSource` captures one stream for the selected display and exposes a display-selection hook. `TestPatternFrameSource` exists as a diagnostic source.
19. **SpaceThumbnailProvider.** Host-local thumbnail source for Spaces, enabled by owner-scoped demand.
20. **SpaceAgent.** Host-local overlay under `host/AgentDeskHost/SpaceAgent/`, showing the draggable spaceship and active-display Spaces strip.
21. **DictationBar.** Host-local push-to-talk overlay under `host/AgentDeskHost/DictationBar/`, independent of the iPhone media and input channels.
22. **WorkspaceCoordinator.** Sole runtime mutation owner above the persisted workspace repository. Existing reveal chrome, file service, terminal coordination, observation, and IDE adapters consume immutable snapshots and submit typed mutations instead of retaining writable copies.
23. **WorkspaceShell.** AppKit sidebar and top bar composed at host launch. It uses AgentDesk Spaces,
    PTY, terminal launcher, and agent-feed ownership instead of donor implementations. Its Dock window-focus
    executor treats each icon as Desktop-scoped: one window focuses directly, multiple windows open
    the scoped chooser, an off-Space target waits for the exact stable Space id before reacquiring and
    raising its AX window, and an all-Spaces target focuses in place. It never moves the target window
    or falls back to a different window when identity is stale or ambiguous.
24. **DockDesktopSwapExecutor.** Host-only yabai adapter (ADR-0059). It accepts stable Space IDs, resolves current indices at transaction time, captures eligible windows, verifies every move, rolls back partial failure, and returns a conservative in-memory Undo receipt. It invokes the configured executable directly without a shell and does not reorder or create Spaces.
25. **WorkspaceFiles.** Walks workspace-relative path components from an open registered-root descriptor with `openat` and no-follow semantics, rejects traversal and symlinks, reads bounded UTF-8 content or read-only DOCX bytes, and performs atomic revision-checked text writes.
26. **WorkspaceLane.** Owns the host `.files` stream as a typed workspace lane. It serializes correlated file and Git requests with IDE subscriptions, idempotent shared-state operations, and unsolicited change/state pushes. Native document bytes retain the existing binary codec and frame bound. It never runs workspace I/O on the input or media lanes.
27. **AgentPanel.** Reusable WebKit surface whose authored Vite project lives at `packages/AgentPanel/Web`. React owns one visible layer at a time: projects, sessions for one canonical project, or events for one source-scoped session. Navigation closes the deeper subscription and opens its parent; no project or session response cache survives leaving that screen. The macOS adapter reads the AgentDesk-owned transcript sidecar directly; the iOS adapter carries the same request/push contract over the authenticated session. For the bottom terminal it emits session-scoped open, close, and context-ended intent only; it never renders a terminal or forwards terminal keystrokes (ADR-0075).
28. **AgentSessionTerminalCoordinator.** Host-only authority for Agent Panel resume terminals (ADR-0056). It validates project/source/session context, derives `agent-resume-<source>-<session-id>`, constructs the fixed Claude or Codex argv, serializes create-or-attach, holds a bootstrap client through native renderer handoff, rejects `activeElsewhere`, and owns immediate explicit kill. macOS calls it directly; iOS reaches the same coordinator through the terminal messages introduced in protocol v7 and carried by current protocol v10.
29. **WorkspaceTerminalCoordinator.** Host-only authority for persistent workspace shells (ADR-0061). It resolves an opaque workspace id through `WorkspaceStore`, validates a remembered running session against the workspace namespace, canonical root, and persistent lifetime, otherwise selects the newest eligible session by immutable PTY creation time, and creates one login shell at the root only when none exists. macOS and iOS use the same host-generated `workspace-<workspace-id>-<suffix>` names; no workspace root crosses the wire.
30. **WorkspaceIDEStateCoordinator.** Persists revisioned ordered open paths and expanded directory paths per workspace, applies idempotent operations, and fans snapshots to local and remote subscribers. It never owns selected workspace, active tab, drafts, cursor positions, or pane geometry.
31. **WorkspaceObservationCoordinator.** Reference-counts one watcher per observed workspace, advances one change generation, reads Git status once for that generation, and fans the result to the existing shell and all IDE subscribers. Clean open files refresh; dirty files become conflicted without replacing their buffers.
32. **DomBridgeServer.** Owns the `0600` Unix socket and token-authenticated native-messaging shim. It validates bounded complete browser snapshots separately from DOM batches and forwards validated projection metadata to local and authenticated remote viewers.
33. **BrowserProjectionSession.** Main-actor local state owner for one validated browser snapshot. It routes window, tab, tap, and scroll commands through `DomBridgeServer.sendToBridge`, admits page batches only for the projected window's active tab and generation, and feeds one AppKit `BrowserProjectionWindowController`.
34. **BrowserProjectionViewportCoordinator.** Host authority for active local and authenticated remote viewers. It caches each viewer's profile and dimensions, orders explicit claims, selects one owner, targets owner status, and sends only resolved epoch-and-revision source viewport commands to Chrome.
35. **BrowserProjection extension session.** Enumerates normal Chrome windows with tabs, groups, and bounded favicons; persists enabled state, stable window ordering, projected window, target document, recorder identity, and generation in `chrome.storage.session`; and owns one isolated recorder, one debugger attachment, and the desired source viewport.
36. **MissionControlTopologyObserver.** Registers current-macOS Dock accessibility entry notifications and legacy SkyLight event `1204` once, polls the unnamed layer-18 Dock window every 100 ms only while Mission Control is open, and reads one ordered user-Space topology on exit. Changed topology is reconciled through one `WorkspaceCoordinator` mutation. Space ID is the only assignment identity; absent IDs stay durable and unresolved rather than falling back to display and ordinal (ADR-0071).
37. **AgentFeedSidecar.** Loopback-only Bun service under `agent-feed/sidecar`. Its in-memory catalog reads unarchived Codex thread metadata from the highest `~/.codex/state_N.sqlite` and bounded headers from top-level `~/.claude/projects/<slug>/*.jsonl` sessions. Existing directories canonicalized by `realpath` are project identity; slugs and Git origins never are. Project snapshots perform no transcript body reads. Selected-project session snapshots make bounded head/tail probes, and only selected-session streams retain byte indexes. The service writes no inventory or response cache (ADR-0075).

### Client

1. **VideoFrameSink.** Concrete implementation `OwnedMediaVideoSink` owns one `AVSampleBufferDisplayLayer`, decodes `OwnedMediaFrameEnvelope` payloads, and renders the selected display surface. This is the current baseline. It preserves delta continuity by enqueuing complete deltas, but holds at most one replaceable frame for the next configured presentation interval. A pending frame superseded before that interval is enqueued with Core Media's `DoNotDisplay` sample attachment so it supplies HEVC reference state without visibly replaying stale history; the newest pending frame is displayed at the interval. The sink flushes queued display history only when the layer reports failure or requires flush to resume. Attached console traces split the owned-media lifecycle into host capture/admission/encode/send/ACK, transport packet completion and repair, client complete-to-render enqueue, stale-presentation suppression, and estimated display-layer state. Display traces explicitly mark `displayPresentation=estimated`; true on-screen presentation timing is not claimed with the current `AVSampleBufferDisplayLayer` renderer.
2. **GestureTranslator.** Converts UIKit gestures on the trackpad and scroll-strip surfaces to `NormalizedInput`. It does not send media quality hints.
3. **DisplayRailView.** Tap-based display selector driven by `DesktopStatePush` from the input channel. It labels host displays separately from the Spaces strip.
4. **SpacesDotsView.** One-handed Spaces switch surface driven by `DesktopStatePush` from the input channel. It filters Spaces by `selectedDisplayId` when present, falling back to `activeDisplayId`.
5. **KeyboardSurface.** Compact keyboard plus accessory row. Emits key and modifier input frames.
6. **PairingClient.** QR decode, token verification, and Keychain write. Reports the device display name (`UIDevice` name or hardware model identifier plus a short per-device id) in the handshake so the host labels the paired record. Its `TailnetServerTrustDelegate` applies strict TLS validation to FQDN dials and, for a tailnet CGNAT IPv4 literal (100.64.0.0/10), validates the cert chain but skips the hostname match, because the FQDN-only `tailscale cert` cannot pass a hostname check on an IP literal (ADR-0019). The L3 WireGuard peer auth plus the signed handshake are the real authentication.
7. **PairingOfferListener.** `NWListener` on the offer port, running only while the app is foregrounded. When the app is unpaired it routes pairing offers and `whois` probes. When paired, it additionally accepts signed diagnostics and screenshot requests from the paired host and returns bounded responses after fingerprint, signature, timestamp, and nonce validation. It prefers the `utun` tailnet IPv4 (100.x) over a carrier-CGNAT address when reporting its own address.
8. **SessionDialer.** Client mirror of session authentication. Rejects a host whose `protocolVersion` is below the client minimum with `incompatible-protocol` (ADR-0020). Opens the single QUIC session connection, authenticates on the control stream, resumes with a memory-only token inside the grace window, and clears stored credentials on terminal rejection.
9. **QuicSessionTransport.** Owns the connected client QUIC session. Input/control sends are immediate. Media datagrams are paced and are the first lane to drop or degrade under pressure.
10. **MediaTransport.** Uses the session datagram lane to verify `ADMD` v2 packets, repair missing packet indexes before deadline, skip stale delta frames, and ask for keyframe recovery only when decoder continuity requires it.
11. **OwnedHEVCFrameDecoder.** Planned `VTDecompressionSession` bridge for the hybrid worktree. It decodes HEVC refreshes into `CVPixelBuffer` output instead of enqueueing directly into `AVSampleBufferDisplayLayer`.
12. **OwnedSurfaceCompositor.** Planned `@MainActor` single writer for the retained BGRA surface. It applies HEVC full-surface refreshes and retained graphics commands in strict `(surfaceGeneration, frameId)` order, then commits the visible layer.
13. **InputChannel.** Reliable input lane inside the authenticated session QUIC connection. It stays logically independent from media even though both lanes share the same connection. Main-actor input sends are chained so cursor revision order is the order presented to the QUIC stream. It sends `ClientConfig.selectedDisplayId` when the user picks a display and sends client-owned media preferences (`crispTextOverlayEnabled`, `showHostCursorInVideo`, `mediaQuality`, and default-off `diagnosticScreenshotsEnabled`) on input-channel open and settings changes. `mediaQuality` carries adaptive on/off plus an optional fixed target. When adaptive is on, the host still owns rung selection; when adaptive is off, the host pins the video bitrate/FPS/resolution to the fixed target while packet repair and backpressure stay active. The lane receives revisioned cursor application acknowledgements, independently observed Mac cursor movement, host text-input focus metadata, diagnostics and screenshot requests, and Agent raw-event responses. It reassembles only raw-event fragment envelopes before delivering one logical response to the shared webview.
14. **CursorReconciliationStateMachine.** UIKit-free owner of pending cursor operations and prediction confidence (`confirmed`, `awaitingHost`, or `ghost`). It ignores stale applied positions as visible corrections, rebases genuine Mac movement and replays only newer client operations, uses the oldest pending deadline, and bounds its pending window. `PairingViewController` owns only transport/lifecycle wiring and the displayed cursor point.
15. **ClientDiagnosticsStore.** Bounded durable client diagnostics store in `Application Support/Diagnostics`. It persists structured NDJSON essentials for the current run plus two prior runs, rotates unclean exits on bootstrap, mirrors essentials to OSLog, summarizes delayed MetricKit payloads, and serves prior-run tails on demand over the input lane or the foreground tailnet control listener.
16. **ClientScreenshotCapturer.** Main-actor, memory-only capture authority for the visible foreground AgentDesk window. It rechecks the default-off setting for each request, composites UIKit hierarchy output with visible WebKit snapshots, declares omitted system and live-video layers, encodes one bounded JPEG, and exposes only a manifest plus ordered chunks. It rate-limits requests and posts an accessible on-screen disclosure after a successful capture.
17. **TerminalSurface.** Thin UIKit host for `PtyTerminalWebView` in workspace mode. The shared runtime owns bounded tabs, recursive splits, pane chrome, the session drawer, xterm rendering, selection, and input. Its remote backend opens one authenticated `.terminal` stream per pane, creates only fixed persistent login-shell sessions, and preserves close-client and close-session authority. UIKit owns visibility, safe-area lifecycle, and keyboard dismissal only.
18. **WorkspaceTransport.** Opens the authenticated `.files` workspace lane, correlates file and Git responses, serializes subscriptions and shared-state operations, and delivers unsolicited IDE-state and change pushes. It cancels pending work and subscriptions when the session ends.
19. **WorkspaceWorkbenchSurface.** UIKit composition selected from the Workspace control. Its resizable left sidebar owns workspace and directory navigation; its upper-right editor owns the existing shared WebKit file viewer/editor; its lower-right pane hosts `PtyTerminalWebView` in single-session mode for the selected workspace. The sidebar and terminal start visible, the editor starts empty, and pane geometry persists per workspace. Collapse and resize retain both webviews. The file SPA owns content-aware zoom: text, Markdown, and notebooks scale their typography, while DOCX retains responsive fit-width, page scaling, and pinch zoom. Text saves carry the last observed file revision and surface conflicts instead of overwriting host changes.
20. **AgentFeedSurface.** UIKit vertical container for the AgentPanel webview, native resize handle, and `PtyTerminalWebView` in single-session mode. It requests a host-coordinated leased PTY over protocol v7, attaches over `.terminal` with `createIfMissing=false`, acknowledges handoff, and owns iOS layout and explicit or involuntary lifecycle mapping. It does not construct harness commands or own process lifetime.
21. **WorkspaceIDEController.** Cross-platform package coordinator owning retained sidebar and editor WKWebViews, strict intent decoding, serialized data-source calls, request-generation fencing, device-local active state and drafts, 700 ms autosave, and tailored projections. Platform containers receive terminal and layout intents through a delegate.
22. **WorkspaceIDESurface.** Separate UIKit entry that composes the retained sidebar webview beside an editor webview and `PtyTerminalWebView` in single-session mode. The terminal starts open and reattaches through the existing workspace-terminal coordinator. Its active tab and pane geometry remain local while shared editor-tab membership and expanded folders reconcile from host pushes.

Tests required for v0: **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView.** Additional owned-media contract tests pin wire shapes, packet repair, and decoder recovery behavior where regressions are expensive.

## Agent Panel Terminal Flow

ADR-0056 locks the Agent Panel lifecycle below. The checked-in PTY pair now speaks protocol v7 under
ADR-0068 and the AgentDesk session speaks protocol v15. There is no compatibility decoder for an older
inner PTY protocol.

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
   renderer acknowledges attachment. A failed or timed-out handoff kills the new PTY. If the agent feed says the
   harness is live and the deterministic PTY is absent, open fails with `activeElsewhere`.
5. AppKit and UIKit each compose the AgentPanel webview above a native resize handle and
   `PtyTerminalWebView` in single-session mode. The feed shrinks as the terminal grows. The shared web
   terminal owns input, paste, selection, output, viewport participation, and focus; React owns none
   of them.
6. Explicit panel/context exit asks the coordinator to kill immediately. Unexpected renderer/socket
   loss detaches. A leased PTY is reaped only after its final client lease is absent for the configured
   grace, and a reattach during grace preserves its PID.

Platform ownership remains explicit:

| Owner | Responsibility |
| --- | --- |
| AgentPanel WebKit | Feed presentation and session-scoped terminal intent/status only. |
| Shared `PtyTerminalWebView` | xterm rendering, input provenance, output, paste, selection, focus, and viewport participation. |
| macOS AppKit adapter | Vertical layout, local coordinator calls, window/back/hide/close lifecycle. |
| iOS UIKit adapter | Vertical and keyboard-safe layout, v7 request routing, surface/background lifecycle. |
| Host coordinator | Context validation, deterministic identity, command construction, handoff, explicit kill, and `activeElsewhere`. |
| Rust `pty-vault` | PTY launch, primary descriptor custody, process identity, exact exit observation, signal, close, and vault handover. |
| Rust `pty-manager` | Descriptor leases, headless terminal state, bounded replay, client leases, viewport ownership, final-lease grace, manager handover, and session policy. |

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
SignedClientScreenshotRequest { t: "client-screenshot-request", rid, mp?, mb?,
                                hf, ts, n, hs }
ClientScreenshotManifest { t: "client-screenshot-manifest", rid, ca, sha, sn,
                           pw, ph, sc, o, mt, tb, h, ol }
ClientScreenshotChunk    { t: "client-screenshot-chunk", rid, s, f, p }
ClientScreenshotError    { t: "client-screenshot-error", rid, r }
```

The offer is an untagged `PairingPayload`; the iPhone synthesizes its `pairingURL()` locally and reuses the QR handshake path. `whois`/`id` carry only a display name for the picker and are pre-auth; the signed handshake still gates pairing. The payload carries the host's bound signaling port (`sp`), so the client dials the advertised port rather than a hardcoded default; this is what lets the stable and dev hosts run concurrently on tier-derived ports (ADR-0037).
Foreground diagnostics and screenshot fallback reuse the same offer port only when the app is paired and foregrounded. The host signs the complete request body with the paired host key; the client rejects a request whose host fingerprint does not match the stored pairing, whose signature fails, whose nonce was already used, or whose timestamp is outside the 60-second skew bound.

Session establishment is locked by ADR-0003, ADR-0011, ADR-0020, and ADR-0030. Frames on QUIC streams are length-prefixed. Protocol v8 encodes Files request/response bodies as binary property lists so `Data` stays binary. Protocol v9 changes the input body contract for revisioned cursor causality. Protocol v10 adds workspace-terminal control messages to the input body contract; control, graphics, DOM, terminal, and files bodies are unchanged.

```
QuicStreamFrame   = UInt8 role || UInt32BE length || body
role              = 1 control | 2 input | 3 graphics | 4 dom | 5 terminal | 6 files | 7 voice

SessionInit       { deviceFingerprint, sessionToken, clientNonce,
                    protocolVersion, minCompatibleProtocolVersion }   // current target: pv must be >= 15
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

The Agent feed input-lane contract is visibility-scoped. Every project and project-session watch has
a generated subscription ID echoed by pushes and errors so a response from a closed screen is
ignored. Source plus session ID is required everywhere below the project layer:

```
AgentProjectsWatch       { t: "agent-projects-watch", subscriptionId }
AgentProjectsUnwatch     { t: "agent-projects-unwatch", subscriptionId }
AgentProjects            { t: "agent-projects", subscriptionId, projects }
AgentProjectsError       { t: "agent-projects-error", subscriptionId, reason }
AgentProjectSessionsWatch   { t: "agent-project-sessions-watch", subscriptionId, projectPath }
AgentProjectSessionsUnwatch { t: "agent-project-sessions-unwatch", subscriptionId }
AgentProjectSessions        { t: "agent-project-sessions", subscriptionId, projectPath, sessions }
AgentProjectSessionsError   { t: "agent-project-sessions-error", subscriptionId, projectPath, reason }
AgentThreadSubscribe     { t: "agent-thread-sub", source, sessionId }
AgentThreadUnsubscribe   { t: "agent-thread-unsub", source, sessionId }
AgentThreadLoadOlder     { t: "agent-thread-older", source, sessionId, beforeIndex, limit }
```

The host-side loopback resources backing that contract are:

```
GET /api/projects
GET /api/projects/stream
GET /api/sessions?projectPath=<canonical-path>
GET /api/sessions/stream?projectPath=<canonical-path>
GET /api/sessions/:source/:sessionId/events
GET /api/sessions/:source/:sessionId/events/:eventIndex/raw
GET /api/sessions/:source/:sessionId/stream
```

Agent raw records use the fragmented input messages from ADR-0060. Historical thread pages carry only a Raw JSON marker:

```
AgentRawEventRequest  { t: "agent-raw-event-get", requestId, source, sessionId, eventIndex }
AgentRawEventResponse { t: "agent-raw-event", requestId, source, sessionId, eventIndex, text }
AgentRawEventPart     { t: "agent-raw-event-part", transferId, requestId, source, sessionId,
                        eventIndex, partIndex, partCount, totalByteCount, base64Data }
AgentRawEventError    { t: "agent-raw-event-error", requestId, source, sessionId, eventIndex, reason }
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

Each side rejects with `incompatible-protocol` when the peer's advertised `protocolVersion` is below its own `minCompatibleProtocolVersion`. Protocol v8 is required because the Files role changed from JSON text-only bodies to binary property-list bodies with native document bytes. Protocol v9 is required because cursor inputs now carry revisions and cursor feedback has distinct applied and host-moved frames. Protocol v10 is required because the iOS workbench coordinates a host-authorized workspace terminal on the input lane. Protocol v11 is required because the Files stream becomes the workspace lane and adds IDE state, Git status, and unsolicited workspace-change messages. Protocol v12 is required because the DOM stream carries full Chrome metadata and bidirectional window/tab selection. Protocol v13 adds authenticated viewer activity, ownership, profile, and source dimensions to that DOM contract. Protocol v14 adds explicit-opt-in, bounded client screenshot request and response frames to the input lane and signed foreground fallback. Protocol v15 removes the eager Agent feed digest, keys thread and raw-event traffic by source plus session ID, and replaces screen-independent pushes with subscription-scoped project and project-session snapshots. Older builds parse only far enough to be rejected. Matching marketing versions across host and client is not a compatibility signal; the protocol version is.

Terminal PTY frames travel over the reliable ordered `.terminal` stream as opaque PTY protobuf envelopes from AgentDesk's `terminal/pty-client-swift` and `terminal/pty-manager` pair (moved in-tree under ADR-0053). Both checked-in implementations enforce inner protocol v7. Protocol v4 added explicit launch and lifetime semantics; protocol v5 added immutable session creation time; protocol v6 added authoritative dimensions, revisions, and bounded chunked ANSI checkpoints; protocol v7 replaces manual resizing with authenticated-client viewer participation, ownership, and targeted viewport status. The private vault and handover protocols are local implementation details from ADR-0072 and do not change this client wire. There is no compatibility path for older inner protocols:

```
Terminal stream body = UInt32BE ptyFrameLength || Envelope {
  protocol_version: 7,
  session_name,
  payload: CreateOrAttach {
    createIfMissing,
    launch: ShellLaunch | CommandLaunch { executable, arguments: [String] },
    lifetime: persistent | leased
  }
  } | Output { data, revision }
    | TerminalViewerState { sequence, active, claim, columns, rows }
    | TerminalViewportStatus {
        ownershipEpoch, ownerClientId, ownerTitle, isOwner,
        sourceColumns, sourceRows, sourceRevision, viewColumns, viewRows
      }
    | TerminalCheckpointBegin { checkpointId, revision, columns, rows, totalBytes, chunkCount }
    | TerminalCheckpointChunk { checkpointId, index, data }
    | TerminalCheckpointEnd { checkpointId, revision }
    | RequestTerminalCheckpoint { lastAppliedRevision }
}

SessionSummary {
  sessionName, lifetime, startedAtUnixMilliseconds, columns, rows, revision,
  ownerClientId, ownershipEpoch, clients { active, columns, rows, isOwner, ... }, ...
}
```

The generated protobuf types retain the `pty.v1` package prefix; compatibility is governed by
`Envelope.protocol_version`, which is `7`. The package/type name does not make the current inner
protocol v1.

Each manager session parses PTY output into one bounded headless Alacritty terminal before assigning a
revision and publishing it. Attach, owner-dimension change, explicit checkpoint request, and slow-client
recovery send a complete checkpoint; the next accepted live output must be the next revision. Slow
clients are replaced in place with a newer checkpoint. The logical grid is manager-owned. The last
selected or interacted-with active viewer owns its dimensions; passive reports from followers cache
their capacity without resizing. A different owner capacity resizes the PTY and headless grid once,
advances revision once, and checkpoints all clients. An equal-size transfer advances only ownership
epoch. Input and paste claim with the sender's latest valid capacity before bytes reach the PTY.

Web terminal followers preserve the owner's grid and fit it locally while the required scale is at least
75 percent. Below that threshold, the shared runtime holds 75 percent scale, clips
overflow, and follows the parser cursor with a two-cell inset after layout or output without requiring
focus. Passive container layout never claims ownership. All checkpoint/history, viewer-capacity, and
ownership state is memory-only and bitmap terminal graphics are not replayed.

`PtyTerminalWebView` is the native renderer coordinator. Its private nonpersistent WKWebView loads only
bundled resources through `agentdesk-terminal://`; CSP disables network access. The versioned internal
bridge validates message tags, terminal identifiers, dimensions, revisions, links, and input sizes.
Native-to-web writes are serialized and bounded to 1 MiB of live output per terminal and 32 MiB per
WKWebView. Overflow, JavaScript failure, navigation failure, or WebKit process termination pauses the
affected renderer, reloads the runtime, and resumes only from a complete replacement checkpoint.

`PtyTerminalWorkspaceState` is authoritative for a maximum of 16 tabs and 16 total panes. JavaScript
renders immutable snapshots and emits intents. Full macOS and iOS Terminal surfaces use workspace
mode; context-bound Agent and Workspace terminals use single-session mode with management controls
absent. Hidden panes release viewport participation. Selecting or interacting with a pane claims using
its measured capacity, while passive follower layout remains presentation-only.

The outer `QuicStreamFrame` identifies the stream role. The inner PTY frame is owned by the Rust manager and Swift PTY client; AgentDesk's host bridge does not reinterpret create/attach, viewer-state, viewport-status, input, output, detach, kill, close-client, subscribe, or session-list messages. `ShellLaunch` preserves the existing login-interactive shell behavior. `CommandLaunch` executes the supplied executable with its argument array directly through Rust `CommandBuilder`; argument boundaries survive protobuf decoding and no shell command string is assembled by `pty-manager`. Every caller must choose a lifetime explicitly.

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

## Host-owned shared voice flow

The Gesture/Voice InteractionPanel uses one browser protocol for both capture sources:
`sessionStart`, 2,048-sample mono Float32 `audioFrame` messages, and `sessionStop`. The macOS bundle
opens the loopback Python WebSocket directly with source `macos`. The iOS bundle posts the same
messages through `__interactionDeliver` and native Swift, which opens authenticated stream role
`.voice = 7`. A `voice-lane-v1` hello/ready exchange gates the lane independently from outer protocol
`15`; every handshake failure before ready becomes the bounded update-host error.

The lane carries typed socket open/message/close envelopes and correlated allowlisted recording REST
requests. JSON is limited to 192 KiB and complete lane frames to 256 KiB. Recording audio playback
responses are split into 96 KiB chunks with per-request sequence and final markers. REST work may run
concurrently with the socket so list polling or WAV playback cannot stop the lane from receiving PCM.
The host forces source `iphone`, accepts only recording list/detail/audio/delete/reanalyze paths, and
proxies to the loopback sidecar; it never stores or analyzes voice in Swift. The input lane never
carries PCM.

Python permits one active capture globally. Stop and transport loss both persist nonempty PCM as a
host WAV, atomically create metadata, run full-file MLX Whisper, and run the pinned ZIPA ONNX
recognizer against the same WAV. Transcript and phone failures are independent persisted stages and
never delete the audio. Empty disconnects are discarded; an empty explicit Stop returns a terminal
error. Reanalysis reads the retained WAV and updates only phone-analysis metadata. The ONNX session is
hash-verified, cached for the sidecar lifetime, and inference is serialized. The fullscreen native
Voice/Passage surface remains a separate on-device experiment and is not a fallback for this flow.
Recording responses derive a Passage view from the saved transcript, flat ZIPA phone sequence, pinned
CMUdict revision, and the shared ARPABET-to-model-phone mapping. The host aligns the unconstrained
phones to reference words for display while retaining unanchored phones explicitly; the web panel
shows separate transcript, heard-phone, and reference-phone cards. These word groups are presentation
alignment, not acoustic word boundaries, and are not a second persisted analysis authority.
The reference card's whole-passage and per-word speaker actions send a bounded local
`referenceSpeech` request to the containing app. macOS and iOS play it with `AVSpeechSynthesizer`;
ordinary browser development uses Web Speech as a preview fallback. Reference TTS never crosses the
voice or input lanes, is not retained as reference audio, and is stopped before microphone capture.

## Workspace Workbench Terminal Flow

ADR-0061 adds one persistent workspace shell to the iOS Workspace workbench without replacing the global
Terminal surface or exposing host filesystem authority:

1. The workbench sends an opaque workspace id, an optional remembered PTY session name, and the desired
   terminal size over the authenticated input lane. It cannot send cwd, shell, executable, or arguments.
2. The host resolves the workspace through `WorkspaceStore`. A remembered session is eligible only when
   it is running, persistent, named in that workspace's namespace, and rooted at the canonical workspace
   path. Otherwise the coordinator selects the eligible session with the greatest immutable creation
   time. It creates a persistent login shell at the workspace root only when no eligible session exists.
3. The host holds a bootstrap PTY attachment while the client opens a dedicated `.terminal` stream and
   attaches with `createIfMissing=false`. The client acknowledges only after the shared web terminal is attached. A
   failed or timed-out handoff detaches the bootstrap and kills only a newly-created, otherwise-unowned
   session; it never kills a preexisting Mac terminal.
4. The workbench stores only the returned PTY name. Collapse, workspace switching, transport loss, and
   app teardown detach native clients but leave persistent sessions alive. Reconnect or relaunch offers
   the remembered name again; the host still validates it before reuse.
5. macOS workspace terminal launch uses the same host-owned identity generator. It does not use the
   global `agentdesk-N` namespace, so the iPhone can discover the newest same-workspace Mac terminal
   without treating unrelated shells or leased Agent Panel terminals as candidates.

Workspace terminal coordination requires AgentDesk session protocol v10:

```
WorkspaceTerminalOpen        { t: "workspace-terminal-open", requestId, workspaceId,
                               preferredSessionName?, columns, rows }
WorkspaceTerminalReady       { t: "workspace-terminal-ready", requestId, workspaceId,
                               ptySessionName }
WorkspaceTerminalAttachedAck { t: "workspace-terminal-attached", requestId, workspaceId,
                               ptySessionName }
WorkspaceTerminalCancel      { t: "workspace-terminal-cancel", requestId, workspaceId,
                               ptySessionName? }
WorkspaceTerminalError       { t: "workspace-terminal-error", requestId, workspaceId,
                               ptySessionName?,
                               code: "workspaceUnavailable" | "invalidSession" | "launchFailed" |
                                     "handoffTimedOut" | "sessionEnded" }
```

The client fences every asynchronous completion by request id and selected workspace. A ready response
for a stale selection is cancelled and cannot replace the visible terminal. Terminal bytes remain
opaque PTY v6 frames on the `.terminal` lane; no workspace path appears in these input messages.

Workspace files travel over the reliable ordered `.files` stream. Every request carries a correlation id and workspace id. Paths are normalized relative paths, never absolute host paths.

Under ADR-0062 the stream role remains `.files`, but its application body is a `WorkspaceLaneEnvelope`.
The existing file messages are payload variants inside that envelope; IDE state, Git status, and change
notifications do not create another transport or another filesystem authority.

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

WorkspaceLaneRequest =
  | { t: "files", request: WorkspaceFilesRequest }
  | { t: "ide-subscribe", rid, wid }
  | { t: "ide-unsubscribe", rid, wid }
  | { t: "ide-operation", rid, wid, baseRevision, operationId, operation }
  | { t: "git-status", rid, wid }

WorkspaceLaneResponse =
  | { t: "files", response: WorkspaceFilesResponse }
  | { t: "ide-snapshot", rid?, state }
  | { t: "git-status-result", rid?, wid, generation, entries }
  | { t: "workspace-changed", wid, generation, changedPaths }
  | { t: "workspace-error", rid?, wid?, code, message }

WorkspaceIDESharedState { workspaceId, revision, orderedOpenPaths, expandedDirectoryPaths }
WorkspaceIDEOperation = open(path) | close(path) | reorder(orderedPaths)
                      | expand(path) | collapse(path)
WorkspaceGitStatusEntry { relativePath, indexStatus?, workTreeStatus? }
```

The host never authorizes a file by comparing reconstructed absolute path strings. It rejects empty, absolute, `.` and `..` components, opens the registered root once, and walks beneath that descriptor with `openat` plus `O_NOFOLLOW`; regular-file and directory requirements are checked from the opened descriptors. UTF-8 text retains its 4 MiB default; DOCX has an independent configurable admission ceiling capped at 100 MiB. The Files role permits a 101 MiB application frame while every other role retains the 4 MiB frame ceiling. QUIC performs reliable stream segmentation and reassembly, so there is no AgentDesk document-chunk protocol. A revision is a digest of the exact file content returned by the last read. Writes remain text-only: they create a temporary sibling through the verified parent descriptor, fsync as required, then rename atomically within that descriptor only when the supplied content revision still matches.

## Shared Workspace IDE Flow

ADR-0062 adds a separate embedded IDE without removing the current native Workspace surfaces.

1. AppKit or UIKit creates one `WorkspaceIDEController`, which retains a sidebar WKWebView and editor
   WKWebView. Both load the same bundled application with an immutable region bootstrap. Web code emits
   typed intents only; the native controller is the sole presentation state owner.
2. Selecting a workspace is device-local. The controller subscribes through its data source, restores
   local pane and active-tab state, receives the host's ordered open paths and expanded directories,
   and projects tailored immutable snapshots to both webviews in one serialized delivery turn.
3. Opening, closing, reordering, expanding, or collapsing submits an idempotent operation against the
   last shared-state revision. A resulting host snapshot pushes to every subscriber. A remote close
   leaves a dirty local tab protected until its draft is saved or its conflict is resolved.
4. Text edits persist to a device-local draft store and replace a 700 ms autosave debounce. Writes carry
   the last file revision. Success advances the baseline and deletes the draft. Transport failure keeps
   it. Conflict pauses autosave and requires Use Host or Keep Mine; Keep Mine first reads the current
   host revision and then retries the retained draft explicitly.
5. One host observation coordinator advances change generations and performs one Git read per generation.
   It refreshes visible listings and clean files. Dirty files become conflicted. DOCX refresh uses the
   existing file-identity viewport state so scroll and zoom survive content replacement.
6. macOS calls the same contract in-process. iPhone uses protocol-v11 workspace-lane messages. The
   platform shell alone owns native dividers, keyboard avoidance, focus, and the lower-right shared web terminal.
   DOCX bytes are registered in the native resource store and reach WebKit through `app://` rather than JSON.

`WorkspaceIDEPlatformCapabilities` is enforced before a delegate call. macOS may add, remove, reorder,
assign Desktop, and auto-assign workspaces. iPhone may select only existing opaque workspace ids. A
forged script message receives a typed capability error and cannot reach the host adapter.

## Chrome Projection

ADR-0064 projects the ADR-0063 one-recorder browser model through the same shared shell on macOS and iOS. ADR-0065 makes the last activated visible Browser viewer the source-viewport owner.

1. The extension emits one complete `browser-state` snapshot after start, reconnect, relevant Chrome
   metadata events, projection selection, and explicit host request. Only `normal` Chrome windows are
   included. Stable session-local ordinals follow discovery order.
2. `focusedWindowId` is Chrome's last positive normal-window focus. `projectedWindowId` is the window
   AgentDesk displays. A positive Chrome focus event aligns both. `WINDOW_ID_NONE` changes neither.
   AgentDesk outer selection changes only `projectedWindowId`.
3. The projected window's active tab is the only recorder target. A tab selection is valid only for
   that projected window and activates the existing Chrome tab without focusing its window.
4. Recorder teardown happens before a generation increment. Window changes, active-tab changes, URL
   changes, same-URL loading transitions, and discarded-target transitions invalidate the page. The
   generation is passed into the isolated content recorder and returned on every `dom-batch`.
5. The extension, host local session, and webview each require matching generation and tab id. A state
   transition clears the content stage before any new batch is accepted. Restricted, discarded,
   loading, disconnected, and empty-browser states are explicit placeholders.
6. The webview contains nested ARIA tablists, a read-only toolbar, a reconstructed page, and build
   diagnostics. Metadata uses DOM text properties. Only existing-window and existing-tab selection is
   actionable. Tap and scroll overlays exist only for a matching active page.
7. `browser-state` reaches the local `BrowserProjectionSession` directly and is also retained by
   `DomMirrorRelay` for authenticated remote DOM lanes. A late iOS attachment receives
   `projection-host`, the latest validated `browser-state`, buffered checkout/incremental batches, and
   `dom-status`, in that order. The iPhone validates metadata before delivering it to the shared shell.
8. iOS window and tab selections return on the existing serialized DOM stream. The host forwards only
   `browser-select-window` and `browser-select-tab` to the native bridge; the extension validates
   generation and membership and preserves the focus semantics above.
9. Ordinary page text, attributes, and non-password form values remain visible in `dom-batch`.
   `input[type=password]` values are masked inside the extension on both rrweb and CDP paths before
   compression. The extension, native shim, host bridge, and relay never log DOM payload content.
10. Each viewer sends `browser-viewer-state` with activity, claim intent, desktop or mobile identity,
    viewer, custom, or preset sizing, and a validated 1 through 4096 CSS-pixel size. Remote identity is
    the authenticated device fingerprint. Passive geometry updates do not claim ownership.
11. The host selects the last activated active viewer and sends `browser-source-viewport` with a host
    epoch, monotonic revision, current target, profile, sizing, and dimensions. When no viewer remains
    active, it sends an inactive source request that pauses capture and restores Chrome's native
    metrics, UA, touch, and debugger state.
12. A source change stops recording before advancing generation, applies CDP device metrics, UA, and
    touch state, queries actual layout dimensions, then starts rrweb. The requested and actual sizes
    remain distinct in `browser-state`. A failed apply publishes an error and no stale page.
13. Desktop is 1440 by 900 with desktop UA and no touch. Mobile is 390 by 844 with mobile UA, mobile
    layout semantics, DPR 3, and touch. Viewer-linked sizing follows the visible content stage after a
    trailing 150 ms debounce. Local fit, zoom from 50 to 400 percent of Fit, and magnified pan transform
    rrweb and CDP together without changing Chrome or generation.

```text
browser-state { generation, projectedWindowId?, focusedWindowId?, extension, viewport, windows[] }
window        { id, ordinal, focused, state, bounds?, activeTabId?, tabs[], groups[] }
tab           { id, windowId, index, active, pinned, groupId, status, title, url,
                favIconDataURL?, audible, muted, discarded, restricted }

browser-select-window { windowId, generation }
browser-select-tab    { windowId, tabId, generation }
browser-viewer-state  { active, claim, profile, sizing, width, height }
browser-viewer-status { owner, active, profile, sizing, width, height }
browser-source-viewport { hostEpoch, revision, active, tabId?, generation,
                          profile?, sizing?, width?, height? }
dom-batch             { tb: tabId, g: generation, co, ... }
```

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
                      showHostCursorInVideo?, mediaQuality?,
                      diagnosticScreenshotsEnabled }
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
ClientScreenshotRequest { requestId, maxPixelDimension?, maxBytes? }  // t: "client-screenshot-request"
ClientScreenshotManifest { requestId, capturedAt, clientBuildSHA,
                           surfaceName, pixelWidth, pixelHeight, scale,
                           orientation, mimeType, totalBytes, sha256,
                           omittedLayers }                             // t: "client-screenshot-manifest"
ClientScreenshotChunk { requestId, sequence, isFinal, payloadBase64 } // t: "client-screenshot-chunk"
ClientScreenshotError { requestId, reason }                           // t: "client-screenshot-error"
```

`NormalizedInput.cursorSet { displayId, x, y }` is an absolute cursor retarget in host/global display points, same coordinate space as `DesktopState.cursorX/cursorY`. The host accepts it only when `displayId` matches the currently selected display, clamps it to that display bounds, posts one mouse move, and uses the set point as the base for subsequent relative cursor moves. The iPhone uses it after manual zoomed-viewport pan: viewport browsing stays local, then the next pointer-location-dependent action sends `cursorSet` before the original pointer input so the host cursor starts from the visible region.

Every `cursorSet` and `cursorMove` carries a monotonically increasing `cursorRevision`; non-cursor input must not carry one. `CursorAppliedPush` is emitted by the originating host input channel only after that cursor event is posted. An older applied position advances client progress but never rewinds a newer local prediction. `HostCursorMovedPush` is emitted only for movement observed while remote cursor dispatch is idle and carries that channel's last applied revision. The client rebases at the host position and replays pending operations newer than that revision. If the oldest pending operation is not confirmed within the configured deadline, send fails, the channel is absent, or the bounded pending window fills, the locally predicted cursor becomes a grey ghost until the host catches up or the session resets (ADR-0058).

`DiagnosticsChunk.payloadBase64` is gzipped NDJSON. The client caps each encoded payload chunk at 48 KB and the total response at 768 KB unless the host requests less.

`ClientScreenshotChunk.payloadBase64` carries one JPEG split into ordered chunks of at most 256 KiB
before base64 encoding. The client caps the long edge at 2,048 pixels and the encoded image at 4 MiB,
or applies smaller request bounds. It captures only its visible foreground app window after explicit
opt-in, stores no image on the client, and reports omitted system or live-video layers in the manifest.
The host verifies the manifest, exact aggregate size, chunk sequence, and SHA-256 before writing
`client.jpg` and `manifest.json` with private permissions under `/tmp/agentdesk-client-*`.

## Diagnostics Retention

- The client persists structured essentials to `Application Support/Diagnostics`.
- Retention is fixed for v0: current run plus two previous runs, 2 MB per run, 6 MB total.
- When the current run exceeds its cap, oldest events are dropped from that run first.
- On next launch, an unfinished current run is rotated to the archive set and surfaced as `previousRunUncleanExit`.
- Prior unclean runs remain requestable until the host retrieves them or bounded retention evicts them.

## On-Demand Client Screenshot Privacy

- The client setting is off by default and remains authoritative even when an older advertised config
  said capture was enabled.
- Capture is rejected while the app or its own window is hidden, backgrounded, or inactive.
- System keyboard and system overlay windows are not captured. Live video may be omitted and must be
  declared rather than represented as complete.
- Image bytes, chunks, rendered text, typed input, and clipboard content never enter client durable
  diagnostics or either side's logs.
- Every successful capture shows `Screenshot shared with paired Mac` in the client UI.
- The host writes an image only for an explicit local automation request and uses directory mode
  `0700` and file mode `0600`.

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

- Persistent sessions continue parsing into their bounded headless terminal with zero clients. A late
  client receives a protocol-7 checkpoint before revisioned live output.
- One session has one shared logical grid. The last activated active viewer owns its source dimensions;
  owner resizing is debounced, serialized by the manager, and resets every client from one new
  checkpoint. Passive follower layout changes only cached view capacity and local fit.
- Selection, window activation, pointer or touch interaction, input, and paste may claim without
  terminal first-responder focus. Owner release promotes the most recently activated remaining active
  viewer. With no active viewers, the source grid remains frozen while bounded parsing continues.
- Standalone macOS terminal windows persist metadata-only presentation descriptors and reattach on host
  restart without creating missing shells, taking focus, or claiming terminal ownership. Embedded
  panes keep their owner lifecycle.
- PTY lifetime is independent of the QUIC session state. Persistent workspace PTYs survive client detach and remain manager-owned until explicit kill, natural exit, or manager replacement.
- Agent Panel resume PTYs are leased. The manager schedules the configured final-lease grace only when detach, close-client, or socket loss removes the final attached client. The production target is 30 seconds through host central config; tests inject shorter values.
- Reattach during PTY grace cancels reaping and preserves the PTY/PID. With Mac and iPhone attached, the first detach cannot schedule a reap; only loss of the final lease can do so.
- Explicit terminal close, panel back/context change, session replacement, iOS switch away from Agent or teardown, macOS Agents-window close, revoke, and app termination go through the host coordinator and kill the leased PTY immediately. They do not wait for grace.
- If the final lease is still absent when grace expires, `pty-manager` asks `pty-vault` to kill the harness and removes its PTY, clients, and registry state. Natural harness exit and explicit kill cancel pending reap work. Manager handover transfers leased sessions without applying shutdown policy.
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
