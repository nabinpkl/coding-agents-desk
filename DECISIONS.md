# DECISIONS

Load-bearing decisions made by an agent while implementing work, where the choice was not fully
dictated by the prompt or an existing ADR. Each entry states the decision, the evidence behind it, and
why it was made independent of any instruction. Architectural decisions that lock a contract still get
a full ADR under `architecture-decisions/`; this file captures the smaller judgement calls that would
otherwise be invisible.

## Zoomed pan-follow edge return

### D1. Suppress full cursorSet while any pan-follow axis is rubber-banding

During a zoomed viewport pan, `UIScrollView` can be overscrolled on one axis while still moving normally
on the other. The existing wire has only full absolute `cursorSet(x,y)` and relative `cursorMove(dx,dy)`;
there is no axis-partial absolute reconcile. Sending a `cursorSet` during one-axis rubber-band therefore
reasserts the overscrolled axis with a stale/clamped value, exactly when the relative edge-push path is
trying to move that same axis away from the edge. The reducer now treats any overscrolled axis as making
absolute reconcile unsafe for the whole pointer for that frame. It emits only edge gesture frames while
rubber-banding, clears the last-sent absolute dedupe point, and sends the next interior `cursorSet` once
the viewport returns to the scrollable range. This was chosen because it preserves one source of truth per
frame and prevents the absolute and relative cursor paths from fighting across the left-edge return seam.

## DOM mirror default-on (reverted once on a confound, then restored)

### D1. Browser mode is default-on; the pairing failures were network, not DOM

Both enable gates default-on (host `Config.domMirrorEnabled`, client `SettingsStore.domMirrorEnabled`);
the dead per-recipe `AGENTDESK_DOM_MIRROR_ENABLED=1` injection in `host-run`/`host-run-dev` was removed
(the code default is the single source now). This was briefly **reverted** mid-debug on the belief that the
`.dom` lane broke device pairing (a fresh pair failed at the QUIC handshake with `-9858` / POSIX 50
ENETDOWN). That conclusion was **wrong -- a confound**. The `-9858` is literally "network is down": it was
a **transient tailnet path instability** during a no-WiFi / flaky-network window, and it self-heals once the
path is healthy. The bisection that seemed to implicate DOM (a0f5a44/DOM-off worked, HEAD/DOM-on failed) had
the network changing underneath it -- DOM-off happened to be tested on a good path, DOM-on on a bad one. On
a healthy path, **DOM-on pairs reliably** (verified on-device: 4/4 fresh pairs `session ready` +
`media state=connected` with `AGENTDESK_DOM_MIRROR_ENABLED=1`). So the default was **restored to on**.
Lessons: (1) `-9858`/ENETDOWN is a transport-path symptom, not an app-layer one -- suspect the network
first; (2) never bisect a feature flag while the network is also changing; (3) the iOS sim dials over
localhost, so a sim pass proves the code but says nothing about the tailnet path. The real, still-open
issue is that transient tailnet ENETDOWN does not always recover during connection setup on a flaky path;
that is a transport-robustness matter, independent of DOM.

### D2. The native-messaging bridge is wired on every host launch, not by a separate manual step

`just dom-bridge-reinstall {{variant}}` is now called at the end of `host-run` and `host-run-dev`, so
every host bring-up (dev or stable, sim or physical, since every composite launches through these) wires
the Chrome native-messaging manifest for that variant's host socket. Previously only the sim/verify
composites did this and the mainline/physical composites did not, so a normal run left the Browser
surface white until someone remembered `just dom-bridge-install`. The call is non-fatal (`|| echo WARN`):
a host run must not hard-block on Chrome/node config, but it warns loudly rather than failing silently.
What remains genuinely manual is loading the unpacked extension in Chrome and hitting record on a tab;
those are Chrome UI actions the host cannot perform.

## ADR-0049 List all tailnet iOS devices with pre-arm

### D1. Pre-arm is keyed by tailnet IPv4, not a stable node id

The pre-arm record and its readiness poll key on the peer's tailnet IPv4 rather than parsing Tailscale's
StableNodeID out of the status JSON. Evidence: a Tailscale node's IPv4 is stable for the node's lifetime,
and IPv4 is already the address every other leg of pairing dials (the whois probe in
`TailnetIdentityProber`, the offer push in `PairingOfferSender`). Keying on IPv4 keeps one identifier
across discover -> poll -> push instead of introducing a second id that would then need mapping back to an
IPv4 to dial. Chosen independent of the prompt because the prompt did not specify a key; IPv4 is the
single-source-of-truth address already in hand.

### D2. Readiness is discovered by polling the offer port, not by a push-and-wait

A pre-armed (closed-app) device is polled with the existing whois probe on `Config.preArmPollInterval`
until it answers, and only then is the offer pushed. The alternative (push the offer immediately on pick
and let the 30s dial-back timeout retry) was rejected because it pushes into a closed listener and burns
the 90s nonce TTL before the app is even open. Polling first means the nonce is minted at push time
against a confirmed-listening client, so the existing ADR-0019 nonce/pre-approval flow runs unchanged.

### D3. The pre-arm intent is persisted, and resumed at host launch

`pre-armed-targets.json` lives beside `paired-devices.json` in Application Support, and
`applicationDidFinishLaunching` calls `resumePreArms()` to restart polls for still-live intents and prune
expired ones. Evidence for persisting rather than keeping it in memory: the Mac host is a long-running
menu-bar agent, but a crash or relaunch between "user picks a closed-app phone" and "user opens the app"
would otherwise silently drop the intent, which is exactly the multi-minute window the feature exists to
cover. TTL-bounded so a never-opened device does not poll forever.

### D4. New picker row type `PairablePeer` instead of overloading `TailnetDeviceOption`

`TailnetDeviceOption` stays the raw tailnet peer (name, os, ipv4, online); the picker draws a separate
`PairablePeer` (resolved display name + `ready`). Rationale: the raw peer has no notion of AgentDesk
readiness, and folding a `ready` flag plus a resolved-name rule into it would give one struct two
responsibilities and two producers (the pure parser, which cannot know readiness, and the enricher, which
does). Keeping them separate makes the enrichment a pure, unit-tested function (`PairablePeer.rows`).

## ADR-0047 Browser scroll-drive-back / pinch-zoom / mobile-emulation (Phases 1-3)

### D1. Autonomous simulator + CDP-Chrome verification was run without the per-run device checkpoint

AGENTS.md makes any host/client install, launch, or sim drive a STOP-and-wait checkpoint. For this
work the user explicitly and durably authorized autonomous driving of "cdp enabled debug chrome where
extension will be installed by you autonomously and autonomously driving the sim scroll etc". That
standing authorization overrides the per-run checkpoint for the throwaway Chrome-for-Testing profiles
and the local simulator only. The PHYSICAL iPhone (`dom-mirror-device-run`) stays a human checkpoint,
because the daily-driver device protection is not what the authorization was about.

### D2. The scroll sign convention passes the finger delta straight to CDP (no negation)

The plan sketched `Input.synthesizeScrollGesture` with `yDistance: -dy`. That is wrong. Empirically
(the `dom-mirror-scroll-verify` gate, run against the live extension) a POSITIVE `yDistance` scrolls the
content toward the TOP (window.scrollY decreases); negative scrolls down. So to make the mirrored
content follow the finger (finger drags down -> content moves down -> scrollY decreases), the phone's
finger delta (positive dy = finger down) is passed straight through: `yDistance = dy`, `xDistance = dx`.
The gate confirms it end-to-end: finger-up scrolls the page down (scrollY 0 -> 600), finger-down scrolls
back up (600 -> 0). This is documented inline in `chrome-extension/worker.js` `dispatchScroll` and in
both `DomScrollCommand` twins so the three boundaries agree.

### D3. Two deterministic autonomous gates were added instead of relying only on the physical run

The DOM-mirror scroll path previously would have been verifiable only at the physical `dom-mirror-device-run`
checkpoint. To make the work self-verifying (and to regression-guard the D2 sign bug and a sub-threshold
tap/scroll bug found in review), two headless gates were added, both modeled on the existing
`dom-mirror-input-verify` pattern:
- `dom-mirror-scroll-verify` (`chrome-test/scroll-verify.mjs`): the worker/CDP WRITE path. A fake host
  sends `dom-scroll` through the shim to the real extension, which drives a real Chrome tab; the harness
  reads `window.scrollY` to confirm direction. This is where D2 was ground-truthed.
- `dom-mirror-scroll-gesture-verify` (`chrome-test/scroll-gesture-verify.mjs`): the client gesture state
  machine. Loads the shipping `index.html`, gives it a surface via a CDP keyframe, dispatches synthetic
  TouchEvents, and asserts the threshold deadzone, tap-vs-scroll suppression, and multi-touch
  deactivation. This is the half no other test covers.

### D4. While pinch-zoomed, a single-finger drag pans locally and does NOT drive the host scroll

The plan's Phase-2 verify wording expected a scroll drag to still drive the host while zoomed. Both my
own analysis and the independent Phase-2 review concluded that is a defect, not a feature: once
`scrollView.zoomScale > 1`, UIScrollView intrinsically re-enables panning of the magnified content, and
the JS `touchmove` host-scroll handler fires from the SAME one-finger drag, so a user panning their
magnified view would also scroll the real Chrome tab (a two-input collision, provable from code without
a device). The resolution: `DomMirrorSurface.handleScroll` gates the host-scroll on `zoomScale <= 1.01`,
so the model is "navigate the page at 1x, inspect locally when zoomed." The gate lives on the Swift side
because `scrollView.zoomScale` is the authoritative zoom state; JS `visualViewport` tracking of WKWebView
pinch is unreliable and cannot be trusted for a correctness gate. This aligns with ADR-0047 (pinch-zoom +
pan are local view transforms) more cleanly than the plan's original wording did. The exact felt quality
of the 1x-vs-zoomed handoff is still worth a physical-device confirmation, but the collision itself is
resolved in code.

### D5. Emulation is resnapshot-based (no reload); metrics + touch are the real lever, UA is secondary

`setDeviceEmulation` applies the CDP overrides and then asks the recorder to `takeFullSnapshot(true)`
rather than reloading the tab. Consequence: the UA override mostly affects live UA client hints, because
the page's own UA-sniffing JS already ran under the desktop UA and is not re-run without a reload. What
actually re-triggers the responsive layout is `setDeviceMetricsOverride({mobile:true})` +
`setTouchEmulationEnabled`, which re-evaluate the page's media queries live. Not reloading is the right
call for a mirror: a reload would lose page state (scroll position, form input, SPA route) that the user
is looking at. The UA override is still applied (cheap, helps client-hints-aware sites) via
`Emulation.setUserAgentOverride`, with the pristine UA captured on first emulate and restored on desktop
since CDP has no UA-clear.

### D6. Emulated state is always sent on the wire (Bool), decode-tolerant as optional

The extension stamps `em` on every batch and the relay always encodes a concrete `emulated: Bool` into
`dom-status` (never nil), so the client's toggle has an unambiguous authoritative value every update. The
field is typed `Bool?` on both twins only for decode-tolerance (a frame that predates the field reads as
nil -> desktop); the client maps `?? false`. The relay resets `emulated` to desktop when the extension
disconnects, since the state is no longer known. This is the "always send the real value, tolerate its
absence" shape, consistent with the existing optional `tab`.

### D7. The Desktop|Mobile control index is driven only by the authoritative echo, never optimistically

`UISegmentedControl.selectedSegmentIndex` is set only in `setBridgeStatus` (the host echo), never in the
1s periodic `renderStatus`. A tap sends `dom-emulate` and lets the control's own momentary selection
stand until the resnapshot echo (~one flush) confirms or corrects it. This prevents both a periodic-timer
flicker-back between tap and echo and a permanently-wrong control if a toggle is ever dropped host-side.

### D8. Known single-tab-v1 limitation (documented, not fixed)

`deviceEmulationEnabled`/`originalUserAgent` are single global worker state, matching the single-tab-v1
assumption throughout the extension (`recordingTabId` is also a single global). If a user starts
recording a second tab without stopping the first while the first is still emulated, the first tab's live
CDP override is not eagerly cleared (it self-heals when that tab is re-recorded). This is out of scope for
single-tab v1 and is left as-is deliberately; multi-tab recording would revisit it.

### D9. Client .dom-lane sends must be serialized (bug found on device, missed by the headless gates)

Physical-device testing surfaced a real bug the autonomous gates could not: scroll did nothing and the
host logged `dom lane receive ended: malformed`. Root cause was in `DomMirrorClient`: each tap/scroll/
emulate command was sent as its own unstructured `Task { await stream.send(...) }`. A tap is one-off
(so tap-back, ADR-0040, always worked), but scroll fires up to once per animation frame, so many
concurrent sends interleaved their bytes on the single bidirectional QUIC stream; the host then read a
corrupted frame header, threw `malformed`, and its receive loop ended, killing the whole client->host
reverse channel on the first scroll. The fix serializes all `.dom` sends through a chain (each awaits
the prior), mirroring the host's own `DomEventLaneServer` send chain. The lesson: the headless CDP gates
validate the worker/host/JS logic in isolation but do not exercise the client's real QUIC transport, so
a physical (or full sim) run remains necessary to catch client-transport concurrency bugs. A device pass
should be part of accepting any client reverse-channel feature, not optional.

## Workspace shell: share only the data model, port the donor shell faithfully (ADR-0054)

### D10. The reusable shape shared between iOS and macOS is the data+files model, not navigation

Exploring both repos showed the iOS `WorkspaceFilesBrowserModel` already builds entirely on
`AgentDeskWire`'s workspace/file DTOs, and the host's file navigation is a separate tree. Rather than
unify the two navigation models (an earlier draft's plan), the shared surface is scoped to the
workspace + files *data* model: one home per data type. macOS keeps the donor's recursive `NSOutlineView`
tree and iOS keeps its drill-down list, each rendering the same data. This preserves each platform's
expected UX and avoids collapsing macOS down to the iOS single-directory list. The `WorkspaceKit`
package is the home for shared file-domain types that are not wire DTOs (added as consumers need them,
to avoid dead code); today the wire package already carries the shared data, so `WorkspaceKit` is a
skeleton pending its first non-wire tenant. Chosen because it is the minimum single-source that removes
real duplication without forcing a navigation rewrite the user explicitly did not want.

### D11. The reveal pointer source is a CGEvent session tap, not NSEvent monitors

The shell's sidebar and top bar are floating, all-Spaces panels that auto-hide and reveal on an edge
hover. Hidden all-Spaces panels still have an owning Space, and AppKit `NSEvent` global monitors miss
pointer movement on Desktops the app does not own, so an `NSEvent`-driven reveal would not fire after a
Space switch. The port therefore uses the donor's listen-only `.cgSessionEventTap` on a dedicated
thread, which sees pointer motion across every Space. This needs Input Monitoring; when the grant is
absent the shell degrades to pinned, visible bars (and prompts) rather than the donor's silent no-op,
so the shell is never a dead, unreachable surface. An earlier plan to reuse SpaceAgent's `NSEvent`
monitor pattern was rejected once the donor's own comment documented this exact failure mode.

### D12. SpaceAgent re-parks below the workspace top bar via a versioned-origin bump

SpaceAgent parks top-center; the new full-width top bar occupies the same band, and where two floating
all-Spaces panels overlap the front one swallows the press. The default park moves ~52pt below the top
edge (clear of the revealed top bar) when the shell is enabled, and its persisted-origin key is bumped
v2 -> v3 so the stale top-center origin is dropped on first launch after the change rather than pinning
the panel to its old spot. No migration of the old value (consistent with the project's no-migration
convention); a user who had dragged SpaceAgent re-drags once.

## Faithful donor shell port (ADR-0054 Phase F)

### D13. A leaner WorkspaceShellSession, not a verbatim WorkspaceSession port

The donor's `WorkspaceSession` is ~500 lines mostly about terminals, borrowed-Chrome/debug browsers,
tenant state machines, and AX window placement — all explicitly out of scope for AgentDesk. Rather than
port it verbatim and stub a dozen subsystems, `WorkspaceShellSession` reproduces only the in-scope
mechanics: file-opens-in-a-centered-window, per-workspace tabs + editor frame, and workspace=desktop.
It reuses the donor's actual views (`FilePane`, `FileTree`, `FileViewer`) unchanged. Chosen because the
user's ask was "move the UIs, share the data model, mechanisms may differ by your judgement": the views
are moved faithfully; the orchestration is AgentDesk's, sized to what it actually needs.

### D14. workspace=desktop drives SpacesProvider (delta + direct-set), not the donor's SkyLight code

The donor switched Spaces by synthesizing Dock-swipe CGEvents and polling SkyLight because it had no
Spaces provider. AgentDesk already owns `SpacesProvider` with a verified direct space-set, so
`WorkspaceDesktopSwitcher` computes the ordinal delta from the active Desktop to the workspace's
assigned one and reuses `SpacesProvider.commitStep`. The editor window carries `.moveToActiveSpace` so
it follows to the workspace's Desktop on reveal, avoiding the donor's private `SLSMoveWindowsToManagedSpace`
window-move entirely. Less private-API surface, and it reuses the host's already-tested Space control.

### D15. The web editor viewer ships as a macOS-only package resource, not a host buildable-folder file

The host's Xcode buildable folder flattens resource subdirectories, so the vendored `viewer/` SPA
landed as 206 loose files in `Resources/` and `FileViewer` could not find `viewer/index.html`. The SPA
moved into a `WorkspaceEditorViewer` package that bundles it with a `.copy` resource (preserving the
`viewer/` tree, like AgentPanel's webview) and is linked host-only, so the 5MB bundle never ships in the
iOS client. `FileViewer` resolves `Bundle.module`. Notebook cell execution was excised (out of scope);
`.ipynb` still renders read-only through the SPA. (The host-only linking was reversed in D16.)

### D16. The file viewer is one cross-platform surface; iOS renders files through the same SPA (Phase G)

iOS Files rendered file text in a raw `UITextView`, so markdown/mermaid/code showed as plain source on
the phone while the macOS shell rendered them through the vendored SPA. The fix is one viewer, not two:
`WorkspaceEditorViewer` became cross-platform (macOS 26 + iOS 26, one target), the WKWebView host was
extracted into a shared `WorkspaceFileWebSurface` (a `window.fileSurface` `render(payload)` contract
plus a ready-queue state machine, iOS/macOS split only on background/opacity and `openExternal`), and
the iOS surface drives it with a stringly-typed `WorkspaceFilePayload` (kind/mode as strings, avoiding
host-enum coupling). Both platforms now render identically; only the surrounding chrome differs. This
reverses D15's host-only linking — the 5MB bundle now ships in the iOS client too, the deliberate cost
of one viewer instead of a diverging second one.

Editability had to survive the switch: the `UITextView` was editable for every kind, so rendering
through the SPA would have made markdown/HTML view-only and left HTML a read-only source dump (the SPA
renders HTML only as source, not a live page — on macOS a live page is a *separate* `htmlPreviewSurface`
that iOS does not port). So the iOS preview header carries the macOS `FileViewer` modeButton mechanic: a
Preview/Edit toggle that flips the file's mode and re-renders through the same SPA. Markdown and
notebooks open rendered; everything else — including HTML — opens as editable source, never a dead end;
the toggle carries in-progress edits across the flip. iOS HTML *page* rendering (macOS's separate
surface) is explicitly out of scope: on iOS, HTML is editable source, not a rendered page.

### D17. The shell top bar owns the terminal, on our own pty socket (Phase H)

The donor top bar had two terminal controls the port skipped: "＋ Terminal" (an in-app SwiftTerm window
attached to a pty-manager session) and "PTY Manager" (a session list). AgentDesk already ran the Rust
`pty-manager` daemon on its own bundle-scoped socket and shipped `terminal/pty-client-swift`, but the
host never spoke the protocol in-process (only the iPhone did, relayed over QUIC), and the only terminal
UX was a floating pill toggling *external Ghostty*. Phase H makes the shell top bar the single terminal
entry point, all on our socket (`Config.ptyManagerSocketURL`, via `PtyManagerSocketClient` — never the
donor's `/tmp` default).

Three judgment calls (HITL):
- **In-app SwiftTerm, not external.** The donor's `terminal/emulator` window layer was brought in-tree as
  a **library package kept at swift-tools 5.9**, so it builds in Swift 5 language mode — the proven donor
  code ports without a strict-concurrency rewrite. `WorkspaceShellSession.openTerminal()` spawns a titled
  terminal window rooted at the active workspace. The windows are ordinary Space-bound windows, so with
  workspace=desktop macOS Spaces shows/hides them per workspace — no donor-style park/unpark machinery.
- **Embedded PTY Manager, not a sidecar process.** The donor launched a separate `pty-manager-ui` app;
  a menubar app should not ship a second binary, so `PtyManagerWindowController` re-hosts the session list
  as an in-host `NSOutlineView` driven by our own `PtyClient.sessionSnapshots()` stream.
- **Ghostty pill retired.** The external-terminal pill was a redundant, inconsistent second entry point;
  removed, with its space-negotiation avoid wiring reconciled.

Linking cost: `pty-client-swift` (and thus SwiftTerm + swift-protobuf) is now compiled into the host.
Buildable folders mean any host source importing `TerminalEmulator` forces the *test* target to link it
too, so both host targets link the terminal products.

## Dock enrichment ported over a single SkyLight source (ADR-0055)

- **Reopened one ADR-0054 boundary.** ADR-0054 left dock enrichment and desktop auditing behind; ADR-0055
  ports the bottom "desktop pills" strip and revises reveal surfaces back to `{ sidebar, topBar,
  dockEnrichment }`. ADR-0054's other decisions stand.
- **One SkyLight binding, extended by one symbol.** Rather than porting the donor's parallel
  `SkyLightDesktopBinding`, the host's existing `SpacesProvider` binding gains
  `SLSCopySpacesForWindows` (optional) and a `nonisolated skyLightDesktopAuditSnapshot()` (SkyLight +
  `CGWindowList`, no `NSScreen`, off-main safe). One private-API surface, one canary; degrades to
  ungrouped if the symbol ever disappears.
- **Pills labelled by workspace, not Desktop ordinal.** The off-main reader stays workspace-agnostic
  ("Desktop N" base); the panel overlays the assigned workspace name on the main thread via an injected
  provider. Agent-desk is workspace=desktop, and the group model already carried a `label` field.
- **Known overlaps, accepted for now:** the strip duplicates SpaceAgent's Desktop overview in a
  different shape, and its full-width bottom placement can transiently overlap the bottom-center
  dictation bar. Both surfaces auto-hide; revisit if they feel redundant in use.

## Dock desktop-content swaps use a transactional yabai adapter (ADR-0059)

- **Space identity stays authoritative.** The Dock hands stable Space IDs to the action layer. Volatile
  Desktop indices are resolved from yabai immediately before a transaction and never become UI state.
- **Window movement is all-or-rollback.** Both eligible sets are captured before the first move, every
  result is verified, and a partial failure reverses completed moves. Undo touches only captured windows
  still at the destination established by that swap, so later user movement remains authoritative.
- **SkyLight remains read-only at this boundary.** `SpacesProvider` continues to own enumeration and
  window membership. The configured yabai executable is one isolated host adapter for mutation; the UI
  neither parses JSON nor invokes a shell.

## Shared responsive Workspace IDE (ADR-0062)

- **Two webviews, one native presentation owner.** The sidebar and editor need independent rectangular
  regions around a native lower-right terminal, so one WKWebView cannot own the full layout. One
  `WorkspaceIDEController` therefore owns both webviews and projects a single typed state snapshot into
  them. The views never synchronize with each other through browser storage.
- **Shared navigation membership, local point of view.** Ordered open paths and expanded directory paths
  are host-persisted and live across Mac and iPhone. Selected workspace, active tab, sidebar section,
  pane sizes and visibility, drafts, and cursor positions stay device-local so navigation on one device
  cannot move the other device's Desktop or editor focus.
- **Native geometry and authority.** AppKit and UIKit own both split dividers, focus, keyboard avoidance,
  and native SwiftTerm. The host remains the only filesystem, Git, observation, revision, and PTY authority.
- **Autosave is symmetric and conflict-explicit.** Both platforms persist drafts locally and use one
  700 ms debounce. Revision failure pauses autosave. Use Host discards the draft; Keep Mine reads the
  latest revision before explicitly retrying the retained buffer.
- **Protocol v11 generalizes the Files stream.** The stream becomes a typed workspace lane carrying the
  existing native binary file codec plus shared IDE state, Git status, and change pushes. The existing
  101 MiB Files frame bound remains, DOCX is not base64 encoded, and there is no v10 compatibility path.
