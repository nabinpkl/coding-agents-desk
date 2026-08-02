---
status: accepted
date: 2026-07-27
---

# A PTY session lives as long as its process, and only an explicit act ends it

## Context and Problem Statement

Terminals were dying when nobody had asked them to. The PTY manager reaped a `Leased` session
`leased_session_grace` (30s) after its last client detached, and several surface-level events sent a
close that the host answered with `killSession`: the iPhone switching surfaces, tapping Disconnect,
unpairing, and a rejected session (`AgentFeedTerminalLifecycleRouter.route`), plus a failed attach on
the Mac (`AgentWindowTerminalController.attach`). All of these confuse *the user is finished with
this terminal* with *the surface showing it went away*. They are not the same thing, and only the
first is a decision about the session.

The forcing cases: the iPhone must be able to close the app with its terminals still running, and a
host rebuild-and-relaunch — arbitrarily long in Release — must not cost the IDE, the Agents windows,
or the standalone terminal windows their work. This touches `terminal/pty-manager` (the reaper and
`SessionLifetime`), `AgentSessionTerminalCoordinator`, `AgentWindowTerminalController`, the client's
`AgentFeedTerminalSession`, and every surface that attaches by session name.

## Decision Drivers

- A backgrounded phone, a dropped QUIC link, and a five-minute Release rebuild must all be
  survivable, and none of them is distinguishable from the others at the manager.
- Sessions that nothing will ever reattach to must still be findable and endable, or they accumulate
  invisibly for the life of the machine.
- One authoritative rule, not a per-surface policy: the same event on the phone, the Mac window, and
  the IDE pane must mean the same thing.

## Considered Options

- **Longer grace**: keep the timer, raise it to 300s and share it across every surface.
- **Owner registration**: surfaces register as owners; the manager reaps sessions with zero
  registered owners after a long idle.
- **The tmux model**: no timed reap at all. A session lives while its process lives; detaching is
  free and unbounded; ending one requires an explicit act.

## Decision Outcome

Chose **the tmux model**. A longer grace only moves the cliff — five minutes still kills a phone left
in a pocket over lunch and a Release rebuild that hits a cold cache, and the failure is silent and
unrecoverable, which is the worst shape for this class of bug. Owner registration is the principled
version of the same idea but requires every surface (including the iPhone, which has no host-side
store) to participate correctly for the manager to be right, and getting that wrong kills a live
session; the cost of being wrong is asymmetric enough that the mechanism has to be simpler than the
thing it protects.

The three legitimate reapers that remain:

1. **The process exits.** `handle_natural_exit` already fires off the process, independent of client
   presence, and is untouched.
2. **The user ends the terminal.** On the phone `AgentFeedTerminalEndReason` collapses to
   `userClose` / `contextEnded`, the only two that emit `AgentTerminalClose`; on the Mac
   `beginClose` still sends one for `user-close`, `context-ended`, `window-should-close`, and
   `context-replaced`. Closing an IDE or terminal *pane* also kills its session when it is the last
   client (`closeSessionForRemovedPane`).
3. **The user kills it from the session drawer.** A running session with no clients renders as a
   `detached` orphan with a Kill button.

`SessionLifetime` (`Persistent` / `Leased`) went with the reaper: with nothing reaping on client
absence both variants meant "lives while its process lives", and a field that no longer controls
behavior is a field that drifts. It is removed from `pty.proto` and `vault.proto` (tags reserved),
the Rust manager, `PtyClient`, and the iOS client. The three `lifetime ==` checks that were doing
real work as cross-namespace guards are now name-ownership checks —
`WorkspaceTerminalIdentity.owns(sessionName:)` and the new
`AgentResumeTerminalIdentity.owns(sessionName:)` — which is what they were actually testing for.

### Consequences

- Good, because a host rebuild of any length, a backgrounded phone, and a dropped link all leave the
  terminal running, and reattaching lands on the same PID with its scrollback.
- Good, because the `session lifetime mismatch` failure mode is gone along with the field, and each
  namespace guard now states what it means.
- Bad, because a session nothing will ever reattach to now lives until someone kills it. The drawer
  makes that visible and one tap to end, but it is manual where it used to be automatic.
- Neutral, because `context-replaced` still kills the outgoing terminal when a window's pane is
  pointed at a different agent context. That is existing behavior and was left alone.
- Neutral, because pane-close kills while window-close only detaches. Closing a pane is "I am done
  with this terminal"; closing a window is "put this away".

### Confirmation

`terminal/pty-manager/tests/session_lifetime_tests.rs` pins the invariant directly: a final detach, a
dropped socket, and a `close_client` each leave the session running well past the interval that used
to reap it, and reattaching returns the original PID. `AgentFeedTerminalTests` asserts that no
surface interruption emits `AgentTerminalClose`; `AgentWindowTerminalControllerTests` asserts an
attach failure sends no close and keeps the attachment resumable;
`AgentSessionTerminalIntegrationTests` drives the same rule against a real manager.

## Pros and Cons of the Options

### Longer grace

- Good, because it is a one-constant change and keeps automatic cleanup.
- Bad, because it does not remove the cliff, only relocates it, and every value is wrong for some
  legitimate absence.
- Bad, because the failure is silent: the terminal is simply gone, with no signal about why.

### Owner registration

- Good, because it distinguishes "no surface is showing this" from "no surface will ever show this",
  which is the distinction a correct automatic reaper actually needs.
- Bad, because correctness depends on every surface deregistering accurately, including one (the
  iPhone) with no host-side store, and a bug there kills a live session.
- Bad, because it is substantially more machinery than the problem justifies at v0.

## Links

- ADR-0072 centralize PTY descriptor custody with live handover
- `terminal/pty-manager/src/pty_manager_client_sessions.rs`, `host/AgentDeskHost/AgentSessionTerminalCoordinator.swift`
- `client/AgentDeskClient/AgentFeedTerminalSession.swift`
