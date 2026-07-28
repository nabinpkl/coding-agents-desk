---
status: accepted
date: 2026-07-27
supersedes: ADR-0072 (update failure policy only; descriptor custody and the handover mechanism stand)
---

# A code update never ends a PTY session

## Context and Problem Statement

ADR-0078 declared that a session ends only when its process exits or someone explicitly ends it.
The update path did not honour that. ADR-0072 built a live handover so binaries could change without
replacing running shells, but it defined the handover in terms of the current schema and gave a
failed handover exactly one outcome: leave the previous generation authoritative.

ADR-0078 then removed `SessionLifetime` from `CreateOrAttach` and `Session`. The handover manifest
carries `pty.vault.v1.Session` directly, and its integrity check (`vault_handover.rs`,
`manager_handover.rs`) hashed *re-encoded* protobuf. prost drops fields a reader does not know, so
the candidate re-encoded fewer bytes than the sender had hashed and rejected a transfer in which
nothing had gone wrong. The candidate exited, `HostPtyRuntimeProcess.launchComponents` abandoned the
whole update, and a four-day-old runtime stayed authoritative while every current host asked it for
a session in a dialect it refused. Terminals were dead until someone ran `just reset-pty-runtime` by
hand, which ends every session. The mechanism built to preserve sessions across a code change was
defeated by a code change, and the escape hatch was manual.

## Decision Drivers

- A session ends only when its process exits or someone explicitly ends it (ADR-0078). No code
  update, wire change, or failed handover may end one.
- A failed update must never leave a runtime the host cannot use. Being stuck is worse than being
  out of date.
- Recovery must not require a human. `just fresh-install` and `just host-run` are the whole
  interface.
- Handover is the one wire in this repo where two different builds talk to each other. It must
  tolerate schema drift by construction, not by remembering to be careful.

## Considered Options

- **Frozen negotiated handover**: a preamble both generations always speak, with version ranges,
  and a clean decline when they cannot agree.
- **Asymmetric custody with drift-tolerant validation**: treat the two daemons differently
  according to what their death costs, and stop validating handover payloads in ways that a schema
  change breaks.
- **Status quo plus documentation**: keep the old generation authoritative and tell people to run
  the destructive reset.

## Decision Outcome

Chose **asymmetric custody with drift-tolerant validation**, because it is the only option that
satisfies the first driver without depending on foresight.

The two daemons are not equally precious, and treating them as one thing is what created the dead
end. `pty-vault` holds the only durable master descriptor for every session; terminating it closes
the last master and SIGHUPs every child on the machine. `pty-manager` holds duplicate leases, and a
cold-started manager already re-adopts the vault's sessions (`recover_vault_sessions`). So:

- **A live vault is never terminated by an update.** If its handover fails, the older vault keeps
  serving and the host carries on with a lagging vault binary, which is recorded as a degraded
  state rather than a failure. The binary catches up when its sessions end naturally.
- **A manager that cannot hand over is replaced outright.** The vault still holds every master, so
  the cold-started manager re-adopts the sessions. The cost is bounded replay state, not sessions.
- **The vault step never aborts the manager step.** A vault that could not be replaced is still
  serving live sessions, and the manager must still be brought up to date, or the host ends up with
  intact sessions it cannot reach. That was the actual shape of the outage.
- **Never replace the last holder.** A vault that started fresh, whether cold-started after a failed
  handover or launched because none was running, comes up empty and reseeds custody from the running
  manager's leases. For that window the manager holds the only descriptors keeping the children
  alive, so it is kept for that pass even if its own handover fails. Replacing both in one pass is
  the one remaining way the ladder could close the last master for every session, and it is reachable
  from two directions: a failed vault handover, and a vault that died while the manager kept running.
  On a clean boot the same rule costs nothing, because there is no manager to keep.
- **Handover payloads are no longer validated by re-encoding them.** The checksums are still sent
  for older peers that check them, and no longer recomputed on receipt. Session identity, counts,
  and the per-descriptor cross-check against the manifest carry the real validation and survive a
  schema change.
- **The vault wire is frozen.** `VAULT_PROTOCOL_VERSION` stays at 1 permanently. Every vault ever
  shipped rejects a version above its own, and that code is already running on machines, so a bump
  cannot negotiate anything; it can only make a new manager unable to reach the vault holding its
  sessions. The wire evolves by protobuf's own rules: add fields, add payload variants, never
  renumber, mark removals `reserved`. Readers on both sides accept a range instead of demanding
  their own number.

The frozen negotiated handover was not chosen as the primary mechanism because a preamble only helps
peers that already send one, and the generation you most need to survive is by definition the one
already running. Negotiation is worth adding the day a genuinely breaking vault change is needed;
until then it would be a second mechanism guarding a case the ladder above already covers.

Status quo plus documentation fails the third driver outright: the documented recovery ends every
session, which is the thing ADR-0078 exists to prevent.

### Consequences

- Good, because a code update, including one that changes the wire, cannot end a session. The worst
  case is a lagging vault binary or a reset scrollback.
- Good, because recovery is automatic. `just reset-pty-runtime` remains, but only as the explicit,
  intentional way to end sessions.
- Good, because a failed handover now says why: candidate output goes to a per-launch log the host
  reads back into the failure message instead of `/dev/null`.
- Bad, because a vault binary can silently lag behind the bundle for as long as its sessions live. A
  vault fix does not reach a machine with long-lived terminals until they end. The degraded state is
  logged, not surfaced in the UI.
- Bad, because a replaced manager loses bounded ANSI checkpoints for its sessions; a reconnecting
  client sees an empty scrollback on a live shell.
- Neutral, because the handover checksums remain on the wire, computed but not trusted by current
  receivers.
- Neutral, because the candidate activation timeout is now a backstop for a hung process rather than
  a budget for a working one. An early reading of the first live failure blamed that budget and
  claimed handover cost scales with session count. It does not: twelve sessions transfer in 23ms.
  The timeout was never the cause, and raising it changed only how long the host waited before
  giving up.

### A generation is identified by what it publishes, not by who owns its socket

Every vault handover from ADR-0072 until this decision failed while succeeding. The candidate
completed the transfer in milliseconds, logged itself ready, and served clients, and the host
declared it dead thirty seconds later.

The host identified the serving generation by connecting to the socket and reading `LOCAL_PEERPID`.
A handover candidate inherits its listening socket through `SCM_RIGHTS` rather than binding it, and
Darwin attributes that peer pid to the process that **created** the socket. A candidate that has
taken over completely still reports its predecessor's pid, so waiting for the pid to change is
unsatisfiable for any handover. Verified directly: hand a vault from one pid to another and a fresh
client still reads the old one.

Two things hid it. The ladder above absorbed every failure into the cold-start path, and the
outgoing manager's leases reseeded custody each time, so terminals kept working. And the same broken
signal drove the discard, so the host was terminating candidates that already held every session
descriptor from a vault that had already exited: sessions survived on the manager's leases alone,
one process away from losing every terminal on the machine.

A daemon publishes its own pid and digest once it is genuinely serving, after the transfer commits
and before it accepts. That is authoritative and the host already had it. It is now the only way a
generation is identified, and the socket-peer machinery is deleted so the broken signal cannot be
reached for again.

### Confirmation

`just pty-handover-cross-version [base-ref]` builds the runtime from an older commit, gives it a
live session, and lets the current binaries take over, asserting the child process is the same one
afterwards and again after a manager cold start. It is the only handover test that is not talking to
itself: every other one builds both peers from a single tree and therefore agrees with itself no
matter what the wire does, which is how the ADR-0078 field removal shipped green.

`HostPtyRuntimeProcessTests` pins the ladder: a live vault is kept whatever went wrong, an absent
one cold starts, and a manager is replaced either way.

The observable signal that the primary mechanism is actually running, rather than the ladder quietly
covering for it, is a host log that reads `PTY vault update handover` followed by `PTY runtime ready`
with no cold start in between. On a machine with thirteen live sessions that sequence completes in
under a second. A run that reports `rebuilt vault` instead means handover failed and the fallback
carried it, which is survivable but is not the system working.

## Pros and Cons of the Options

### Frozen negotiated handover

- Good, because two generations state what they can speak instead of discovering it by failing.
- Good, because a clean decline is a much better trigger for a fallback than an opaque crash.
- Bad, because the generation already running does not send a preamble, so it cannot help with the
  version gap that is actually stranding a machine today.
- Bad, because tolerating a missing preamble requires a legacy timeout path, which is a second
  mechanism for a case the custody ladder already handles.

### Asymmetric custody with drift-tolerant validation

- Good, because the invariant is structural: the only branch that terminates anything requires the
  disposable component, so no future edit can accidentally kill a vault.
- Good, because it needs no foresight about which schema change will be breaking.
- Bad, because it accepts a vault binary lagging indefinitely behind the bundle.

### Status quo plus documentation

- Good, because it is no work.
- Bad, because the documented recovery ends every session and needs a human, failing two drivers.

## Links

- ADR-0072 Centralize PTY descriptor custody with live handover
- ADR-0078 A PTY session lives as long as its process
- `host/AgentDeskHost/HostPtyRuntimeProcess.swift`
- `terminal/pty-manager/src/vault_handover.rs`, `manager_handover.rs`, `vault_protocol.rs`
- `tools/pty-handover-cross-version.sh`
