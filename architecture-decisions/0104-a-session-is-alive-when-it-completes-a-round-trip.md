---
status: accepted
date: 2026-08-16
supersedes: ADR-0089, ADR-0103
---

# A session is alive when it completes a round trip

## Context and Problem Statement

ADR-0089 gave the client two independent ways to conclude the host was gone: a handover watch
armed by a link change, and a liveness probe answered by a host echo. ADR-0103 replaced the
second with a one-way host heartbeat on its own reliable stream and left the first standing.

All three designs answer the same question — "should this session be torn down?" — by watching a
proxy for it, and each proxy was wrong in its own way. Measured on device across a night:

- The datagram probe/echo: the host logged **187 probes received and 187 echoes sent, with zero
  send failures**. The client received **108 of 175**. Thirteen of fourteen teardowns that
  session were blamed on a silent host that had answered everything it was asked.
- The handover watch: the fourteenth teardown was a genuine WiFi-to-cellular switch declared dead
  at **2,098ms against a 2,000ms grace** — 98 milliseconds before the new path came up.
- The one-way heartbeat: it made the *host's* liveness reliable and, in doing so, tied the
  session's fate to one QUIC stream. In the field it produced **8 lane attaches in 5 minutes**,
  ending in `POSIXErrorCode 57: Socket is not connected`. A dead socket was read as a dead
  session.

Each teardown cost a full IDR and a long-term reference set that takes 9-16 seconds to rebuild,
so the mechanism meant to detect failure was the largest single producer of it.

Affects `LivenessLane.swift`, `LivenessLaneServer.swift`, `SessionLiveness.swift` (new), both
`OwnedMediaTransport.swift`, `MediaSessionLoss.swift`, `HostStatusPresentation.swift`, and
`PairingViewController.swift`.

## Decision Drivers

- A teardown must follow evidence the session is unusable, not evidence that a packet, a socket,
  or a radio changed state.
- The signal must not compete with the traffic it reports on.
- Exactly one component may reach the verdict. Two detectors watching different proxies cannot be
  reconciled, and the wrong one fires first.
- It must ride out the stalls this link actually produces (2-3s, self-healing) without sitting on
  a session that is genuinely finished.

## Considered Options

- **Option A**: Keep both detectors, widen the handover grace and the heartbeat silence limit.
- **Option B**: Keep the one-way heartbeat, treat stream death as a reconnect trigger rather than
  a session verdict.
- **Option C**: One client-initiated round trip, owned by the session rather than the connection,
  as the sole authority.

## Decision Outcome

Chose **Option C**.

The client pings, the host pongs, on the dedicated reliable lane ADR-0103 introduced. The
sequence number and the time of the last completed round trip live in the **session**, not in the
transport — so a ping may leave over one connection and its pong return over the next, and that
still counts as the session being alive.

This is the change that matters. Every previous design measured a property of the connection and
then reasoned from it to the session, and the two come apart at exactly the moment that matters:
during a handover the old connection is genuinely dead and the session is genuinely fine. Moving
the clock into the session removes the inference. A session that answers is alive no matter how
many connections it took to answer on; a session that does not answer is dead no matter how
healthy its socket looks.

Making it a round trip rather than a one-way beat restores what ADR-0103 gave up. A heartbeat
proves the host is running and sending. It does not prove the client can be reached, which is the
half that actually fails on a phone. Only an exchange tests both directions, and only the end
waiting for pixels is in a position to ask.

The host becomes a pure responder with no timer and no opinion. It never concludes a client is
gone from this lane, so there is no second verdict to reconcile — which is the structural fix, as
distinct from the tuning ones. Options A and B both leave two components able to end a session.

Link changes survive as a **hint**: they set a flag that sends the next ping immediately instead
of waiting out the interval. They can shorten the time to the truth. They can no longer be the
truth.

### Consequences

- Good, because one authority means a teardown has one cause and one place to read it.
- Good, because a reconnect is no longer self-confirming. The old arrangement could tear down a
  session, and the teardown itself produced the silence that justified the next one.
- Good, because the silence limit (6s against a 1s ping) can be generous where the datagram
  threshold had to stay short to avoid sitting on a dead session.
- Good, because `MediaSessionLoss` stops asserting which end broke. The two reasons it carried,
  `linkChanged` and `hostSilent`, were each produced by whichever detector fired first, and the
  measurement showed that attribution was wrong in 13 of 14 cases. `hostUnreachable` says only
  what is known, and the user-facing string stops naming the Mac as the culprit.
- Bad, because it adds an uplink packet per second where the heartbeat was downlink-only.
  Sixteen bytes each way, on a radio the 2Hz link-health report already keeps awake.
- Bad, because a session whose lane cannot be opened at all now has no liveness signal until one
  is. Bounded by the tracker seeding its clock at attach, so a host that accepts the stream and
  never answers is still caught.
- Neutral, because ADR-0090's resume and the encoder continuity it protects are untouched — they
  simply get exercised far less often.

### Confirmation

Deleted outright, not deprecated: `HandoverRecoveryPolicy` and its tests,
`LivenessProbePolicy` and its tests, the `livenessProbe`/`livenessEcho` control kinds and the
host's echo sender, `LivenessHeartbeat`, `ownedMediaHandoverGraceMs`,
`ownedMediaLivenessProbeIntervalMs`, `ownedMediaLivenessFailureThreshold`, and
`livenessHeartbeatIntervalMs`. `MediaSessionLoss.linkChanged` and `.hostSilent` are gone, so any
surviving reader of either fails to compile rather than silently taking a default.

`LivenessLaneTests` pins the frame (including the two malformed-length cases that would otherwise
present as a hung lane) and the policy's bounds.

On device the signal is `sessionUnreachable` replacing `handoverRecoveryDeclared` and
`livenessLaneSilent` in the client diagnostics, and its count against the measured baseline of
13-14 teardowns per session. The companion measure is host-side: `reusing media encoder` should
now be followed by neither `ltr-state-dropped` nor `encFrame=1 cause=first-frame`.

## Pros and Cons of the Options

### Option A: widen both thresholds

- Good, because it is a two-line change.
- Bad, because it leaves two detectors able to end a session and only makes each slower to be
  wrong.
- Bad, because every increment that tolerates more noise also delays acting on a real death.

### Option B: heartbeat, with stream death demoted to a reconnect trigger

- Good, because it keeps the simpler one-way protocol.
- Bad, because it still proves only that the host is sending, not that the client is reachable —
  and the downlink is the leg that was measured failing.
- Bad, because the clock still lives on the transport, so it still restarts on every reconnect.

### Option C: session-owned round trip

- Good, because it removes the inference from connection state to session state rather than
  tuning it.
- Good, because it collapses two authorities into one.
- Bad, because it touches the wire, both peers, and the client's failure presentation — the
  largest of the three changes.

## Links

- ADR-0089 handover recovery and liveness (superseded outright, both halves)
- ADR-0103 one-way heartbeat lane (superseded; its dedicated reliable lane is kept and reused)
- ADR-0030 a session outlives its connection (this makes the liveness clock obey that rule too)
- ADR-0090 resume the encoder and its references across a reconnect (the thing each false
  teardown was destroying)
