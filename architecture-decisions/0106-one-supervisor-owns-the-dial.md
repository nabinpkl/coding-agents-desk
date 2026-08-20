---
status: accepted
date: 2026-08-19
---

# One supervisor owns the dial

## Context and Problem Statement

Three separate bugs in one week put the iPhone client into a state where it held no session,
showed no video, and would never try again until the app was force-quit. Backgrounding mid-dial
stranded `.sessionConnecting` in a state nothing re-dialed from. Cancelling an attempt did not
cancel the dial. Coming back to the foreground never re-rendered, so the offer listener that
could have rescued any of it stayed down. All three were fixed individually.

They were the same bug. `pairingClient.state` was written from twenty places and had to be
*noticed* by twenty-three others, by hand: twelve `triggerSessionIfPaired()` calls, plus a
`render()` beside each state change, plus a `cancelSessionAttempt()` wherever an attempt had to
stop. A missed call had no alarm attached to it. Nothing crashed, nothing logged, no test
failed; the client simply went quiet, which is indistinguishable from a slow network until the
user gives up.

The machinery around it had already grown to compensate. `sessionAttemptGeneration` existed so a
stale task could tell it had been superseded. `endedRetryTask` existed because, in its own
comment, "the foreground and viewWillAppear triggers cannot fire" during a handover the app
never leaves the foreground for. `triggerSessionIfPaired` guarded on four conditions, one of
which -- foreground -- was never actually checked, and worked only because every caller happened
to be a foreground path. Affects `PairingViewController` and its extensions, `PairingClient`.

## Decision Drivers

- A client that decides not to reconnect must be impossible to produce by forgetting something.
- The decision has to be inspectable. "Why is it not dialing?" should have one place to look.
- Existing behaviour with a measured origin must survive: ADR-0089's immediate re-dial during a
  carrier handover, and ADR-0104's silence verdict and its settle gate.
- Whatever replaces the call sites must be a net deletion. Another mechanism layered on the
  existing one is one more thing to keep in sync.

## Considered Options

- **Option A**: Keep the per-trigger design; add a reactive caller so state changes also trigger.
- **Option B**: Keep the per-trigger design; give the teardown a reason so a reactive caller can
  tell "an attempt failed, the loop owns the retry" from "the session went away, nobody does".
- **Option C**: One long-lived supervisor owns the dial. Triggers stop starting work and become
  signals; a pure policy decides.

## Decision Outcome

Chose **Option C**.

Option A is wrong, not merely incomplete: the retry loop lands on `.pairedDisconnected` after
every failed attempt, so reacting to that transition re-enters the dial immediately and bypasses
the backoff -- the hot retry loop ADR-0104 explicitly rejected. Option B fixes that with a
reason code and would work, but it leaves two owners of "when do we dial", which is the shape
that produced these bugs.

`SessionDialPolicy` is a pure function of five inputs: the pairing state, whether the user
disconnected on purpose, the active surface, whether the app is foregrounded, and how the last
attempt ended. It returns `.idle`, `.dial`, or `.backoff(ms:)`. `SessionSupervisor` is one
long-lived loop that consults it, waits on a latch when there is nothing to do, and performs one
attempt when there is.

Deleted with it: `sessionTask`, `sessionAttemptGeneration`, `cancelSessionAttempt()`,
`endedRetryTask` and its delayed nudge, `triggerSessionIfPaired()` and its twelve call sites,
and the renders that existed only to follow a state change.

Three design points carry the correctness.

**The latch is sticky.** A signal raised while nobody is waiting is remembered, so the next wait
returns at once. A non-sticky latch loses exactly the edge nobody happened to be listening for,
which would reproduce the original bug one layer down.

**The gate is not the plan.** `isAllowed` -- foregrounded, not deliberately disconnected, not on
the Voice surface -- is what cancels a dial in flight. The full plan is not, because
`.sessionConnecting` is not a dialable state but *is* the state a dial itself creates: keying
cancellation on the plan would have every dial cancel itself on its own first state transition.

**Backgrounding closes the gate; it does not stop the supervisor.** A supervisor torn down when
the app leaves the foreground is not there to notice it coming back. That is the original bug,
rebuilt, so `stop()` is teardown only.

Behaviour with a measured origin is preserved as a property rather than a call. A carrier loss
on a healthy session leaves the outcome `.clean`, so the plan is `.dial` with no delay: ADR-0089
survives without a special case. The unreachable verdict becomes the long rung rather than a
stop, which is what `endedRetryTask` was approximating. The ADR-0104 settle gate moved inside
the attempt, so every retry now gets the gate that previously only the first try got.

### Consequences

- Good, because the four inputs the decision depends on all carry observers. No call site
  remembers anything; changing an input is sufficient, which is the whole deliverable.
- Good, because "why is it not dialing" is one exhaustive switch, unit-tested over every state.
- Good, because `render()` is now a consequence of the state rather than an obligation beside
  each mutation, and its re-entrancy is coalesced rather than assumed away.
- Bad, because `render()` now fires on transitions where nobody previously called it, and it is
  a large side-effecting function (it mounts surfaces, starts the offer listener, forces
  layout). The coalescing guard bounds it; a device feel-run is still owed.
- Bad, because one supervisor plus a latch is more machinery to understand at once than a
  function called from twelve places, even though it is less code.
- Neutral, because the settle gate running per attempt is a behaviour change. It is what ADR-0104
  says should happen ("EVERY dial waits for the path to hold still"), and the gate is
  history-based, so a stable path settles instantly.

### Confirmation

`SessionDialPolicyTests` covers the gate, the rung ladder, and every state, including the
self-cancellation trap. `SessionDialLatchTests` pins stickiness directly, because that property
has no other alarm. `SessionSupervisorTests` drives the loop against a fake dial and asserts the
behaviours the deleted call sites used to approximate: a backgrounded client dials when it
returns, repeated background/foreground cycles keep working, a closing gate cancels a dial in
flight, a failure backs off instead of spinning, and an explicit Connect skips the rung.

The compliance signal is absence: `triggerSessionIfPaired`, `cancelSessionAttempt`,
`sessionAttemptGeneration`, `sessionTask`, and `endedRetryTask` do not appear in the tree.

## Pros and Cons of the Options

### Option A: reactive caller on the existing design

- Good, because it is a few lines.
- Bad, because reacting to `.pairedDisconnected` re-enters the dial on every failed attempt and
  bypasses the backoff.

### Option B: reason-coded teardown

- Good, because it fixes the hot loop and is a day's work.
- Bad, because "when do we dial" still has two owners, which is the shape that produced the bugs.

### Option C: one supervisor

- Good, because the decision has one home, is pure, and is exhaustively testable.
- Good, because it is a net deletion of four pieces of coordination machinery.
- Bad, because the migration cannot be split: a half-done version has two owners, which is worse
  than one forgetful owner.

## Links

- ADR-0089 (immediate re-dial during a carrier handover, preserved as a policy property)
- ADR-0104 the session outlives its carrier (silence verdict, settle gate)
- ADR-0030 single QUIC session transport
