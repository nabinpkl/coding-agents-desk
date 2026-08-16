---
status: accepted
date: 2026-08-16
supersedes: ADR-0089
---

# The session outlives its carrier

## Context and Problem Statement

On the client, the QUIC connection WAS the session. `PairingClient` held loose per-connection
fields and a state enum whose `.connected` conflated "session exists" with "connection
exists", and five independent, connection-scoped authorities could each end the session: a
datagram liveness probe (three unanswered echoes), a handover watch (link change plus a 2s
grace), the QUIC state reaching `.failed`, a 5s quiet-spell grace timer, and the input stream
closing. Any lane's receive error also closed the whole transport, so one stream's death
became the carrier's death became the session's death.

None of these consulted evidence that the session was *working*. The terminal measurement: a
session was torn down in the same 500ms report window that logged
`video-performance totalFrames=1143 dropped=0 corrupted=0`.

The host has been session-first since ADR-0030 — `SessionRegistry` suspends rather than ends
when a connection dies, and `sessionMedia` keys the encoder to the session — so every false
client teardown wasted machinery that was working. Two attempts to fix the detectors with a
dedicated liveness stream (a host heartbeat, then a raw ping/pong lane; both reverted) failed
identically: they made one stream the sole authority, so that stream dying still read as the
session dying, and their raw-byte framing misread QUIC stream resets as protocol violations.

Affects `SessionLifecycle.swift` (new), `PairingClient.swift`, `PairingViewController.swift`,
both `OwnedMediaTransport.swift` files, `InputChannelServer.swift`, `MediaSessionLoss.swift`,
`HostStatusPresentation.swift`, `UIFrames.swift`.

## Decision Drivers

- A teardown costs a session's continuity (surfaces, decoder, and until recently a full IDR
  plus a 9-16s LTR rebuild). It must follow evidence the SESSION is unusable, not evidence
  that a socket, stream, radio, or packet changed state.
- Exactly one component may reach the verdict. Detectors that cannot see each other's
  evidence are wrong independently, and the session dies to whichever is wrong first.
- Delivered traffic must count. Any design where a liveness verdict can contradict a flowing
  video stream is malformed by construction.
- The stalls this link actually produces (2-3s, self-healing; one measured 9s) must be ridden
  out; a genuinely dead session must still be declared inside the host's 20s resume TTL.

## Considered Options

- **Option A**: Keep the detectors, tune every threshold upward.
- **Option B**: A dedicated reliable liveness stream with its own protocol (tried twice).
- **Option C**: A client session object with one liveness clock fed by ALL inbound traffic;
  carriers become replaceable; ping/pong rides the existing input lane, only when quiet.

## Decision Outcome

Chose **Option C**. Three moves, none separable:

**The session becomes an object with its own lifecycle** — `live ⇄ reattaching → ended` —
and the carrier becomes a replaceable attribute. Every former death path now routes to
`reattaching`: surfaces stay mounted with the last frame, the decoder survives (which is what
makes the ADR-0090 delta-resync recovery reachable), and the existing redial machinery
replaces the carrier underneath. `SessionLivenessMonitor` is owned by `PairingClient` — the
session's owner — and only *borrowed* by each transport, so the clock survives every swap.

**Exactly one death authority.** A session ends for three reasons only: the host rejected it,
the user disconnected, or `SessionLivenessClock` measured no completed exchange for the
silence limit (15s) *across every carrier tried*. A redial does not reset the clock; only
evidence does — so a storm of short-lived carriers cannot postpone the verdict, and equally
cannot cause one. At the verdict the client shows the honest failure UI with the existing
auto-redial triggers still armed.

**Any inbound proof is evidence.** A decoded datagram arrival, any input-lane push, a
completed handshake, a pong — all feed the same clock. The ping/pong pair
(`SessionPing`/`SessionPong`, framed JSON on the input lane, host replies in the existing
dispatch switch) exists only to manufacture traffic when the screen is static and nothing
else flows; an active session never pings. The pong carries the session id, so it counts for
the session whichever carrier delivers it. Link changes survive as a hint — send the next
ping immediately — never as a cause.

### Consequences

- Good, because the contradiction class is gone structurally: delivered frames ARE liveness,
  so no verdict can coexist with a working stream.
- Good, because a reconnect stops being self-confirming. The old teardown produced the
  silence that justified the next teardown; now a carrier swap produces no verdict at all,
  and with ADR-0090 plus the manual-pin carry it costs a delta resync, not an IDR.
- Good, because the user-facing words stop lying. `linkChanged`/`hostSilent` claimed to know
  which end broke and were measured wrong in 13 of 14 teardowns; `reattaching` blames
  neither, and shows nothing at all for swaps under the 2s overlay grace.
- Good, because the wire shrinks: no dedicated stream, no raw framing, no probe/echo
  datagram kinds, three config keys deleted for three added.
- Bad, because liveness now shares the input lane with occasionally large transfers
  (screenshots ride it). Bounded: those are rare and request-scoped, and the silence budget
  is 15s against multi-hundred-KB frames.
- Bad, because a session with a live carrier whose input lane alone wedges (stream stuck,
  connection healthy) now waits for the silence verdict rather than a stream-specific
  detector. Accepted: that case was never observed, and the old stream-specific detectors
  were the false-positive source.
- Neutral, because the host side is untouched except for the pong responder: the registry's
  TTL already governs host-side session lifetime.

### Confirmation

Deleted outright: `evaluateLivenessProbe`, `evaluateHandoverRecovery`, their watch structs,
the 5s quiet grace, `livenessProbe`/`livenessEcho` control kinds and the host echo sender,
`HandoverRecoveryPolicy`, `LivenessProbePolicy`, and the `linkChanged`/`hostSilent` loss
reasons — every surviving reader fails to compile rather than silently defaulting.

`SessionLivenessClockTests` pins the rules, including the two that carry the design: sending
pings does not postpone the verdict (only inbound evidence moves the clock), and silence
accumulates across carrier swaps. On device: `sessionUnreachable` count against the 13-14
teardowns/session baseline; a WiFi toggle produces `reattaching` with an unchanged session
id and a delta-resync recovery; a killed host is declared within ~15s.

## Pros and Cons of the Options

### Option A: tune the thresholds

- Good, because it is small.
- Bad, because five authorities remain five authorities; each becomes slower to be wrong,
  and a real death is detected later in exact proportion.

### Option B: dedicated liveness stream (tried twice, reverted twice)

- Good, because it isolates liveness from bulk-traffic loss (the real defect of the
  datagram probe).
- Bad, because it re-centralizes the verdict on one stream's health — both field failures
  were the lane's own socket dying being read as the session dying.
- Bad, because a parallel raw-byte protocol duplicates framing the input lane already has,
  and both attempts misread stream resets as malformed frames.

### Option C: session object, one clock, evidence from everything

- Good, because it removes the connection→session inference instead of tuning it.
- Good, because it reuses everything that already worked: resume, surface preservation, the
  redial loop, the input lane's framed protocol.
- Bad, because it is the largest change surface of the three — session state, transport,
  view controller, presentation, and wire all move together.

## Links

- ADR-0030 session transport (host-side "a session outlives its connection"; this ADR makes
  the client obey the same rule)
- ADR-0089 handover recovery and liveness (superseded outright: its insight — redial NOW,
  because foreground triggers cannot fire during a handover — survives in the reattach path;
  its detectors and their verdicts do not)
- ADR-0090 resume without a keyframe (the recovery this makes routinely reachable)
- ADR-0098/0101 quality controller (unchanged; its signals are about quality, not liveness)
