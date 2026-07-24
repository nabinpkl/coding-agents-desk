# TASKS: v8 centralized PTY live handover

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its tests are green.
This ledger continues from R100 in
`tasks/archive/2026-07-23-v7-browser-projection-and-v8-terminal-workspace.md`.

## Position

This iteration separates kernel PTY custody from terminal policy so code updates do not replace a
running shell or TUI. One bundle-variant-scoped `pty-vault` holds the primary master descriptor for
every live session. The restartable `pty-manager` leases those descriptors and retains readers,
writers, headless parsing, bounded replay, clients, viewport authority, and lifecycle policy.

The descriptor seam and Darwin capability gates land first because the rest of the design depends on
descriptor transfer and exact exit reporting working after the spawning process exits. The common
vault lands next, followed by stateful manager handover, host lifecycle cutover, and an authorized live
acceptance run. Vault and manager updates are sequential so at least one process always holds every
live master descriptor.

The acceptance invariant covers more than child-process survival. After changing host, manager, or
vault code and performing an authorized relaunch, each session retains its identity, child PID and
process group, visible TUI state, revision, input, resize behavior, and exit notification. A
simultaneous vault-and-manager crash is outside the guarantee because no process would remain to hold
the master descriptor.

## v8 Phase 0: decision and Darwin capability gates

- D101. Draft and explicitly accept ADR-0072 before implementation, recording the common-vault
  choice, dual descriptor custody, manager-owned terminal semantics, sequential updates, atomic
  rollback, exact exit status, stable/dev isolation, and the simultaneous-holder-loss boundary; leave
  accepted ADR-0066 immutable, cross-reference it from ADR-0072, and update `SPEC.md` only after the
  superseding decision is accepted.
- R102. Add a Darwin-only integration harness that opens a real PTY, runs a continuously changing TUI
  marker, transfers the master and listening Unix-socket descriptors with `SCM_RIGHTS`, exits the
  original owner, and proves the same child PID, process group, screen marker, input, resize, EOF, and
  cleanup survive in the replacement; exercise `EVFILT_PROC` with `NOTE_EXIT` and `NOTE_EXITSTATUS`
  after parent replacement and stop if exact exit status cannot be preserved.
- D103. Audit `portable-pty` at the production call sites in
  `terminal/pty-manager/src/pty_session.rs` and choose the smallest Darwin descriptor seam; prove that
  a transferred descriptor drives the existing reader, writer, resize, and signal paths without
  moving terminal policy into the vault, and record any unavoidable dependency or raw-FD adapter in
  ADR-0072 before changing the session model.

## v8 Phase 1: PTY transport seam

- D104. Refactor `terminal/pty-manager/src/pty_session.rs` and
  `terminal/pty-manager/src/pty_manager_client_sessions.rs` so `LiveSession` consumes a narrow PTY I/O
  lease instead of directly owning `portable_pty::MasterPty` and `Child`; keep session naming,
  lifetime, headless terminal, replay, clients, generations, and viewport authority in `pty-manager`,
  and retain the current in-process lease adapter until the vault path is green.
- D105. Pin the seam with existing protocol tests plus focused real-PTY tests for byte ordering,
  backpressure, resize, signal, close, session exit status, and one-reader ownership; leave the current
  host launch behavior unchanged throughout this refactor.

## v8 Phase 2: common descriptor vault

- D106. Add `terminal/pty-vault` as a small executable with a variant-scoped `0600` Unix socket and a
  bounded session table; keep its ownership to immutable session identity, PID/process group identity,
  descriptor custody, launch and close primitives, peer and protocol validation, and handover
  generation, with getters, viewport logic, replay, parsing, client fan-out, and UI outside it.
- D107. Implement vault create, enumerate, lease, release, signal, and close operations; duplicate each
  manager lease with `SCM_RIGHTS`, never read terminal bytes in the vault, and protect control
  operations with session generation and process identity so PID reuse or a stale manager cannot
  resize, signal, or close a replacement process.
- R108. Implement candidate-vault handover with the existing listener descriptor, a checksummed
  complete manifest, every primary master descriptor, and a prepare/validate/commit protocol; on a
  timeout, missing descriptor, count mismatch, peer death, or rejected protocol version, close the
  candidate duplicates and resume the old vault without changing authority.
- R109. Add failure-injection tests for zero, one, and many sessions, output during transfer, candidate
  death before and after readiness, partial descriptor delivery, stale generations, PID reuse, exact
  exit during transfer, and stable/dev cross-connection rejection; assert after every failure that at
  least one valid holder owns every live master descriptor.

## v8 Phase 3: stateful manager handover

- R110. Move production session creation and attachment in `pty-manager` onto vault leases while
  retaining the current protocol and client behavior; let a live manager reseed a replacement vault
  from its leases after a vault crash, and let the vault enumerate authoritative sessions and issue
  leases to a candidate after a manager crash.
- R111. Add manager-to-manager prepare/commit handover that quiesces each old reader at a byte boundary,
  drains already-read bytes into the headless terminal, transfers the manager listener and PTY leases,
  and sends a bounded reconstruction envelope containing session metadata, headless ANSI checkpoint,
  revision and generation, grid size, lifetime, and viewport authority; start candidate readers only
  after the complete set validates and the old manager closes its leases and client sockets.
- R112. Make a failed manager update non-destructive by resuming the old manager readers and clients
  when the candidate cannot restore every session; after a forced old-manager crash, retain the child
  in the vault and let a replacement attach, trigger a same-size redraw, and continue input and output
  without spawning a new shell, while treating lost bounded replay as an explicit crash-only limit.
- R113. Add integration tests that replace manager and vault generations independently while a
  full-screen TUI and ordinary shell are busy; assert unchanged child PID and process group, session
  identity, visible marker and checkpoint, revision continuity, ordered output, input, owner resize,
  close, and exact exit status, including rollback at every prepare/commit boundary.

## v8 Phase 4: host lifecycle cutover

- R114. Replace the incompatible-peer kill in
  `host/AgentDeskHost/HostPtyManagerProcess.swift` with a variant-aware PTY runtime coordinator that
  starts or connects to the vault, updates vault and manager one component at a time, waits for a
  committed handover, and exposes a usable manager socket to the host; keep the previous runtime active
  and report the exact blocker when an update is rejected.
- R115. Update the `Justfile` host-run, host-run-dev, restart, bundle, and hash checks to build both
  executables and request live handover when either hash changes; remove changed-binary `pkill`
  behavior, prohibit concurrent vault and manager updates, preserve stable/dev isolation, and add an
  explicit destructive reset recipe for the human-only case that intentionally closes sessions.
- R116. Add a bounded `just pty-live-update-verify` gate that starts test-owned sessions, replaces
  host-only code, manager code, and vault code in sequence, and emits machine-readable before/after
  PIDs, generations, revisions, screen markers, and exit results; clean only its own sockets and
  processes and never launch an installed AgentDesk host.

## v8 Phase 5: authorized live acceptance

- R117. After `just check` and `just pty-live-update-verify` are green, stop at the repository launch
  checkpoint and state the exact host command; after explicit user approval, relaunch the selected host
  variant with a real workspace TUI running and verify matching build identity plus unchanged session
  PID, visible state, revision, input, resize, and close behavior across host, manager, and vault
  updates.

## Promotion log

```text
D101     2026-07-23  landed      accepted centralized PTY custody and handover decision
D103     2026-07-23  landed      Darwin descriptor transfer and post-parent exit gates
D104-105 2026-07-23 landed       manager PTY lease seam and lifecycle behavior gates
D106-107 2026-07-23 landed       common vault custody, validated control, and descriptor leases
R102     2026-07-23  active      continuous TUI marker handover gate
R108-117 2026-07-23  planned     vault handover through authorized live acceptance
```
