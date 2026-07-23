---
status: accepted
date: 2026-07-23
supersedes: ADR-0066 (manager process lifetime only; bounded replay remains)
---

# Centralize PTY descriptor custody with live handover

## Context and Problem Statement

ADR-0066 made the Rust `pty-manager` longer-lived than the AgentDesk host so terminals survived an
ordinary host relaunch. The manager still owned the only PTY master descriptors and child handles.
Changing the bundled manager caused `HostPtyManagerProcess` and the host recipes to terminate that
process, which closed the final master descriptors, killed leased sessions during shutdown, and
discarded bounded terminal state.

AgentDesk needs to update its host, manager, and descriptor-owning code without replacing running
shells or full-screen TUIs. macOS does not retain an orphaned PTY master on behalf of a future process,
so at least one live process must hold each master descriptor throughout an update.

## Decision Drivers

- A code update must retain session identity, child PID and process group, visible terminal state,
  revision, input, resize, and exit reporting.
- The small process that preserves kernel resources must not absorb parsing, viewport, replay, client,
  or UI policy.
- A failed candidate must leave the previous generation authoritative.
- Stable and dev hosts must keep independent runtimes and session tables.
- The first installation may replace pre-vault sessions; no compatibility mode is required.

## Considered Options

- **Keep one persistent manager binary**: preserve the current process when its binary changes.
- **Run one holder process per session**: isolate every PTY in a separate long-lived process.
- **Use one common vault plus a restartable manager**: retain duplicate descriptor custody and transfer
  complete generations between processes.

## Decision Outcome

Choose **one common vault plus a restartable manager**. The existing Rust package builds two
executables from one internal protocol implementation:

- `pty-vault` owns the primary PTY master descriptor, immutable session identity, PID and process-group
  identity, launch and close operations, terminal dimensions, exact exit observation, and vault
  generation.
- `pty-manager` leases duplicate master descriptors from the vault and owns all terminal semantics:
  readers, writers, the Alacritty headless terminal, bounded ANSI checkpoints, revisions, clients,
  viewport authority, lifetime policy, and the public PTY protocol.

The vault never reads or writes terminal bytes. While a manager is active, the vault and manager each
hold a master descriptor for every session. Updating one component never closes the last descriptor.
The two components update sequentially.

Both daemons expose a private variant-scoped handover socket beside their stable public socket. A
candidate connects before the old generation stops:

1. The old generation stops admitting new work and quiesces mutable state.
2. It transfers its listener descriptors, complete bounded manifest, and every owned PTY descriptor
   with `SCM_RIGHTS`.
3. The candidate validates the entire generation without reading PTY bytes.
4. The old generation sends commit. The candidate activates and acknowledges.
5. Only after activation does the old generation close its descriptors and exit.

Any failure before activation closes candidate duplicates and resumes the old generation. Vault
handover transfers descriptor and process metadata. Manager handover additionally transfers a bounded
ANSI reconstruction checkpoint, revision, grid dimensions, lifetime, and viewport state. Public
clients reconnect after the generation boundary and receive the reconstructed checkpoint.

New vault generations observe existing processes with Darwin `EVFILT_PROC`, `NOTE_EXIT`, and
`NOTE_EXITSTATUS`. Control operations validate the session generation and current PTY foreground
process group before signaling, which prevents a stale request or reused PID from targeting another
process. An exact-exit integration gate must remain green.

The first release is a clean cutover. It may terminate a manager created by pre-ADR code because that
process cannot transfer descriptors. Once the vault runtime is installed, changed-binary termination
is removed from Swift and the `Justfile`; future updates use handover only.

### Consequences

- Good, because host, manager, and vault binaries can change without replacing live child processes.
- Good, because terminal policy remains in the replaceable manager rather than calcifying inside the
  descriptor holder.
- Good, because a candidate failure preserves the complete prior generation.
- Bad, because the private handover protocol and two-holder invariant add lifecycle code and
  failure-injection tests.
- Bad, because an ungraceful manager crash can lose bounded replay before a replacement triggers a TUI
  redraw, although the child process and PTY survive in the vault.
- Neutral, because simultaneous loss of vault and manager remains fatal: no process would retain a
  master descriptor.

### Confirmation

`just pty-live-update-verify` starts test-owned shell and full-screen TUI sessions, replaces manager and
vault generations independently, and asserts unchanged child PID and process group, screen marker,
revision continuity, input, resize, close, and exact exit status. `just check` runs the lower-level
descriptor, protocol, rollback, variant-isolation, and host-lifecycle tests. Installed-host validation
remains behind the repository launch checkpoint.

## Links

- ADR-0053 AgentDesk owns the terminal PTY packages
- ADR-0066 bounded Rust-owned terminal replay
- ADR-0068 active terminal viewer owns source size
- ADR-0069 shared web terminal workspace
- SPEC terminal components and PTY session lifecycle
