---
status: accepted
date: 2026-08-16
supersedes: ADR-0089 (its liveness-probe mechanism only; handover detection is unchanged)
---

# Liveness rides its own reliable lane

## Context and Problem Statement

ADR-0089 gave the client two ways to conclude the host was gone: a handover watch armed by a link change, and a liveness probe for a session that dies with the link stable. The probe was a client datagram answered by a host echo, both on `QUIC.Datagrams` — which Apple documents as connection-wide, one flow per connection, shared with every video packet. Three consecutive unanswered probes declared the host dead and tore the session down, costing a full IDR and an LTR reset each time.

Device measurement showed the mechanism producing the failures it existed to detect. Affects `QuicStreamFrame.swift`, a new `LivenessLane.swift`, `PairingSignalingServer.swift`, `SessionDialer.swift`, and both `OwnedMediaTransport.swift` files.

## Decision Drivers

- A teardown must follow evidence the host is gone, not evidence that a packet was lost.
- The signal must not compete with the traffic it is reporting on. Video is bulk; liveness is a few bytes.
- It must ride out the stalls this link actually produces, measured at 2-3s and self-healing, without sitting on a genuinely dead session.
- Timeliness matters as much as delivery: a reply that arrives after the verdict is as useless as one that never arrives.

## Considered Options

- **Option A**: Keep probe/echo on datagrams, raise the threshold from 3 to ~5.
- **Option B**: Send each echo two or three times for redundancy.
- **Option C**: Move liveness to a dedicated reliable QUIC stream, one-way host-to-client.

## Decision Outcome

Chose **Option C**.

The measurement is unambiguous about where the failure was. Over one session the host logged **187 liveness probes received and 187 echoes sent, with zero send failures** — it answered every probe it was asked. The client received **108 of 175** replies. Meanwhile the uplink, carrying nothing but tiny control messages, delivered **187 of 187**. The downlink carrying video lost 38% of the replies. Thirteen of fourteen session failures that night were `hostSilent`; the fourteenth was a genuine Wi-Fi to cellular handover declared dead at 2,098ms against a 2,000ms grace, missing by 98 milliseconds.

So the host was never silent. Our own video was crowding out the evidence that it was alive, and the client was acting on the absence.

Options A and B both keep a lossy channel and argue about how much loss to tolerate. They reduce the false-positive rate without changing its cause, and every threshold that tolerates more loss also delays a real death.

A dedicated QUIC stream removes the cause. Streams do not head-of-line block one another — that is QUIC's central improvement over TCP — so a heartbeat cannot queue behind the 62KB crisp chunks measured on the graphics lane, and being a stream rather than a datagram it is retransmitted rather than dropped. This is the same reasoning that already separates the `assets` lane from `voice` ("a 152MB model moving down the same lane as speech would stall it"), so it extends an established pattern rather than introducing one.

Making it one-way host-to-client removes the leg that was failing. The old design required both directions to survive; a heartbeat requires only the direction that carries the answer.

### Consequences

- Good, because loss stops being a cause of teardowns: silence on this lane now means the path is genuinely not moving, which is the only thing worth acting on.
- Good, because the silence limit can be generous (6s against a 1s beat, so five may be missed) where the old threshold had to stay short to avoid sitting on a dead session.
- Good, because it deletes a round trip. A heartbeat needs no reply, so there is no second leg to lose.
- Good, because a stream that errors is *positive* evidence of death, which silence never was.
- Bad, because it adds a stream and a small constant traffic cost (16 bytes/second) to every session, including idle ones.
- Neutral, because handover detection is untouched. ADR-0089's link-change watch still owns that case; only the probe is replaced.

### Confirmation

`livenessProbe`/`livenessEcho` no longer drive anything: the client's probe sender and echo handler are deleted, and the host's echo path is unused. `LivenessLaneTests` pins the frame and the policy, including that the silence limit rides out 3s and acts on 9s. On device, `livenessLaneSilent` replacing `livenessRecoveryDeclared` in the client diagnostics is the signal, and its count against the old 13-per-session baseline is the measure.

## Pros and Cons of the Options

### Option A: raise the datagram threshold

- Good, because it is a one-line change.
- Bad, because it does not address why replies are lost, and the loss rate rises exactly when the link is worst.
- Bad, because every increment that tolerates more loss also delays detecting a real death.

### Option B: send redundant echoes

- Good, because independent drops make three-in-a-row much rarer, for a few bytes.
- Bad, because it still competes for the same congestion window, so redundancy fails hardest precisely when it is needed.

### Option C: dedicated reliable lane

- Good, because it removes the cause rather than reducing the symptom.
- Good, because the lane pattern, the stream budget (16), and the announce convention already exist.
- Bad, because it touches the wire, both peers, and the dialer — the largest of the three changes.

## Links

- ADR-0089 handover recovery and liveness (this replaces its probe; its handover watch stands)
- ADR-0025 datagram carrier (why video is on datagrams, which remains correct)
- [Network: QUIC datagrams are connection-wide](https://developer.apple.com/documentation/network/networkconnection/datagrams) (no date verifiable)
