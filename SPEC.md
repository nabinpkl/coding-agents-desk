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
| Terminal presentation | Shared `PtyTerminalWebView` for Workspace/standalone terminals; AgentPanel-owned xterm.js for selected agent sessions | Workspace and standalone terminals keep their shared terminal workspace. The Agent Feed renders its terminal in the existing responsive panel so one TypeScript surface owns layout, xterm input, replay, and resizing on macOS, iOS, and an ordinary browser. Rust remains authoritative for PTY state. ADR-0069 and ADR-0108. |
| Browser projection | MV3 extension, authenticated native bridge, shared `BrowserProjection` WebKit package | macOS and iOS render every normal Chrome window and tab; one selected tab supplies isolated-world rrweb batches. The last active viewer owns Chrome's emulated source viewport while zoom remains local. Focus and projection are independent, and generation fencing prevents prior pages from leaking into a new selection. ADR-0064 and ADR-0065. |
| Transport | One authenticated `NetworkConnection<QUIC>` per live session, ALPN `agentdesk-session-quic-v2` | Control, input, DOM, terminal, files, and iPhone voice use ordered QUIC streams. HEVC media uses the same connection's datagram lane. File and voice payloads cannot head-of-line block input. ADR-0030, ADR-0052, and ADR-0076. |
| Network | Tailscale only | No public rendezvous, relay, or internet routing. Both peers are on the tailnet. |
| Pairing | Mac-initiated tailnet device picker (ADR-0019), QR fallback | The Mac enumerates online iOS tailnet peers, probes each on the plain-TCP offer port (`AGENTDESK_OFFER_PORT`, default 41890) for a self-reported display name, and pushes a pre-approved signed offer to the picked device. The pick is the authorization. The iPhone runs the unchanged signed handshake. Signed token stored in Keychain on both sides. |
| Wire compatibility | Current protocol version is 16 (ADR-0020, ADR-0057, ADR-0058, ADR-0061, ADR-0062, ADR-0064, ADR-0065, ADR-0070, ADR-0075, ADR-0076, ADR-0091) | Protocol v8 changes the Files body codec to carry native document bytes. Protocol v9 sequences cursor input. Protocol v10 adds workspace-terminal coordination. Protocol v11 generalizes Files into the workspace lane. Protocol v12 projects the complete Chrome hierarchy to iOS. Protocol v13 adds authenticated Browser viewer viewport ownership. Protocol v14 adds opt-in, on-demand paired-client screenshots. Protocol v15 replaces the eager Agent feed digest with visibility-scoped project, session, and event subscriptions. Protocol v16 makes agent sources capability-described, adds mutable sequenced timeline events and correlated create/send/abort/extension-UI commands, and places Pi behind the host-owned provider adapter. Host and client reject peers below `16` with `incompatible-protocol`; matching app versions remain irrelevant. |
| Spaces enumeration | Private SkyLight/CoreGraphics symbols bound with `dlopen` and `dlsym` | No public API exists. Risk is acceptable because App Store distribution is not the v0 target. Mission Control topology edits use event-driven entry and bounded exit observation under ADR-0071. |
| Spaces switch | Synthesize Dock swipe `CGEvent`s via `SpacesProvider.postDockSwipeFrame` and `commitStep(delta:)` | Stock macOS path that preserves live Space transition animation. |
| Input dispatch | `CGEventPost` for mouse, keyboard, modifiers | One host code path for all remote input. |
| Distribution | Developer ID notarized DMG for Mac, TestFlight internal for iOS | One author, one device. |

ADR-0001 records the original v0 stack decision. ADR-0015 records the owned single-surface media baseline. ADR-0016 records the scroll-first hybrid retained-graphics worktree architecture that has since been narrowed by the video-primary work. ADR-0019 records Mac-initiated tailnet pairing with a host-side device picker. ADR-0020 records the handshake-negotiated wire protocol version. ADR-0021 through ADR-0025 record the retained-graphics and motion-carrier iterations. ADR-0026 through ADR-0029 record the video-primary, adaptive bitrate, NACK, and slow-link survival work. ADR-0030 records the current live-session transport: a single authenticated QUIC connection with ordered role streams and media datagrams. ADR-0031 records client-visible selected-display projection. ADR-0032 records bounded client diagnostics. ADR-0033 records the adaptive media quality controller (its rung ladder is superseded by ADR-0101). ADR-0035 records the phone Agent feed. ADR-0051 (superseded by ADR-0053) records the terminal lane. ADR-0052 makes AgentDesk the workspace owner and adds the authenticated files lane at protocol version `6`. ADR-0053 moves the terminal `pty-manager` and `pty-client-swift` packages in-tree, removing the last build dependency on the retired `agent-workspace-ide` donor. ADR-0054 established the shared workspace-data boundary; ADR-0062 supersedes only its platform-presentation decision. ADR-0056 introduced host-coordinated Agent Panel terminals and protocol version `7`; ADR-0108 supersedes its native composition with an AgentPanel-owned xterm and sidecar HTTP resource without changing the current outer protocol. ADR-0057 adds the shared responsive DOCX renderer, a binary Files codec, and protocol version `8`. ADR-0058 sequences cursor input, separates feedback provenance, and raises the session target to protocol version `9`. ADR-0059 isolates Dock desktop-content mutation behind a transactional yabai adapter without changing the wire protocol or the single SkyLight reader. ADR-0060 keeps the input frame ceiling at 4 MiB while fragmenting only large on-demand Agent raw events. ADR-0061 composes the iOS workspace workbench, shares a host-owned workspace-terminal namespace with macOS, and raises the AgentDesk session protocol to `10`. ADR-0062 adds the shared responsive Workspace IDE and raises the AgentDesk session protocol to `11`. ADR-0063 established the one-recorder multi-window Chrome projection; ADR-0064 supersedes its local-only surface boundary, projects the same hierarchy to iOS, and raises the AgentDesk session protocol to `12`. ADR-0065 adds viewer-owned responsive browser source sizing and protocol `13`. ADR-0066 raises the inner PTY protocol to `6` for bounded Rust-owned terminal checkpoints, one shared logical grid, client-local fit, and metadata-only window restoration; the outer protocol stays `13`. ADR-0067 removes client window minimums and holds local terminal rendering at a readable scale floor before cropping around the parser cursor. ADR-0075 replaces the Agent feed digest with visibility-scoped no-cache subscriptions and raises the outer protocol to `15`. ADR-0076 adds the independently negotiated role-7 voice lane while keeping protocol `15`, and makes the Mac Python sidecar authoritative for shared-panel recordings. ADR-0078 removes the session lifetime distinction and every timed reap: a PTY session lives as long as its process, and only an explicit act ends it. ADR-0082 starts a silent Whisper prewarm through the voice sidecar's single MLX executor while keeping server liveness nonblocking. ADR-0083 starts retained Kokoro prewarm, while ADR-0084 separates its model serialization from cache access and bounds generated artifacts at 256 MiB. ADR-0092 unifies multi-instance IDE, Agents, and Terminal restoration behind one verified Desktop placement authority. ADR-0097 extends ADR-0075's no-body-reads rule from the projects screen to a project's session list: the two facts a row needed from a transcript now ride the bounded metadata read that already discovers the session, and listing became a projection over records already in memory rather than a scan. ADR-0098 rate-matches the owned-media path to the link: a token bucket governs the datagram wire so a keyframe is spread rather than burst, the quality controller's input separates what the host produced from what the link delivered so a freeze can lower the target, and goodput measured from acked bytes becomes a control input rather than a log line. ADR-0101 makes that target one continuous bitrate with a derived cadence, retiring the fixed rung ladder. ADR-0104 supersedes ADR-0089: the client session becomes an object that outlives its QUIC carrier, exactly one liveness clock (fed by ALL inbound traffic, with a framed session-ping/pong on the input lane manufacturing evidence only when quiet) may end a session, and every carrier death routes to a surface-preserving reattach instead of a teardown.

ADR-0091 places directly controlled agent sessions behind provider-neutral sidecar backends, adds
sequenced mutable timelines and correlated commands, and raises the outer protocol to `16` without
changing the inner PTY protocol.

ADR-0068 raises the inner PTY protocol to `7`, removes manual terminal sizing, and lets the last
selected or interacted-with active terminal viewer own the shared source grid dimensions.

ADR-0085 makes a human-owned practice passage, rather than a machine transcript, the shared Voice
library authority.

ADR-0069 replaces SwiftTerm and platform-specific terminal workspace chrome with one bounded
WKWebView and xterm.js runtime while retaining PTY protocol `7`, AgentDesk protocol `13`, and the Rust
manager's state authority.

ADR-0072 separates PTY descriptor custody into one common, variant-scoped vault and requires stateful
live handover for both vault and manager code updates. ADR-0080 amends its failure policy: a live
vault is never terminated by an update, a manager that cannot hand over is replaced and re-adopts the
vault's sessions, and no code or wire change can end a session or require a manual reset.

ADR-0070 adds explicit-opt-in, foreground-only client screenshot capture over authenticated
protocol `14`, with bounded ephemeral transfer and private host-side temporary artifacts.

ADR-0071 adds event-driven Mission Control topology reconciliation without changing the wire
protocol. Stable Space IDs are authoritative; display and ordinal are presentation metadata only.

ADR-0065 supersedes ADR-0048's fixed mobile-toggle contract with viewer ownership and raises the
AgentDesk session protocol from `12` to `13`.

## Local runtime installation

ADR-0113 separates disposable build candidates from installed runtime. One resolver,
`tools/runtime-paths.mjs`, serves the Node recipes and the live/compiled TypeScript sidecar. The
default `~/Library/Application Support/AgentDeskRuntime` root is overridable with
`AGENTDESK_RUNTIME_ROOT`; it holds `hosts/<bundle-id>/AgentDeskHost.app`, `bin/grid-encoder`, panel
TLS/token state, and the separate park-development token. Existing paired-device state and PTY
sockets remain under their host bundle-id Application Support directories.

Plain `just host-run` defaults to a live Agent Panel and watched agent-feed sidecar, prepares PTY
helpers, installs the desktop helper, and stages the automatically provisioned voice sidecar.
An unhealthy panel listener or missing durable credentials is repaired before host launch; healthy
servers are reused. Voice packaging does not depend on disposable ZIPA model staging.

`host-run` and `host-run-dev` build in DerivedData, validate/copy the signed app into its installed
home, and launch only that copy. Exact process discovery uses that same path. Helper deployment is
independent: `just grid-encoder-install` builds then atomically publishes changed executable content;
ordinary compilation and `just check` never replace the installed helper. Mtime remains the helper
pool's cheap generation signal. Invalid candidates and external bundle links are rejected, and a
missing helper fails explicitly instead of searching build output. Runtime relocation does not add
a security boundary or change the zero-app-recompilation target for TypeScript iteration.

## Module Boundaries

Designed as deep modules: small interface, hides churn. Each one is independently testable.

The shared wire types (pairing, session, owned-media, retained-graphics, input, DOM-mirror, agent-feed shapes below) live in one local Swift package, `packages/AgentDeskWire`, imported by both apps, rather than hand-mirrored per project (ADR-0050). The package is the single source of truth for the wire contract; host and client diverging on a shared type is a compile error. Side-specific behavior types (host graphics pacing, client render/transport state) stay in their app targets.

### Host

1. **CaptureEngine.** Owns ScreenCaptureKit. Produces `CMSampleBuffer` frames for the current capture target, which is either the selected display or a single window (ADR-0094). A window target uses `SCContentFilter(desktopIndependentWindow:)` and sizes from the filter's own `contentRect` x `pointPixelScale`. Selecting one raises the window onto the active Space through `DockWindowFocusExecutor` (ADR-0055), because an off-Space window captures at full frame rate while its app has stopped drawing, and because global input events only land on the active Space. It is fully drivable, with the cursor clamped to the window's rect and the real pointer baked into the capture. After the raise it is resized through Accessibility so its captured pixels equal the client's `ClientConfig.videoViewport`, which is the largest remote text achievable with no resampling; the pre-fit frame is given back when the window stops being the target, and must be given back before the Mac leaves its Space, since Accessibility only reaches windows on the active one. In the hybrid worktree the same capture stream feeds HEVC full-frame refresh and the planned scroll delta engine. Target switches restart the capture stream and force the first post-switch frame to be a keyframe.
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
13. **RegionCrispController.** The sharp-text overlay on top of the video floor (ADR-0034), and since ADR-0102 the only thing entitled to un-crispen a tile, because only it has looked at the pixels. Over a fixed grid it promotes a tile that held the same content for the settle window to a crisp tile (`cacheTile`, or `drawCachedTile` on a content-cache hit) and reverts one whose re-hash proves it changed. `QuicSessionHostMediaTransport` drives it on its OWN window timer, not on the encode drain: capture damage is accumulated across every frame (`CrispDamageAccumulator`) so a window sees everything that changed since the last one, and the periodic full-surface heal (ADR-0036) fires on schedule even after ScreenCaptureKit stops producing frames on a settled screen. It does not own a separate network connection; it emits on the reliable graphics lane.
14. **InputChannelServer.** Owns the host side of the session input stream. Preserves each `InputChannelEvent` cursor revision through dispatch, acknowledges the applied revision only to its originating channel, and tags independently observed Mac cursor movement with that channel's last applied revision. It also pushes desktop state, thumbnails, cursor image updates, text-input focus metadata, agent speech events, diagnostics and screenshot requests, and bounded Agent raw-event fragments on the same serialized lane.
15. **SignalingChannel.** Supplies length-prefixed QUIC stream framing and role routing for the session control and input streams. It is not a WebSocket wrapper.
16. **HostPtyRuntimeProcess.** Reuses matching Rust `pty-vault` and `pty-manager` generations on the host variant's Application Support sockets or launches bundled candidates. A changed candidate performs the ADR-0072 private handover before the old generation exits. The vault spawns commands and retains the primary PTY masters. The manager leases duplicate masters and owns terminal state and policy. The host never terminates a changed runtime peer.
17. **TerminalClientBridge.** Bridges a dedicated `.terminal` QUIC stream to the `pty-manager` Unix socket as opaque length-prefixed PTY protobuf frames. It does not decode terminal protocol payloads; it only enforces stream role and frame bounds. Persistent full-screen and Workspace terminal clients remain trusted multiplexer clients with the existing session-management controls. AgentPanel does not use this bridge; its HTTP relay terminates at the sidecar terminal service.
18. **VideoFrameSource.** Concrete implementation `ScreenCaptureKitFrameSource` captures one stream for the current `CaptureTarget` and conforms to `TargetSelectableVideoFrameSource` (`selectCaptureTarget`, `setShowsCursorInVideo`, `setCaptureAvailabilityHandler`). A window target reports capture health through the availability handler, because a window that stops being capturable yields `SCFrameStatus.suspended` and then silence with no stream error at all. `TestPatternFrameSource` exists as a diagnostic source and is display-only.
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
27. **AgentPanel.** Reusable WebKit surface whose authored Vite project lives at `packages/AgentPanel/Web`. React owns one visible layer at a time: projects, sessions for one canonical project, or events for one source-scoped session. Navigation closes the deeper subscription and opens its parent; no project or session response cache survives leaving that screen. The same bundled surface uses capability-described sessions on macOS and iOS: every source renders the same shared composer band at the bottom, with the session's context-window occupancy meter below the action row (never in the header). Claude and Codex choose one composer transport in priority order: a Claude session's mirrored tmux pane composer, an available native window composer, then an already-open Agent Feed PTY; a terminal Claude session without a mirrored pane is never typed into through its messaging socket (ADR-0142). The fallback never opens a process implicitly. Pi sends through its harness; queue/steer/stop controls and supported extension prompts remain Pi capabilities. Every request crosses the authenticated Agent HTTP relay; JavaScript never receives sidecar authority. For a selected Claude or Codex session it also owns the resizable bottom pane, dynamically loaded xterm renderer, input encoding, output replay, viewport measurement, and safe bracketed-paste composer delivery (ADR-0075, ADR-0091, ADR-0108).
28. **AgentFeedTerminalService.** Sidecar authority for selected-session resume terminals (ADR-0108). It validates project/source/session context against the live catalog, derives `agent-resume-<source>-<session-id>`, constructs the fixed Claude or Codex argv, attaches to the PTY manager over its local Unix socket, rejects an agent active elsewhere, and exposes bounded authenticated HTTP/SSE resources. Swift does not restate or route its terminal protocol.
29. **WorkspaceTerminalCoordinator.** Host-only authority for persistent workspace shells (ADR-0061). It resolves an opaque workspace id through `WorkspaceStore`, validates a remembered running session against the workspace namespace and canonical root, otherwise selects the newest eligible session by immutable PTY creation time, and creates one login shell at the root only when none exists. macOS and iOS use the same host-generated `workspace-<workspace-id>-<suffix>` names; no workspace root crosses the wire.
30. **WorkspaceIDEStateCoordinator.** Persists revisioned ordered open paths and expanded directory paths per workspace, applies idempotent operations, and fans snapshots to local and remote subscribers. It never owns selected workspace, active tab, drafts, cursor positions, or pane geometry.
31. **WorkspaceObservationCoordinator.** Reference-counts one watcher per observed workspace, advances one change generation, reads Git status once for that generation, and fans the result to the existing shell and all IDE subscribers. Clean open files refresh; dirty files become conflicted without replacing their buffers.
32. **DesktopWindowPlacementCoordinator.** Host-only authority for exact Space observation, display-local ordinal repair, verified window movement, and frame restoration. IDE, Agents, and standalone Terminal registries each own UUID-keyed presentation descriptors and per-window runtime state, while the shared coordinator owns WindowServer truth. New `＋` windows appear on their issuing Desktop without activating the daily-driver menu-bar app; restart restoration reconstructs every descriptor without app activation, key-window changes, active-Space switching, or move-to-active-Space fallback (ADR-0092).
33. **DomBridgeServer.** Owns the `0600` Unix socket and token-authenticated native-messaging shim. It validates bounded complete browser snapshots separately from DOM batches and forwards validated projection metadata to local and authenticated remote viewers.
34. **BrowserProjectionSession.** Main-actor local state owner for one validated browser snapshot. It routes window, tab, tap, and scroll commands through `DomBridgeServer.sendToBridge`, admits page batches only for the projected window's active tab and generation, and feeds one AppKit `BrowserProjectionWindowController`.
35. **BrowserProjectionViewportCoordinator.** Host authority for active local and authenticated remote viewers. It caches each viewer's profile and dimensions, orders explicit claims, selects one owner, targets owner status, and sends only resolved epoch-and-revision source viewport commands to Chrome.
36. **BrowserProjection extension session.** Enumerates normal Chrome windows with tabs, groups, and bounded favicons; persists enabled state, stable window ordering, projected window, target document, recorder identity, and generation in `chrome.storage.session`; and owns one isolated recorder, one debugger attachment, and the desired source viewport.
37. **MissionControlTopologyObserver.** Registers current-macOS Dock accessibility entry notifications and legacy SkyLight event `1204` once, polls the unnamed layer-18 Dock window every 100 ms only while Mission Control is open, and reads one ordered user-Space topology on exit. Changed topology is reconciled through one `WorkspaceCoordinator` mutation. Space ID is the only assignment identity; absent IDs stay durable and unresolved rather than falling back to display and ordinal (ADR-0071).
38. **AgentFeedSidecar.** Loopback-only Bun service under `agent-feed/sidecar`. A provider registry presents one capability-described session contract: the transcript backend reads Claude/Codex state on demand, and the Pi backend directly owns official Pi SDK `AgentSessionRuntime` instances and their persisted JSONL. Existing directories canonicalized by `realpath` are project identity; slugs and Git origins never are. A per-spawn host capability authenticates every HTTP/SSE request, never enters either webview or the phone wire, and rotates on sidecar restart. Transcript indexing remains visibility-scoped; live Pi sessions retain only a bounded sequenced projection and replay window. The terminal service is a separate selected-session resource over the same relay and does not widen provider backend control (ADR-0075, ADR-0091, ADR-0108).

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
13. **InputChannel.** Reliable input lane inside the authenticated session QUIC connection. It stays logically independent from media even though both lanes share the same connection. Main-actor input sends are chained so cursor revision order is the order presented to the QUIC stream. It sends `ClientConfig.selectedDisplayId` when the user picks a display and sends client-owned media preferences (`crispTextOverlayEnabled`, `showHostCursorInVideo`, `mediaQuality`, and default-off `diagnosticScreenshotsEnabled`) on input-channel open and settings changes. `mediaQuality` carries adaptive on/off plus an optional fixed target. When adaptive is on, the host still owns target selection; when adaptive is off, the host pins the video bitrate/FPS/resolution to the fixed target while packet repair and backpressure stay active. The lane receives revisioned cursor application acknowledgements, independently observed Mac cursor movement, host text-input focus metadata, diagnostics and screenshot requests, and Agent raw-event responses. It reassembles only raw-event fragment envelopes before delivering one logical response to the shared webview.
14. **CursorReconciliationStateMachine.** UIKit-free owner of pending cursor operations and prediction confidence (`confirmed`, `awaitingHost`, or `ghost`). It ignores stale applied positions as visible corrections, rebases genuine Mac movement and replays only newer client operations, uses the oldest pending deadline, and bounds its pending window. `PairingViewController` owns only transport/lifecycle wiring and the displayed cursor point.
15. **ClientDiagnosticsStore.** Bounded durable client diagnostics store in `Application Support/Diagnostics`. It persists structured NDJSON essentials for the current run plus two prior runs, rotates unclean exits on bootstrap, mirrors essentials to OSLog, summarizes delayed MetricKit payloads, and serves prior-run tails on demand over the input lane or the foreground tailnet control listener.
16. **ClientScreenshotCapturer.** Main-actor, memory-only capture authority for the visible foreground AgentDesk window. It rechecks the default-off setting for each request, composites UIKit hierarchy output with visible WebKit snapshots, declares omitted system and live-video layers, encodes one bounded JPEG, and exposes only a manifest plus ordered chunks. It rate-limits requests and posts an accessible on-screen disclosure after a successful capture.
17. **TerminalSurface.** Thin UIKit host for `PtyTerminalWebView` in workspace mode. The shared runtime owns bounded tabs, recursive splits, pane chrome, the session drawer, xterm rendering, selection, and terminal-key encoding. Its remote backend opens one authenticated `.terminal` stream per pane, creates only fixed persistent login-shell sessions, and preserves close-client and close-session authority. On iOS the standalone surface reuses the native `KeyboardSurface` as a non-echoing first responder, including its accessory row, while the web runtime remains the PTY input encoder. UIKit owns visibility, keyboard-safe sizing, explicit dismissal, and safe-area lifecycle.
18. **WorkspaceTransport.** Opens the authenticated `.files` workspace lane, correlates file and Git responses, serializes subscriptions and shared-state operations, and delivers unsolicited IDE-state and change pushes. It cancels pending work and subscriptions when the session ends.
19. **WorkspaceWorkbenchSurface.** UIKit composition selected from the Workspace control. Its resizable left sidebar owns workspace and directory navigation; its upper-right editor owns the existing shared WebKit file viewer/editor; its lower-right pane hosts `PtyTerminalWebView` in single-session mode for the selected workspace. The sidebar and terminal start visible, the editor starts empty, and pane geometry persists per workspace. Collapse and resize retain both webviews. The file SPA owns content-aware zoom: text, Markdown, and notebooks scale their typography, while DOCX retains responsive fit-width, page scaling, and pinch zoom. Text saves carry the last observed file revision and surface conflicts instead of overwriting host changes.
20. **AgentFeedSurface.** Thin UIKit host for one AgentPanel webview. The panel owns its resizable terminal pane and xterm renderer, and reaches the sidecar terminal resource through the same authenticated Agent HTTP relay as the rest of the feed. UIKit supplies only WebKit lifecycle and safe-area geometry; it does not render terminal cells, attach a `.terminal` stream, construct a harness command, or restate the terminal wire.
21. **WorkspaceIDEController.** Cross-platform package coordinator owning retained sidebar and editor WKWebViews, strict intent decoding, serialized data-source calls, request-generation fencing, device-local active state and drafts, 700 ms autosave, and tailored projections. Platform containers receive terminal and layout intents through a delegate.
22. **WorkspaceIDESurface.** Separate UIKit entry that composes the retained sidebar webview beside an editor webview and `PtyTerminalWebView` in single-session mode. The terminal starts open and reattaches through the existing workspace-terminal coordinator. Its active tab and pane geometry remain local while shared editor-tab membership and expanded folders reconcile from host pushes.

Tests required for v0: **Pairing, InputDispatcher, GestureTranslator, SpacesProvider, SpacesDotsView.** Additional owned-media contract tests pin wire shapes, packet repair, and decoder recovery behavior where regressions are expensive.

## Live Agent Session Flow

ADR-0091 makes the host-side agent sidecar the only owner of directly controlled agent runtimes.
The webview sends correlated create, message, abort, and extension-UI responses to its native shell;
macOS calls the authenticated loopback sidecar and iOS carries the same request over the existing
authenticated session to that host bridge. Neither webview connects to loopback HTTP directly.

The sidecar exposes provider-neutral `AgentBackend` operations for discovery, pagination,
subscription, and optional control. A stable activity id, ordering index, revision, and
`streaming|complete` phase let one logical message or tool result replace itself while it streams.
Each live session projection carries a monotonic sequence, a 256-mutation replay window, run and
queue state, and bounded snapshots for gap recovery. Claude and Codex synthesize complete revision-0
events from their transcripts, each named by the byte its line starts at (ADR-0124); Pi maps SDK events into the same AgentDesk block vocabulary.
Pi SDK objects and extension payloads never cross HTTP, Swift, QUIC, or React boundaries.

Pi runtimes use the pinned official SDK and its existing agent directory, authentication, settings,
models, built-in tools, JSONL `SessionManager`, and extension loader. A runtime survives viewer
disconnects while active or queued and is disposed after ten idle minutes with no subscribers;
disposing never deletes JSONL. Commands serialize per session and use a bounded idempotency ledger.
Normal input prompts while idle and queues a follow-up while busy; explicit steer uses Pi steering;
abort ends only the active run. Tool-capable extensions work directly. Standard select, confirm,
input, editor, and notification requests are projected to all viewers with first-valid-response-wins
resolution after response-kind validation. Invalid answers leave the shared prompt pending; accepting,
timing out, or disposing it publishes a dismissal to every viewer. A valid answer arriving after another
viewer won receives a bounded no-op acknowledgement rather than surfacing a false error. Terminal-only
custom UI returns an explicit unsupported result instead of hanging.

The provider-backend flow does not create or attach a PTY, choose arbitrary workspaces, install
extensions, or expose a public browser server. The selected-session Agent Feed terminal below is a
separate sidecar resource and does not turn Claude or Codex into controlled provider backends.

## Agent Panel Terminal Flow

ADR-0108 supersedes the native Agent Panel composition from ADR-0056. The checked-in PTY pair speaks
protocol v7 under ADR-0068. The Agent Feed uses HTTP resources relayed over the existing authenticated
Agent lane, so this change adds no Swift terminal contract and does not bump the AgentDesk session
protocol.

1. The selected Claude or Codex thread mounts `AgentTerminalPane` in the AgentPanel main column. It
   sends only project path, provider source, canonical harness session UUID, and initial viewport.
   It cannot choose an executable, arguments, or PTY name.
2. The sidecar validates that the catalog contains the exact provider session and canonical project
   directory beneath the user's home. It derives `agent-resume-<source>-<session-id>` and constructs
   `claude --resume <id>` or `codex resume <id>` as a fixed executable and argv array through login zsh.
3. The sidecar speaks the existing local protobuf PTY-manager protocol over its Unix socket. It
   attaches the deterministic running PTY or creates it when absent. If the catalog says the harness
   is live elsewhere and no deterministic PTY exists, open fails instead of launching a competitor.
4. The panel opens the terminal over authenticated Agent HTTP: `POST /api/terminals` creates one
   sidecar attachment, an SSE resource carries checkpoint, output, viewport, exit, and error events,
   and bounded POST resources carry input, viewport, detach, or kill. The bearer token remains in the
   host relay and never enters the page.
5. AgentPanel dynamically loads the checked-in xterm.js package. React owns bottom-pane layout,
   pointer and keyboard resizing, xterm focus/input, checkpoint replay, output, theme, and local
   viewport measurement. The pane is a child of the main column, so it cannot cover Sessions/Bots.
6. Closing, changing context, losing the renderer, or terminating the sidecar detaches. Detach never
   kills the process; an unattached session continues until natural exit or an explicit kill, and a
   later open attaches the same deterministic PTY and receives a fresh checkpoint (ADR-0078).

Platform ownership remains explicit:

| Owner | Responsibility |
| --- | --- |
| AgentPanel TypeScript | Feed and terminal presentation, xterm input/output, pane layout, viewport measurement, and Agent HTTP calls. |
| macOS AppKit adapter | WebKit lifecycle and authenticated loopback relay only. |
| iOS UIKit adapter | WebKit lifecycle, safe-area geometry, and authenticated remote relay only. |
| Agent Feed sidecar | Context validation, catalog correlation, deterministic identity, command construction, HTTP/SSE resources, and PTY-manager attachment. |
| Rust `pty-vault` | PTY launch, primary descriptor custody, process identity, exact exit observation, signal, close, and vault handover. |
| Rust `pty-manager` | Descriptor leases, headless terminal state, bounded replay, client leases, viewport ownership, manager handover, and session policy. A session is removed only when its process exits or someone kills it explicitly (ADR-0078). |

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
                    protocolVersion, minCompatibleProtocolVersion }   // current target: pv must be >= 16
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

The Agent feed lane carries no feed-shaped frames. It relays HTTP: the panel names a path, the
host attaches the sidecar's control token and copies bytes back, and neither side knows a field
name. The per-endpoint watch/unwatch/push frames this section used to specify were retired with
the bridge that owned them -- a field renamed on one side and restated on the other was the whole
class of bug the relay removes.

```
AgentFeedRelayRequest { t: "agent-http-req", rid, method, path, body?, stream }
AgentFeedRelayCancel  { t: "agent-http-cancel", rid }
AgentFeedRelayHead    { t: "agent-http-head", rid, status }
AgentFeedRelayChunk   { t: "agent-http-chunk", rid, seq, data, complete }
AgentFeedRelayEnd     { t: "agent-http-end", rid }
AgentFeedRelayError   { t: "agent-http-err", rid, reason }
```

Subscriptions and one-shot requests are admitted against separate concurrency budgets, because a
subscription is idle for its whole life and a request is a body being copied.

The sidecar resources a surface reaches through it are:

```
GET /api/inventory/stream?projectPath=<canonical-path>&projectPath=<canonical-path>
GET /api/sessions?projectPath=<canonical-path>
GET /api/sessions/:source/:sessionId/events
GET /api/sessions/:source/:sessionId/events/:eventIndex/raw
GET /api/sessions/:source/:sessionId/timeline?mode=
POST /api/terminals
GET  /api/terminals/:terminalId/stream
POST /api/terminals/:terminalId/input
POST /api/terminals/:terminalId/viewport
POST /api/terminals/:terminalId/close
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

Each side rejects with `incompatible-protocol` when the peer's advertised `protocolVersion` is below its own `minCompatibleProtocolVersion`. Protocol v8 is required because the Files role changed from JSON text-only bodies to binary property-list bodies with native document bytes. Protocol v9 is required because cursor inputs now carry revisions and cursor feedback has distinct applied and host-moved frames. Protocol v10 is required because the iOS workbench coordinates a host-authorized workspace terminal on the input lane. Protocol v11 is required because the Files stream becomes the workspace lane and adds IDE state, Git status, and unsolicited workspace-change messages. Protocol v12 is required because the DOM stream carries full Chrome metadata and bidirectional window/tab selection. Protocol v13 adds authenticated viewer activity, ownership, profile, and source dimensions to that DOM contract. Protocol v14 adds explicit-opt-in, bounded client screenshot request and response frames to the input lane and signed foreground fallback. Protocol v15 removes the eager Agent feed digest, keys thread and raw-event traffic by source plus session ID, and replaces screen-independent pushes with subscription-scoped project and project-session snapshots. Protocol v16 adds capability-described sources, mutable sequenced timeline events, correlated live-agent commands, and extension UI request and dismissal fan-out. Older builds parse only far enough to be rejected. Matching marketing versions across host and client is not a compatibility signal; the protocol version is.

Terminal PTY frames travel over the reliable ordered `.terminal` stream as opaque PTY protobuf envelopes from AgentDesk's `terminal/pty-client-swift` and `terminal/pty-manager` pair (moved in-tree under ADR-0053). Both checked-in implementations enforce inner protocol v7. Protocol v4 added explicit launch and lifetime semantics; protocol v5 added immutable session creation time; protocol v6 added authoritative dimensions, revisions, and bounded chunked ANSI checkpoints; protocol v7 replaces manual resizing with authenticated-client viewer participation, ownership, and targeted viewport status. The private vault and handover protocols are local implementation details from ADR-0072 and do not change this client wire. There is no compatibility path for older inner protocols:

```
Terminal stream body = UInt32BE ptyFrameLength || Envelope {
  protocol_version: 7,
  session_name,
  payload: CreateOrAttach {
    createIfMissing,
    launch: ShellLaunch | CommandLaunch { executable, arguments: [String] }
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
  sessionName, startedAtUnixMilliseconds, columns, rows, revision,
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

For Workspace and standalone terminals, `PtyTerminalWebView` is the native renderer coordinator. Its private nonpersistent WKWebView loads only
bundled resources through `agentdesk-terminal://`; CSP disables network access. The versioned internal
bridge validates message tags, terminal identifiers, dimensions, revisions, links, and input sizes.
Native-to-web writes are serialized and bounded to 1 MiB of live output per terminal and 32 MiB per
WKWebView. Overflow, JavaScript failure, navigation failure, or WebKit process termination pauses the
affected renderer, reloads the runtime, and resumes only from a complete replacement checkpoint.

`PtyTerminalWorkspaceState` is authoritative for a maximum of 16 tabs and 16 total panes. JavaScript
renders immutable snapshots and emits intents. Full macOS and iOS Terminal surfaces use workspace
mode; context-bound Workspace terminals use single-session mode with management controls absent.
Hidden panes release viewport participation. Selecting or interacting with a pane claims using
its measured capacity, while passive follower layout remains presentation-only.

The outer `QuicStreamFrame` identifies the stream role for Workspace and standalone terminals. The inner
PTY frame is owned by the Rust manager and Swift PTY client; AgentDesk's host bridge does not
reinterpret create/attach, viewer-state, viewport-status, input, output, detach, kill, close-client,
subscribe, or session-list messages. `ShellLaunch` preserves the existing login-interactive shell
behavior. `CommandLaunch` executes the supplied executable with its argument array directly through
Rust `CommandBuilder`; argument boundaries survive protobuf decoding and no shell command string is
assembled by `pty-manager`. Sessions carry no lifetime distinction: every one lives while its process
lives (ADR-0078).

Full-screen and Workspace terminals retain the authenticated paired client's existing multiplexer
authority: they can list sessions, join with `createIfMissing=false`, detach a manager-assigned client
id, or kill a session. AgentPanel instead reaches a narrower sidecar resource through the Agent HTTP
relay. Its wire is provider-neutral HTTP rather than native terminal messages:

```
AgentTerminalContext { projectPath, source: "claude" | "codex", sessionId }

POST /api/terminals
  { context, columns, rows }
  -> { terminalId, ptySessionName, pid, columns, rows }

GET /api/terminals/:terminalId/stream
  -> SSE checkpointBegin | checkpointChunk | checkpointEnd | output | viewport | exited | detached | error

POST /api/terminals/:terminalId/input    { data, encoding: "utf8" | "base64" }
POST /api/terminals/:terminalId/viewport { sequence, active, claim, columns, rows }
POST /api/terminals/:terminalId/close     { mode: "detach" | "kill" }
```

The sidecar, not the page, resolves deterministic PTY identity and fixed argv. Each `terminalId` is an
ephemeral sidecar attachment capability behind the already authenticated relay; changing session
context unmounts the pane and detaches it. Full normalized context fences stale React state after
navigation or replacement. Since the relay already crosses the current Agent lane, this resource
adds no native message and requires no outer protocol bump.

## Host-owned shared voice flow

The Gesture/Voice InteractionPanel uses one browser protocol for both capture sources:
`sessionStart`, sequenced 2,048-sample mono Float32 `audioFrame` messages, and a fenced
`sessionStop`. Every audio frame declares its sequence, sample count, and sample rate. Stop declares
the final accepted sequence and total captured sample count. The Python authority compares those
client fences with the decoded stream before marking a recording complete; a gap, duplicate,
truncated frame, or mismatched Stop fence preserves the nonempty WAV as interrupted with durable
transport-audit metadata rather than presenting incomplete audio as a successful take. The macOS bundle
opens the loopback Python WebSocket directly with source `macos`. The iOS bundle posts the same
messages through `__interactionDeliver` and native Swift, which opens authenticated stream role
`.voice = 7`. A `voice-lane-v2` hello/ready exchange gates the lane independently from outer protocol
`15`; every handshake failure before ready becomes the bounded update-host error.

FastAPI lifespan schedules one silent in-memory inference for the configured final Whisper model
through the same process-wide MLX executor used by live, final, and REST transcription (ADR-0082).
It concurrently schedules one direct-IPA Kokoro inference through the retained reference-speech
store (ADR-0083, refined by ADR-0084). Kokoro prewarm and cache misses share one synthesis lock, so
loading and real inference cannot race; cache validation and hits use an independent short lock and
remain available while the model warms. Warmup audio is discarded without entering the durable
artifact cache. The HTTP server remains live while both prewarms run. Both models remain resident
for the sidecar process lifetime. `mlxPrewarm` records import, model resolution, inference,
residency, and MLX memory fields; `kokoroPrewarm` records cold work, success, error type, and total
time. R172 and R174 retain later measured idle-eviction or on-demand reload policies if lifetime
residency harms ordinary host use.

The full Voice recorder enumerates browser `audioinput` devices and stores one device-local
preference in Web storage. System default stores no device ID; an explicit input becomes an exact
`deviceId` constraint for the shared browser capture hook, so the same preference also applies to
the compact Dictation Bar. Device labels refresh after microphone access and on `devicechange`.
When a persisted input disappears, the recorder visibly returns to system default rather than
silently retaining an unusable constraint.

Browser Stop first fences the capture worklet, emits its final short PCM tail, and waits for the
flush acknowledgement before sending `sessionStop`. Worklet, track, and audio-context failures abort
the take visibly. Direct WebSockets enforce a bounded buffered-byte ceiling. On iPhone, native bridge
messages enter one ordered chain and the role-7 writer uses one bounded FIFO, so concurrent WebKit
callbacks cannot reorder PCM frames or overtake Stop. The host reports the proxied socket open only
after the loopback Python WebSocket confirms its handshake.

The macOS all-Spaces Dictation Bar is a second, compact `dictation.html` entry in the same
InteractionPanel bundle. It mounts only browser microphone capture and the shared voice-session
state machine. Swift owns the nonactivating all-Spaces window, saved placement, SpaceAgent avoidance,
Fn/Globe start/stop delivery after web readiness, microphone permission restricted to
`interactionfeed://app`, and one final `InputDispatcher.typeText` per recording ID. The mini shows
capture, saving, transcription, and phone-analysis state until `sessionComplete`; only its saved
nonempty transcript is inserted. There is no Swift PCM/WAV/transcription fallback. The top-bar Voice
command opens the existing full panel on Voice and refreshes the same recording library, but is
disabled while the mini owns the global sidecar recording.

The iPhone Control surface splits the keyboard control with a Dictate button. It presents the same
`dictation.html` entry as a sheet, but injects the native voice transport and client-review mode. The
sheet records through role-7, shows final host transcript in an editable field, and waits for an
explicit Send. An optional recording prefix is composed with the reviewed text only for that send.
Send converts the outbound text to the same bounded `NormalizedInput.key` sequence as the soft
keyboard, preserving the focused Mac target and `InputDispatcher` path. It refuses an unsupported
keyboard character before any input frame is sent. This is a UI adapter over the shared host recorder,
never an iOS PCM/transcription fallback.

The lane carries typed socket open/message/close envelopes and correlated allowlisted Voice REST
requests. JSON is limited to 192 KiB and complete lane frames to 256 KiB. Recording audio playback
responses are split into 96 KiB chunks with per-request sequence and final markers. REST work may run
concurrently with the socket so list polling or WAV playback cannot stop the lane from receiving PCM.
The host forces source `iphone`, accepts only recording, practice-passage, and reference-speech paths
with validated IDs and bounded list queries, and proxies to the loopback sidecar; it never stores or
analyzes voice in Swift. The input lane never carries PCM.

## Systemwide keyboard dictation

The `AgentDeskKeyboard` extension is a native UIKit en-US keyboard. It owns alphabet, number, and
symbol layouts, Shift/Caps Lock, delete repeat, cursor movement on Space, Return presentation, and
the next-keyboard control. Ordinary characters go directly to `UITextDocumentProxy`; they never
enter App Group files or an AgentDesk network lane. The existing video-path `KeyboardSurface`
remains an independent Apple-keyboard adapter for Mac input events.

The `KeyboardDictation` Swift package owns a versioned cross-process contract. App-owned service
snapshots and extension-owned single-flight commands/preferences use separate atomic JSON files
under the shared App Group, with Darwin notifications as wakeups. Each command is fenced by a
service generation and acknowledged by command ID. The extension verifies liveness with correlated
pings rather than trusting persisted active state. Completed results are deduplicated by host
recording ID and expire after 24 hours.

Automatic mode inserts a final transcript only while the same keyboard controller remains active
and its bounded before/after/selection fingerprint is unchanged. Any mismatch opens Explicit
Review instead. Review uses a native expandable draft editor and routes the extension's own keys
to its selected range. Insert and Dismiss consume the recording ID exactly once; edits never change
the host recording.

The containing app owns the only microphone. Activating Keyboard Dictation requires microphone
permission and a reachable paired Mac, configures `AVAudioSession.playAndRecord` with
`mixWithOthers`, and keeps one `AVAudioEngine` plus role-7 voice lane alive. Idle tap buffers return
before conversion and are discarded. During a take, audio is resampled to 16 kHz mono Float32,
framed in ordered 2,048-sample messages, and sent through a bounded 32-frame actor queue. Stop
halts acceptance immediately, flushes the accepted sequence fence, then sends `sessionStop`.
Conversion or queue overflow fails visibly and closes the take rather than dropping audio.

Ordinary app backgrounding retains the existing one-second teardown. While the explicit keyboard
lease is armed, UI/media consumers suspend but the authenticated session, voice lane, and audio
engine survive. Turn Off, permission loss, audio interruption, unrecoverable host loss, and service
failure close the engine and lease. The host appends the role-7 recording-session UUID as
`clientSessionID` to the loopback WebSocket. Python persists it in recording metadata and exposes
one allowlisted exact lookup, so an interrupted take can reconcile after the app restarts without
timestamp matching.

Current Apple App Review guideline 4.4.1 requires useful keyboard operation without Full Access and
a next-keyboard control, and says keyboard extensions may not launch apps other than Settings. The
native keyboard satisfies the typing requirements without Full Access, but its containing-app Link
is restricted to this repository's one-device internal TestFlight posture. It is not represented as
public-App-Store-safe without an Apple-approved exception or a later design. See ADR-0081.

Python permits one active capture globally. Stop and transport loss both persist nonempty PCM as a
host WAV, atomically create metadata, run full-file MLX Whisper, and run the pinned ZIPA ONNX
recognizer against the same WAV. Transcript and phone failures are independent persisted stages and
never delete the audio. Empty disconnects are discarded; an empty explicit Stop returns a terminal
error. Reanalysis reads the retained WAV and updates only phone-analysis metadata. The ONNX session is
hash-verified, cached for the sidecar lifetime, and inference is serialized. The fullscreen native
Voice/Passage surface remains a separate on-device experiment and is not a fallback for this flow.
The host-owned library is passage-first (ADR-0085). A practice passage owns one opaque ID, normalized
human-approved intended text, revision, timestamps, and optional baseline attempt. An attempt owns
one immutable WAV, the original Whisper machine transcript, flat ZIPA phone sequence, model
provenance, and transport audit. Legacy recording schema upgrades once to schema 4: each recording
gets a deterministic one-attempt passage whose intended text and machine transcript start from the
old transcript. New free-form recordings seed intended text from Whisper for explicit review;
retakes carry the selected passage ID and revision. A user may instead create a passage directly
from normalized intended text with no recording, baseline, or latest-attempt timestamp. Creation
persists only passage metadata and never invokes the microphone, Whisper, ZIPA, or Kokoro.

Passage and attempt lists use cursor-bounded pages. Intended-text and baseline updates require the
expected passage revision. While a retake is active, intended-text edits and whole-passage deletion
for that passage fail with a conflict. Attempt deletion removes the WAV and attempt metadata while
retaining an explicit empty passage; deleting the passage removes all owned attempts. The global
content-addressed Kokoro cache remains rebuildable cache rather than passage truth.

Recording responses derive word-oriented heard/reference groups from current intended text, the
attempt's unchanged ZIPA phone sequence, the pinned CMUdict revision, and the shared
ARPABET-to-model-phone mapping. Unanchored phones remain explicit. These groups are presentation
alignment, not acoustic word boundaries, and are not a second persisted analysis authority. The
shared web panel shows editable intended text, immutable **Machine heard**, an accessible word diff,
learner/reference playback, collapsible attempts, baseline selection, and unscored A/B playback.
Technical model, dictionary, timing, and transport details stay under secondary disclosure.
The recorder's Reset control remains present outside active finalization. It clears ephemeral
capture state and any passage selected as the next recording target, returning to **New passage**;
it never deletes the host-owned passage or attempt history.

An expanded passage asks Python for revision-fenced reference-pronunciation data independently of
attempt retrieval. The response carries current reference words, display phones, unknown words, and
pinned dictionary provenance. It is derived rather than persisted, so a zero-attempt passage can
show the same reference evidence without fabricating a silent `Recording`. Kokoro artifacts remain
lazy and are created only after an explicit playback action.

Whole-passage and per-word speaker actions ask Python for one host-owned reference-speech artifact by
passage ID, current revision, and scope. Python resolves the current intended text and rejects stale
revisions so an old word index cannot synthesize a different word after an edit. It maps the same
pinned CMUdict entry shown in the phone comparison to Kokoro-compatible IPA, validates every symbol
against the pinned model vocabulary, and passes IPA directly to Kokoro. Kokoro's
text-to-pronunciation frontend is not constructed and there is no native TTS fallback. An unknown
dictionary word fails visibly instead of synthesizing an inferred pronunciation.

Kokoro `hexgrad/Kokoro-82M` is pinned by immutable revision with SHA-256 manifests for the model,
config, and every selectable American-English voice. Model loading and synthesis share one
serialization boundary; background startup prewarm normally pays the first load, while a failed
prewarm leaves the first real request able to retry. Python writes 24 kHz mono PCM WAV artifacts
atomically under the host recording store and verifies the cached WAV hash before reuse. Cache
identity covers text, IPA, voice identifier and hash, speed, model identifier and hash, CMUdict
identifier and hash, synthesis-mapping hash, and sample rate. A configurable 256 MiB LRU bound
applies to generated WAV and metadata pairs. Startup and post-write maintenance remove unmanaged
files and incomplete pairs. An artifact larger than the whole bound fails visibly without remaining
on disk. Active audio responses lease their pair against eviction, then reapply the bound when
delivery finishes.

macOS plays the artifact from the loopback audio endpoint. iOS requests the same endpoint through the
authenticated voice lane, reassembles bounded ordered REST chunks, verifies the completed bytes
against the artifact's SHA-256, writes a temporary WAV, and plays it with `AVAudioPlayer`; Stop,
completion, decode failure, navigation, and transport teardown remove the temporary file and release
the audio session. Reference audio uses the voice lane rather than the input lane. The shared web UI
persists only a device-local Kokoro voice identifier and speed, so Mac and iPhone choices remain
independent while both devices play byte-identical host artifacts for an identical cache key. The
native Agent Say voice catalog and preferences remain separate.

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
   without treating unrelated shells or Agent Panel terminals as candidates.

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

1. Each AppKit IDE window and the UIKit IDE surface creates its own `WorkspaceIDEController`, which retains
   a sidebar WKWebView and editor WKWebView. Both load the same bundled application with an immutable
   region bootstrap. Web code emits typed intents only; that native controller is the sole owner of its
   window's presentation state.
2. Selecting a workspace is window-local on macOS and device-local on iPhone. The controller subscribes through its data source, restores
   local pane and active-tab state, receives the host's ordered open paths and expanded directories,
   and projects tailored immutable snapshots to both webviews in one serialized delivery turn.
3. Opening, closing, reordering, expanding, or collapsing submits an idempotent operation against the
   last shared-state revision. A resulting host snapshot pushes to every subscriber. A remote close
   leaves a dirty local tab protected until its draft is saved or its conflict is resolved.
4. Text edits persist to a window-local macOS or device-local iPhone draft store and replace a 700 ms autosave debounce. Writes carry
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
                      selectedDisplayId?, selectedWindowId?,
                      windowListEnabled, crispTextOverlayEnabled?,
                      showHostCursorInVideo?, mediaQuality?,
                      diagnosticScreenshotsEnabled }
ClientMediaQuality  { adaptiveEnabled, fixedTarget? }
ClientQualityTarget { bitrateKbps, fps, resolutionScale }
                                                                        // t: "client-config"
WindowSummary       { id, spaceId?, appName, title, iconHash }
WindowAppIcon       { hash, png }                       // base64, sent once per client
WindowList          { windows, icons }                                 // t: "window-list"
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

## First-party WebView desktop control

The Web desktop viewer uses one ordered WebRTC data channel named `agentdesk-control-v2` for pointer
movement, clicks, scroll, key batches, correlated focus queries, cursor feedback, delivery results,
and controller ownership. Its native source metadata advertises `desktopControlVersion: 2`; a mismatch
disables control with an explicit error while leaving the video track viewable. Messages are bounded
to 16 KiB, key batches to 256 events, sequences to positive 32-bit integers per channel, and focus
correlation to UUIDs. The closed key set is ANSI A-Z, 0-9, reviewed US punctuation, and the declared
control/navigation keys. There is no pointer-v1 fallback or second keyboard transport (ADR-0109).

AgentPanel TypeScript owns the keyboard state machine (`unavailable`, `hidden`, `pending`, `shown`),
the hidden 16 px textarea, DOM `beforeinput`/composition/paste/physical-key capture, ANSI conversion,
sticky modifiers, Auto preference, secure metadata, pending input, acknowledged receipts, accessory
chrome, visual-viewport placement, dismissal, and telemetry. A confirmed pointer tap primes only when
the mirrored remote cursor is `ibeam` or `unknown`; any other shape sends the click with no focus
correlation, so the helper never probes and the keyboard is never raised to be withdrawn. A prime
focuses the textarea synchronously, replaces any prior pending request, and waits at most 700 ms for
its correlated focus result. The Keyboard button is an explicit request and ignores the cursor gate.
Pending input is capped at 32 normalized events and is discarded on replacement,
timeout, rejection, channel close, revocation, or reconnect. Paste, dictation insertion, and composition
commit are prevalidated atomically. The last 64 acknowledged events form a non-editable receipt;
secure printable events become bullets and plaintext is not retained.

The accessory also shows an immediate, bounded local typing echo, separate from the acknowledged
receipt and delivery status. Backspace removes a local character and Return clears that local line;
neither action dismisses the keyboard. Secure or not-yet-classified targets use bullets. The capture
textarea retains a non-user sentinel so WebKit emits deletion even when the echo is empty. Native
`beforeinput` is bound directly, rather than React's text-only polyfill. The capture and accessory
are portaled to the document body so a blurred or clipped viewer toolbar cannot trap fixed positioning.
Viewport dismissal compares with the pre-keyboard height, not a concurrently shrinking layout viewport.

The video box ends at the accessory's top edge rather than running full height beneath it. That edge
is one measured number, the accessory's observed height plus its own offset from the layout viewport's
bottom, which covers the keyboard too because the accessory is drawn on top of it: the offset is zero
when the WKWebView's layout viewport has already shrunk to the keyboard-free area and the keyboard's
height when it has not, so the visible band is the same either way. The accessory's height is
measured, never assumed, because its bottom padding follows the safe area until the software
keyboard owns it.

Shortening the box alone would only move the problem: `object-contain` re-centres the picture in the
strip that is left, so the desktop shrinks and floats in black bars. While the keyboard occludes the
box the viewport instead covers it, scaling until both axes are filled and translating so the remote
cursor sits at the strip's centre, clamped so no content edge pulls inside the viewport. The view
held before the keyboard is restored when it leaves, because the cover is the viewer's decision and
not the user's. The viewport observes its own frame rather than the window, which never sees a box
the page shortened itself, and re-clamps the pan on every other resize, since a shorter box narrows
the legal pan range.
The keyboard chrome uses a 32 px echo field and one 36 px key rail with an inverted-T arrow cluster.
Auto and Hide sit in the echo line; acknowledged event history stays screen-reader-accessible without
a second visible receipt row. The software keyboard already owns the bottom safe area, so the web
accessory does not add that inset again. WebKit's native form toolbar is outside this page's authority:
the iOS desktop container opts out through `WKWebView.inputAccessoryView`, leaving the software keyboard
intact and the TypeScript rail as its only accessory. Other panels retain the system toolbar. This
shell change needs one client update; later keyboard behavior and chrome remain TypeScript-owned.

The sidecar validates and forwards canonical NDJSON, but does not translate key names or own keyboard
behavior. The latest intentional interaction acquires one Mac-wide ownership epoch, resets native
pointer state, and revokes the prior page. Frame kind 4 is the control-event frame and carries cursor,
focus, delivery, navigation, and native rejection events. Only cursor image, position, and the latest
display/Space snapshot are replayable to a new
channel. Key input, focus state, receipts, ownership, and pending events never replay.

### Web Desktop and monitor navigation

The same ordered control-v2 channel carries `desktop-refresh`, exact-ID `space-select`, and
UUID-correlated `space-gesture` phases. Source metadata advertises `desktopNavigationVersion: 1`
and its stable `displayId`. Events report a revisioned `desktop-state` with each display's own
active Space, explicit unavailability, or a correlated posted/rejected result. Posting is not
settlement: the page waits for the target Space to become active, ignoring intermediate transitions,
and reports a bounded timeout. IDs remain UInt64 decimal strings, never JavaScript numbers (ADR-0112).

The compact TypeScript rail uses 40 by 30 px numbered pills in a 36 px expanded row, a 26 px collapsed
row, and an optional 32 px monitor row. Raw travel over half the rail or an agreeing flick above
800 points/sec commits; a short reverse flick cancels. Default finger-left selects next; the
TypeScript-owned Mac-direction toggle reverses swipes, never target taps. Explicit cancellation uses
Dock phase 8, not a zero-distance end. Two fingers, pointer-capture loss, blur, hidden page, ownership
loss, and topology changes retire the gesture. The rail hides while typing and reserves scroll-puck
clearance without changing video zoom. There are no thumbnails or window picker.

Navigation, its status messages, input-mode controls, and stream metadata form one bottom dock in
normal vertical flow. Safe-area padding belongs to that dock once. A ResizeObserver measures the
complete dock for scroll-puck clearance, including monitor rows and wrapped messages; navigation does
not guess a fixed offset above an independently positioned toolbar. Keyboard capture/accessory
portals remain outside the dock and video clipping.

The sidecar resolves main/explicit monitor aliases before encoder reuse. The helper captures exactly
that physical display and emits matching logical input bounds. A monitor handover keeps the old
image with input blocked, warms one candidate generation, and replaces the old source only after
the matching first presented frame. Stale candidate callbacks are ignored. Reconnect remains pinned
to that display. Unplug rehomes to the remaining main monitor with an explicit notice, including
when capture dies before sending a final topology event. Ordinary Desktop changes keep the stream,
pointer mode, and zoom. The standalone helper uses OS notifications, plus Mission-Control-scoped
exit checks; there is no idle topology polling. A changed monitor origin or extent retires its
capture so reconnection obtains fresh input bounds. Live acceptance reopens only the WebRTC stream after
the helper build, with neither app rebuilt or relaunched.

The standalone grid helper is the native capability boundary. It owns AX trust and focused-element
classification, I-beam sampling after an 80 ms probe plus an optional 160 ms settle, stable key-code
lookup, direct modifier flags, serial `CGEvent` key-down/key-up posting, pointer/scroll injection, and
explicit applied or rejected results. Accessibility denial rejects immediately and never falls through
to a cursor heuristic. Probe delays arrive through the bounded control channel so later tuning remains
TypeScript-only. Rebuilding this helper and reopening a stream does not rebuild or relaunch either app.

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
- Capture resolution is fixed for the session and is not an adaptation axis (ADR-0100): a scale change recreates the compression session and destroys its long-term references, so the quality controller never moves it. The client remains a single surface and input coordinates stay in host logical space.
- Frame ACKs are the host-side admission fence and latency signal. Normal cadence allows two unacknowledged frames, behind cadence allows one, and draining cadence allows none until ACKs clear or the drain timeout reopens latest-frame admission. The host derives ACK age from its own sent-frame timestamps; the client does not report frame age because peer monotonic clocks are not comparable.
- If a behind or draining frame stays unacknowledged past the stale-unacked deadline, the host abandons it for admission accounting and holds encode admission while the raw capture mailbox keeps coalescing. This prevents one late lifecycle ACK from freezing capture admission. Stale admission recovery is counted as quality pressure but does not force a keyframe by itself.
- Explicit keyframe requests are counted as quality pressure and deferred while draining. Periodic keyframes are suppressed while behind or draining, and a second keyframe is blocked while a prior keyframe is unacknowledged.
- The adaptive quality controller owns one target `{ bitrateKbps, fps, resolutionScale, reason }` with **one controlled axis**: `bitrateKbps`, continuous between a heartbeat floor (60 kbps, ~one frame per second) and the ceiling (2500 kbps). `fps` is derived from it through the measured delta-frame wire cost, so a target always carries a cadence its bitrate can actually deliver; `resolutionScale` never moves (ADR-0100). ADR-0101 replaced the fixed rung ladder, which could represent neither a link between two rungs nor anything below its bottom rung.
- Descent triggers, in order (ADR-0098): client-reported link stall, stale admission recovery, measured goodput shortfall, round-trip inflation over an absolute floor, loss, host freeze, queue-plus-cadence, cadence. Stale, shortfall, bloat, and cadence each require consecutive windows; a stall and a freeze act on one. A confirmed descent lands at `min(target × downStep, deliveredBytesPerSecond × snapRatio)`, so one move reaches the link's measured rate; with no measurement only the multiplicative step applies. High ACK age alone still holds rather than descends.
- Recovery is one multiplicative step toward the ceiling per streak of clean or idle link-time windows, with the derived cadence rising with it. There is no fps probe: a derived fps rises only after bitrate has earned its climb, and any overreach is corrected by the next descent snapping to measurement.
- The client accepts a new video resolution only at a keyframe; a delta at unexpected dimensions is dropped and triggers bounded keyframe recovery. With resolution out of adaptation, this path is reached only by a display change or a manual client-pinned scale.
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
- PTY lifetime is independent of the QUIC session state and of client presence. A session lives as
  long as its process; workspace and Agent Panel PTYs are alike in this (ADR-0078). There is no timed
  reap: the last client detaching, however that happens, leaves the session running, and reattaching
  later preserves the PTY/PID and replays a checkpoint.
- Exactly two things end a session. Its process exits, and `pty-manager` removes its PTY, clients, and
  registry state. Or someone explicitly kills it through a surface with that authority, such as the
  terminal session drawer or the Agent terminal close resource's `kill` mode.
- Everything else detaches: closing the Agent terminal pane, changing thread context, an unexpected
  renderer failure, terminal socket loss, transport loss, a failed attach, iOS backgrounding or
  switching away from Agent, unpairing, and host termination. None of these is a decision about the
  process, so none may end it.
- Manager handover transfers sessions without applying shutdown policy.

## Risks Tracked Outside This Doc

- Private CoreGraphics API drift between macOS versions. Mitigation: `SpacesProvider` is the only consumer.
- HEVC decode on older iPhones. v0 targets the author's device only.
- Tailscale outage. No fallback in v0.

## Cross-References

- Product intent: `PRD.md`
- Operating rules: `AGENTS.md`
- ADRs: `architecture-decisions/`
- Execution: `TASKS.md` when a ledger is open, otherwise the retired ones under `tasks/archive/`
- What is live vs dormant in the tree: `FEATURE-MAP.md`
