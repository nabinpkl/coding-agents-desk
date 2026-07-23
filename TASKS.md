# TASKS: v7 multi-window Chrome projection (with v8 terminal durability captured)

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from the archived v6 ledger through D83.

## Position

This iteration makes the macOS Browser Projection model the whole local Chrome hierarchy while keeping
one recorder and one selected page. The extension session and generation contract land first because
the host cannot safely render nested metadata until delayed prior-page batches are distinguishable at
their source. The validated native session and shared renderer follow. Autonomous live verification is
last because it launches the dev host and visible test-owned Chrome and therefore remains behind the
repository launch checkpoint.

ADR-0064 supersedes the original local-only boundary: the authenticated QUIC DOM lane now seeds and
updates the same nested BrowserProjection shell on iOS, carries selection commands back to the host,
and requires protocol version 12. ADR-0065 adds viewer-owned responsive source sizing over protocol 13
without changing the one-recorder and extension-authoritative generation model.

## v7 Phase 0: local projection decision

- [x] D84. Accept ADR-0063 and update `PRD.md` and `SPEC.md` with the nested local browser hierarchy,
  focus versus projection semantics, one-recorder generation model, local-only metadata boundary, and
  explicit Chrome-management non-goals.

## v7 Phase 1: authoritative extension session

- [x] D85. Replace the focused-tab recorder state in `chrome-extension/worker.js` with a restorable
  multi-window session backed by `chrome-extension/browser-session.js`; enumerate normal windows,
  ordered tabs, groups, and bounded favicons; validate window/tab selection; pass generation into the
  isolated recorder; and test ordering, focus, navigation, restriction, restoration fields, and stale
  command or batch rejection.

## v7 Phase 2: validated local host projection

- [x] D86. Add bounded multi-window state types to `packages/BrowserProjection`, render nested ARIA
  window and tab strips with read-only toolbar/status states, and route validated state plus matching
  page batches through a host-only `BrowserProjectionSession`. Keep `browser-state` out of
  `DomMirrorRelay`; retain selected-page tap, scroll, and existing iOS page-only delivery. Tests pin
  decoding, metadata text safety, AX identifiers, atomic replacement, filtering, and command routing.

## v7 Phase 3: autonomous verification seam

- [x] D87. Add `just browser-projection-verify` and `just browser-projection-e2e`; preflight TCC without
  prompting, build the exact dev host without personal Chrome bridge installation, load the exact
  extension into a temporary visible Chrome-for-Testing profile, drive stable AX identifiers, capture
  window-only screenshots and machine-readable transitions, reuse tap/scroll gates, and clean every
  test-owned process and profile. Pure, renderer, real-extension, focused-host, and repository checks
  must pass before the launch checkpoint.

## v7 Phase 4: live acceptance checkpoint

- [x] D88. After explicit user approval, run `just browser-projection-e2e` and verify two normal Chrome
  windows, complete nested tabs and group metadata, projection-only outer switching, unfocused inner
  tab activation, direct Chrome focus/tab following, restricted-page clearing, strictly advancing
  generations, stale-batch rejection, matching host/extension SHAs, six screenshots, result JSON, and
  complete cleanup without touching the stable host or personal Chrome profile.
- [x] D88.1. Replace blanket rrweb/CDP redaction with readable ordinary page content while retaining
  source-side masking for static and incremental password values; verify the real compressed stream,
  closed-shadow CDP reconstruction, and payload-free diagnostic logging contract.
- [x] D88.2. Supersede the page-only iOS boundary with ADR-0064; seed the remote DOM lane with validated
  host and browser metadata, render the exact shared nested shell on iOS, return window/tab selection
  on the serialized DOM stream, and raise the host/client session protocol to 12.
- [x] D88.3. Disable rrweb's implicit `.rr-mask` text-class redaction so all ordinary text is visible
  by default while static and incremental password values remain source-masked; release extension 0.8.1.
- [x] D88.4. Supersede the fixed iOS emulation toggle with ADR-0065; add host-arbitrated last-activated
  viewer ownership, Desktop and Mobile presets, viewer-linked and custom source dimensions, shared
  projection-only fit/zoom/pan, generation-fenced CDP application and native restoration, protocol 13,
  extension 0.9.0, and local/remote ownership tests.
- [x] D88.5. Make workspace-shell top and left edge reveal monitor-aware: retain one authoritative
  interactive overlay, move it to the display under the pointer, derive reveal geometry for every
  connected display, and retain the bottom Dock surface's existing main-display ownership.
---

## v8 terminal workspace

- [x] D89. Promote terminal tabs, recursive splits, pane chrome, and the session drawer into one
  bounded `PtyTerminalWebView` workspace shared by macOS and iOS (ADR-0069).
- [x] D90. Add bounded Rust-owned PTY replay: protocol-6 chunked checkpoints and revisions, one
  Alacritty-backed logical grid per session, bounded fan-out/resynchronization, shared renderer fit
  and explicit sizing, metadata-only standalone macOS window restoration, and automated tests
  (ADR-0066).

## Terminal stability hotfix

- [x] D91. Prevent pre-layout terminal attachments from creating unusable 1x2 PTYs: centralize the
  80x24 bootstrap dimensions, measure laid-out terminal surfaces atomically, and send an authoritative
  resize immediately after every renderer bind so existing sessions recover on reattachment.
  ADR-0066 supersedes bind-time resizing; 80x24 remains the creation fallback.
- [x] D92. Remove the standalone terminal window minimum and make shared macOS/iOS terminal views
  full-fit down to 75 percent, then clip and follow the parser cursor without focus or PTY resize
  (ADR-0067).
- [x] D93. Replace explicit shared terminal sizing with protocol-7 last-activated viewer ownership:
  sequence-fenced viewer reports, targeted ownership status, owner-only debounced capacity changes,
  input-before-write claims, shared AppKit/UIKit participation, focus-free restoration, and visible
  two-client ownership verification (ADR-0068).
- [x] D94. Replace every SwiftTerm consumer with the production WKWebView and xterm runtime, add the
  user-input provenance fork, bounded bridge recovery, shared workspace coordinator, one-session
  adapters, metadata-schema migration, deterministic web build, and compile-only host/iOS gates
  (ADR-0069).

## Client visual diagnostics

- [x] D95. Add explicit-opt-in, foreground-only paired-client screenshot capture over protocol 14;
  authenticate the session and signed offer-port paths, bound and verify manifests plus JPEG chunks,
  keep client pixels memory-only, write private host temporary artifacts, disclose successful sharing
  in the client UI, and add screenshot-only and combined debug-bundle recipes (ADR-0070).

## Mission Control topology reconciliation

- [x] D96. Add process-lifetime yabai-style Mission Control entry sources (Dock accessibility on
  current macOS and SkyLight event `1204` for the legacy path) with 100 ms exit checks only while
  Mission Control is open; reconcile surviving workspace assignments atomically by exact Space ID,
  retain missing assignments as unresolved, remove ordinal identity fallback, and refresh workspace
  and Dock presentation after topology edits (ADR-0071).

## Workspace/Desktop selection reconciliation

- [x] D97. Clear the active workspace when the user enters an unassigned Desktop instead of retaining
  the workspace selected on the previous Desktop; persist the empty selection and cover the
  coordinator path with a regression test.

## Exact Workspace/Desktop activation

- [ ] R98. Replace active-display-relative workspace switching with a target-display Dock gesture:
  read that display's `Current Space`, compute its exact assignment delta, and locate the synthesized
  swipe on that display; verification is pending the user-run host relaunch.

## Workspace IDE terminal viewport recovery

- [ ] R99. Make the shared web terminal fill its stage, rebind resize observation whenever pane DOM
  is replaced, publish viewport authority only after two matching laid-out measurements, and reject
  one-row native and manager claims so transient WKWebView geometry cannot resize the shared PTY.

## PTY Manager bulk controls

- [ ] R100. Add multi-row selection plus Select All and confirmed Close All controls to the embedded
  PTY Manager, closing each top-level session exactly once through the existing daemon lifecycle API.

## Centralized PTY live handover

Position: split kernel PTY custody from terminal policy. One bundle-variant-scoped `pty-vault` process
will hold the primary master descriptor for every live session while the restartable `pty-manager`
leases those descriptors and continues to own readers, writers, the headless parser, bounded replay,
clients, viewport authority, and lifecycle policy. The two processes deliberately hold duplicate
descriptors while a manager is active, so updating or losing either one alone never closes the final
master descriptor. Stable and dev hosts retain completely separate sockets, processes, and session
tables.

An authorized host relaunch must update the host, manager, and vault independently. A changed manager
performs a stateful manager-to-manager handover; a changed vault transfers its listener, complete
session manifest, and every primary descriptor to a candidate vault. Each transfer is all-or-nothing:
the old generation stays authoritative and keeps its descriptors until the candidate validates the
complete manifest and acknowledges readiness. No update path may use `pkill` or close both descriptor
holders. Explicit terminal close remains the only normal path that signals the process group and closes
the final master.

The live-update acceptance invariant is stronger than child-process survival: after changing host,
manager, or vault code and performing the authorized relaunch, each existing session keeps the same
session identity, child PID/process group, visible TUI state, revision, input path, resize behavior, and
exit notification. Client connections may reconnect at the generation boundary, but the reconstructed
checkpoint must not become a new shell or a blank terminal. A simultaneous vault-and-manager crash is
outside this guarantee because macOS has no remaining process in which the master descriptor can live.

### Phase 0: decision and Darwin capability gates

- [ ] R101. Draft and explicitly accept ADR-0072 before implementation. Record the common-vault choice,
  dual descriptor custody, manager-owned terminal semantics, sequential component updates, atomic
  rollback behavior, exact-exit-status contract, stable/dev isolation, and the simultaneous-holder-loss
  boundary. Leave accepted ADR-0066 immutable; cross-reference it from ADR-0072 and update `SPEC.md`
  only after the superseding decision is accepted.
- [ ] R102. Add a Darwin-only integration harness that opens a real PTY, runs a continuously changing
  TUI marker, transfers the master and listening Unix-socket descriptors with `SCM_RIGHTS`, exits the
  original owner, and proves the same child PID, process group, screen marker, input, resize, EOF, and
  cleanup survive in the replacement. Exercise `EVFILT_PROC` with `NOTE_EXIT` and `NOTE_EXITSTATUS`
  after parent replacement; do not proceed without an exact exit result or an explicitly revised ADR.
- [ ] R103. Audit `portable-pty` at the production call sites in
  `terminal/pty-manager/src/pty_session.rs` and choose the smallest Darwin descriptor seam. Prove that
  a transferred descriptor can drive the existing reader, writer, resize, and signal paths without
  duplicating terminal policy in the vault. Record any unavoidable dependency or raw-FD adapter in
  ADR-0072 before changing the session model.

### Phase 1: separate PTY transport from manager policy

- [ ] R104. Refactor `terminal/pty-manager/src/pty_session.rs` and
  `terminal/pty-manager/src/pty_manager_client_sessions.rs` so `LiveSession` consumes a narrow PTY I/O
  lease instead of directly owning `portable_pty::MasterPty` and `Child`. Keep session naming, lifetime,
  headless terminal, replay, clients, generations, and viewport authority in `pty-manager`; retain the
  current in-process lease adapter until the vault path is green.
- [ ] R105. Pin the seam with existing protocol tests plus focused real-PTY tests for byte ordering,
  backpressure, resize, signal, close, session exit status, and one-reader ownership. This phase is a
  behavior-preserving refactor and must leave the current host launch path unchanged.

### Phase 2: one common descriptor vault

- [ ] R106. Add a small `terminal/pty-vault` executable with a variant-scoped `0600` Unix socket and a
  bounded session table. It owns only immutable session identity, PID/process group identity,
  descriptor custody, launch/close primitives, peer and protocol validation, and handover generation;
  getters, viewport logic, replay, parsing, client fan-out, and UI remain outside it.
- [ ] R107. Implement vault create, enumerate, lease, release, signal, and close operations. A manager
  lease duplicates the master descriptor with `SCM_RIGHTS`; the vault never reads terminal bytes.
  Protect every control operation with session generation and process identity so PID reuse or a stale
  manager cannot resize, signal, or close a replacement process.
- [ ] R108. Implement candidate-vault handover with the existing listener descriptor, a checksummed
  complete manifest, every primary master descriptor, and a prepare/validate/commit protocol. On any
  timeout, missing descriptor, count mismatch, peer death, or rejected protocol version, the candidate
  closes its duplicates and the old vault resumes without changing authority.
- [ ] R109. Add failure-injection tests for zero, one, and many sessions; output during transfer;
  candidate death before and after readiness; partial descriptor delivery; stale generations; PID
  reuse; exact exit during transfer; and stable/dev cross-connection rejection. Assert after every
  failure that at least one valid holder still owns every live master descriptor.

### Phase 3: restartable manager with stateful handover

- [ ] R110. Move production session creation and attachment in `pty-manager` onto vault leases while
  retaining the current protocol and client behavior. On a vault restart, let the live manager reseed
  the replacement from its leased descriptors; on a manager restart, let the vault enumerate the
  authoritative sessions and issue leases to the candidate manager.
- [ ] R111. Add manager-to-manager prepare/commit handover. Quiesce each old reader at a byte boundary,
  drain already-read bytes into the headless terminal, transfer the manager listener and PTY leases,
  and send a bounded reconstruction envelope containing session metadata, headless ANSI checkpoint,
  revision/generation, grid size, lifetime, and viewport authority. The candidate restores but does not
  read until it has validated the whole set; after readiness the old manager closes its leases and
  client sockets, and the candidate starts readers before reconnecting clients receive checkpoints.
- [ ] R112. Make a failed manager update non-destructive: the old manager resumes its readers and keeps
  serving clients when the candidate cannot restore every session. A forced old-manager crash may lose
  bounded replay state, but the vault must retain the child and allow a replacement manager to attach,
  trigger a same-size redraw, and continue input/output without spawning a new shell.
- [ ] R113. Add integration tests that replace both manager and vault generations independently while
  a full-screen TUI and an ordinary shell are busy. Assert unchanged child PID/process group, session
  identity, visible marker/checkpoint, revision continuity, ordered output, input, owner resize, close,
  and exact exit status; include rollback at each prepare/commit boundary.

### Phase 4: host lifecycle cutover

- [ ] R114. Replace the incompatible-peer kill in
  `host/AgentDeskHost/HostPtyManagerProcess.swift` with a variant-aware PTY runtime coordinator that
  starts or connects to the vault, updates vault and manager one component at a time, waits for a
  committed handover, and exposes a usable manager socket to the host. A rejected update keeps the
  previous runtime active and reports the exact blocker.
- [ ] R115. Update the `Justfile` host-run, host-run-dev, restart, bundle, and hash checks to build both
  executables and request live handover when either hash changes. Remove changed-binary `pkill`
  behavior, never update vault and manager concurrently, preserve stable/dev isolation, and add an
  explicit destructive reset recipe for the human-only case that intentionally closes sessions.
- [ ] R116. Add one bounded `just pty-live-update-verify` gate that starts test-owned sessions, replaces
  host-only code, manager code, and vault code in sequence, and emits machine-readable before/after
  PIDs, generations, revisions, screen markers, and exit results. It must clean only its own sockets
  and processes and must not launch either installed AgentDesk host.

### Phase 5: authorized live acceptance

- [ ] R117. After `just check` and `just pty-live-update-verify` are green, stop at the repository launch
  checkpoint and state the exact host command. After explicit user approval, relaunch the selected host
  variant with a real workspace TUI running; verify matching build identity plus unchanged session PID,
  visible state, revision, input, resize, and close behavior across host, manager, and vault updates.

## Promotion log

```text
D84      2026-07-20  landed      local multi-window browser projection decision
D85      2026-07-20  landed      restorable extension session and document-scoped generation
D86      2026-07-20  landed      validated nested AppKit projection and local bridge routing
D87      2026-07-20  landed      autonomous AX and temporary-Chrome verification seam
D88      2026-07-20  landed      live dev-host and visible Chrome-for-Testing acceptance
D88.1    2026-07-21  landed      readable projection content with source-masked passwords
D88.2    2026-07-21  landed      full shared Chrome hierarchy and selection on iOS, protocol 12
D88.3    2026-07-21  landed      ordinary text unredacted regardless of rrweb page classes, extension 0.8.1
D88.4    2026-07-21  landed      viewer-owned responsive Chrome viewport, protocol 13, extension 0.9.0
D88.5    2026-07-21  landed      workspace-shell top and left edge reveal across every display
D91      2026-07-21  landed      safe terminal bootstrap dimensions and bind-time resize recovery
D90      2026-07-22  landed      bounded headless PTY replay and metadata-only window restoration
D92      2026-07-22  landed      readable cursor-following terminal viewports without minimum sizes
D93      2026-07-22  landed      protocol-7 active-viewer terminal sizing and focus-free restoration
D89      2026-07-22  landed      shared terminal tabs, recursive splits, and session drawer
D94      2026-07-22  landed      one bounded WKWebView and xterm terminal runtime across macOS and iOS
D95      2026-07-22  landed      opt-in bounded paired-client screenshots and protocol 14
D96      2026-07-23  landed      event-driven Mission Control topology reconciliation by Space ID
D97      2026-07-23  landed      unassigned Desktops clear the active workspace selection
R98      2026-07-23  pending     target-display Dock gesture switching awaiting user verification
R99      2026-07-23  pending     settled web terminal viewport authority awaiting verification
R100     2026-07-23  pending     PTY Manager bulk controls awaiting verification
R101-117 2026-07-23  planned     centralized PTY descriptor custody and stateful live handover
```
