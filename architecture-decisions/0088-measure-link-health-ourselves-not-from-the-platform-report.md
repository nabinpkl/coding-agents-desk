---
status: accepted
date: 2026-07-31
---

# Measure link health from our own ack loop, not the platform data-transfer report

## Context and Problem Statement

Video freezes reproduce on cellular and not on WiFi. Host logs cannot tell a stalled path
from a stalled client, and the quality ladder in `MediaQualityController` measures loss only
(completed vs expired frames), so a path that *delays* rather than *drops* is invisible to
it: a frame that arrives 12s late still counts as completed. A measured freeze showed 49
frames completing in a single 500ms window after a 12.79s stall, meaning every packet
arrived. That is queueing, not loss, and nothing in the current telemetry can see it.

This ADR records what platform link metadata is actually usable, after measuring it, and
where the transport-quality signal comes from instead. Scope: `OwnedMediaTransport` on both
sides, `MediaQualityController`, and the `.linkHealth` control message in
`packages/AgentDeskWire/Sources/AgentDeskWire/OwnedMedia.swift`.

## Decision Drivers

- The signal must distinguish queueing, loss, path outage, radio handover, and a starved
  client receive loop. Those have different fixes and currently look identical.
- It must not require migrating the media transport off `NetworkConnection<QUIC>`.
- It must cost close to nothing in a healthy session, and must not perturb the decode path
  it is measuring.
- Availability must be verified against the SDK, not assumed. Two earlier planning rounds in
  this arc asserted API facts that turned out to be wrong in both directions.

## Considered Options

- **Option A**: sample `NetworkConnection.dataTransferReport()` per window for smoothed and
  minimum RTT, retransmitted bytes, and radio type.
- **Option B**: migrate the media connection to legacy `NWConnection` to get the windowed
  `startDataTransferReport()` / `collect()` pair that does populate those fields.
- **Option C**: derive round-trip statistics from the frame-ack loop we already run, and take
  path and radio metadata from `NWPathMonitor` and CoreTelephony.

## Decision Outcome

Chose **Option C**.

Option A was measured and does not work. A loopback QUIC harness
(`r195gate`, throwaway) called `dataTransferReport()` after 50 and again after 250 datagrams.
Both returned `duration: 0.0` with every field zero: smoothed RTT, minimum RTT, retransmitted
bytes, packet counts, application bytes. The `async` form creates and collects the report in
one call, so it captures a zero-length window and reports nothing. This is not a loopback
artifact and not a QUIC limitation: the legacy windowed API over the **same** loopback QUIC
connection returned `duration: 0.311`, `smoothedRTT 0.003`, `sentApplicationByteCount 250000`
(exactly the 250 x 1000 bytes sent). The metrics exist; the streamlined call cannot reach them.

Option B would reach them, but it trades the whole session transport for a diagnostic, and a
second connection opened purely to measure would traverse a different flow and measure the
wrong thing. The "must not require migrating the transport" driver knocks it out.

Option C is better than a workaround. `noteAck` in `MediaQualityController` already returns
each acked frame's send timestamp, so we already hold true round-trip samples for the traffic
we actually care about. Application-level RTT includes our own queueing and the client's
processing, which transport RTT excludes; for diagnosing *our* freeze it is the more relevant
number. The bufferbloat test is unchanged in form: smoothed RTT rising while minimum RTT stays
flat means the path is queueing. What the host lacked was not samples but a persistent
minimum baseline to compare against, since it only kept per-window p50/p95/max.

### Consequences

- Good, because the queueing signal needs no new platform API, no transport migration, and no
  new network traffic. It is arithmetic over samples we already collect.
- Good, because path metadata via `NWPathMonitor` gives `status`, `unsatisfiedReason`,
  interface type, `isExpensive`, `isConstrained`, `isUltraConstrained`, and `linkQuality` on
  both platforms, all edge-triggered and free when nothing changes.
- Neutral, and worth recording so it is not re-attempted: `NetworkConnection` does have
  `onPathUpdate`, `onViabilityUpdate`, and `onBetterPathUpdate`, but they are declared in an
  extension constrained to `ApplicationProtocol: OneToOneProtocol`, and **QUIC does not
  conform**. There is no per-connection viability callback available to us at all. The
  process-level monitor carries the same `NWPath`; `connection.currentPath` is available and
  is polled separately, and it can disagree with the monitor (the gate harness saw
  `linkQuality=good` from the monitor and `unknown` from `currentPath` in the same instant),
  which is itself a reason to record both rather than pick one.
- Bad, because we lose retransmitted and out-of-order byte counts, which would have separated
  loss from queueing directly. We infer loss from our own expired-frame counters instead,
  which is coarser.
- Bad, because application RTT conflates network delay with client-side processing delay. That
  is acceptable here only because a starved client receive loop is separately instrumented
  (datagram inter-arrival gap), so the two can still be told apart.
- Bad, and worse than expected: the first device run measured **inflation up to 17.5x on a
  healthy WiFi link with no freeze at all** (91.0ms smoothed against a 5.2ms floor), across 463
  windows. At the low frame rates a calm screen produces, the ack age is dominated by the
  client's own scheduling rather than by path queueing, so the ratio swings wildly while
  nothing is wrong. **`rttInflation` must therefore never be wired into the ladder as an
  absolute threshold** -- any cutoff low enough to catch a real freeze fires continuously on
  WiFi. It is a diagnostic to be read alongside `datagramsRecv` and the send counts, and if it
  is ever promoted to a signal it needs gating on sustained send volume first. This is the
  measured form of the risk noted directly above; recording the number so it is not
  re-discovered.
- Neutral, because `establishmentReport()` on the new API *does* work (`duration: 0.028`,
  `handshakes: 1`) and is kept as a one-shot per session.
- Good, because presentation waste now reports too. The client's pacer decodes every frame
  (HEVC deltas need the reference chain) but presents only the newest per fps interval, so a
  recovery burst is decoded and discarded: the 12.79s freeze released 49 frames into one
  500ms window, where the pacer could present at most one per fps interval (so roughly
  44-48 of them were decoded and thrown away, depending on where the stream was pinned --
  the exact pin for that session was never recorded, which is itself part of the problem).
  That count existed only in the client's own
  diagnostics store, which keeps three runs, so by the time the question was asked the
  answer had been evicted. It rides the link-health window now, and it is the number that
  would justify the host declining to send while the client is behind.

### The stall detector needs a send gate

The first device run also caught a regression this ADR's own work introduced.
`clientLinkStalled` treated "zero datagrams arrived and the gap exceeds one report interval"
as a stall. On a calm screen the host sends nothing, so the client receives nothing and
reports exactly that shape: **27 of the session's windows matched it on a healthy, satisfied
WiFi path with nothing in flight.** Counting those as stalls withholds the idle recovery
credit that lets the ladder climb back after a downgrade, which is the precise failure the
idle branch exists to prevent -- and which the function's own doc comment warned about for the
completed-frame version of the same mistake.

Gap magnitude alone cannot fix it, because a user who walks away from the Mac produces an
arbitrarily long gap for the same innocent reason. Nor can a per-window "did we send"
counter: several windows into a freeze the host has stopped producing and every tracking
entry has cleared, so the window that most needs to be recognised as stalled is the one where
the host looks idle too.

The detector now asks a comparative question instead of an absolute one: **is the client's
silence longer than our own?** The arrivals clause fires only when the reported gap exceeds
the host's quiet period (time since the last frame reached the carrier) by more than a report
interval. If we were sending while they heard nothing, the link ate it; if we were equally
quiet, there was nothing to hear. The path clause keeps no gate, because an unsatisfied path
is real evidence whether or not we were sending.

The pre-existing synthetic test passed throughout, because it modelled a calm screen as one
still receiving datagrams (`datagramsReceived: 12`) -- an assumption the device falsified.

### Confirmation

`AckRoundTripTrackerTests` asserts that a step change in sample RTT moves smoothed RTT while
minimum RTT holds, and that the minimum can rise again after its window ages out. The
`.linkHealth` message carries the telemetry, so a device run on cellular shows both ends in the
host log; a freeze with flat minimum RTT, climbing smoothed RTT, and a live datagram arrival
counter is queueing, and a freeze with a stalled arrival counter is not.

## Pros and Cons of the Options

### Option A: platform data-transfer report on the new API

- Good, because it would have been a few lines and needed no new state.
- Bad, because it returns all zeros. Measured, twice, against a working legacy control.

### Option B: migrate media to legacy `NWConnection`

- Good, because the windowed report demonstrably works and carries retransmission counts and
  `radioType` that Option C cannot.
- Bad, because it reverses the transport modernisation for a diagnostic, and a
  measurement-only second connection would measure a different path.

## Links

- ADR-0027 congestion-adaptive video (the loss-only ladder this extends)
- ADR-0073 freshness-first owned media
- ADR-0087 stall recovery is transport, not quality policy
- Verified against the iOS 26.5 / macOS 26 SDK on 2026-07-31 by compiled harness, not docs.
