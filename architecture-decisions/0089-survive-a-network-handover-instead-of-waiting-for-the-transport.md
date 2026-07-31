---
status: accepted
date: 2026-07-31
---

# Survive a network handover instead of waiting for the transport to notice

## Context and Problem Statement

A phone that changes network freezes for ~18 seconds and then re-establishes from scratch.
Measured on device: WiFi to cellular at 16:53:29 produced zero received datagrams while the
host kept sending 622 frames at 2170kbps, `ackCount=0` for twenty consecutive windows, and the
session ended in a teardown (`windowId` 1949 -> 1) rather than a resume. The host's QUIC
connection reported nothing at all until 16:53:47, when it emitted
`waiting(POSIXErrorCode 50: Network is down)`.

The same failure has at least two more triggers. A 5G-to-3G radio transition re-assigns the
phone's address (`2001:56b:3ffa:...` -> `2001:56b:3ff3:...`) and freezes identically, which the
user described as "froze, then after a while it worked" -- the "while" being the transport's
timeout, not the radio recovering.

ADR-0030 already identified this exact symptom ("that makes Wi-Fi/cellular switching require
closing and reopening the iPhone app") and built the machinery to survive it: `SessionRegistry`
has `.suspended` / `.resuming`, resume tokens carry an expiry, and `PairingClient` holds
`pendingResume` and can call `dialer.resume(...)`. Its confirmation criterion was
`session suspended -> resuming -> connected` during a Wi-Fi/cellular switch.

That criterion has never been met, and could not have been. Two reasons, both measured:

- **Nothing could detect the switch.** `git grep NWPathMonitor` at `b734e5e9~1` returns nothing:
  before ADR-0088's telemetry landed, the codebase had no network-path awareness at all. Resume
  was wired to `applicationWillEnterForeground` and to the media channel reporting `.failed`.
  During a network change the app never leaves the foreground, so the only live trigger is the
  transport's own failure report -- the 18 seconds.
- **The resume window is shorter than the detection latency.** `Config.sessionResumeTTL` is 20
  seconds. Detection takes 18. Even when resume fires, it fires with two seconds of window left.

So the recovery path is sound and the trigger is missing. This ADR covers how the trigger gets
chosen. Scope: `LinkChangeDetector` and `LinkPathObserver` in `packages/AgentDeskWire`,
`RadioAccessObserver` and `OwnedMediaTransport` on the client, and later the resume path in
`PairingClient` / `SessionRegistry`.

## Decision Drivers

- Recovery must not be gated on the transport admitting failure. 18 seconds is the measurement,
  not an estimate.
- The trigger must catch an address change that leaves the interface type unchanged, because
  that is the 3G case and the obvious `interfaceType` watcher misses it entirely.
- It must not tear down a healthy connection on ordinary path churn. Tailnet route changes
  (direct <-> DERP) happen routinely and do not break us; reacting to them would be a
  regression.
- The choice of trigger must come from a device measurement. Two prior rounds in this arc
  asserted mechanisms that the data then contradicted.

## Considered Options

- **Option A**: trigger recovery on `NWPathMonitor` interface-type changes.
- **Option B**: trigger on our own stall evidence (client datagram arrival gap exceeding the
  host's quiet period).
- **Option C**: instrument every candidate signal first, act on none, and pick the trigger from
  what a device run shows.

## Decision Outcome

Chose **Option C** for this phase, with A and B as the candidates it is measuring.

Option A alone is provably insufficient: a 5G-to-3G transition keeps `interfaceType == cellular`
and `pathStatus == satisfied`, so the `NWPath` snapshot before and after is identical. The
signal that catches it is the local address, which no existing observer reads.

Option B is the most general -- it caught the measured freeze at ~1.6 seconds, roughly 16
seconds before the transport reported anything, and it works even when the platform never
reports the change at all. But it is a lagging signal by construction: it cannot fire until
traffic has already been lost, where a path event can fire at the instant of the change.

The two are complementary rather than competing, and their relative latency on a real handover
is unknown. Committing to one now would repeat the mistake that produced a resume path wired to
a lifecycle event that cannot fire during the failure it was meant to handle. So Phase 1 ships
detection with no action, and Phase 2 picks the trigger from the numbers.

`LinkChangeDetector` fuses five causes and reports which fired, on the existing `.linkHealth`
message so they arrive correlated with the frame counts and RTT already there:

| cause | catches | misses |
|---|---|---|
| `interfaceType` | WiFi <-> cellular | cellular address change |
| `localAddress` | any address change, incl. 5G -> 3G | nothing observed so far |
| `pathStatus` | outright connectivity loss | changes that keep the path satisfied |
| `radioAccess` | radio handover preceding an address change | non-cellular changes |
| `stall` | anything, including silent black holes | cannot fire before traffic is lost |

The address signal is a digest, not the addresses: enough to prove the link moved, without
putting the device's addresses into a log that gets pasted into issues. Link-local and loopback
are excluded because they are per-interface and carry no routing meaning; the tailnet address is
deliberately kept, because it is stable across the route switches that do *not* break us and so
acts as a control.

**Four of the five are live on the client in this phase.** `stall` is defined and tested but
unfed, because the comparison that makes it trustworthy -- client silence measured against the
host's own quiet period -- needs a number only the host has. Feeding it client-side from the
arrival gap alone would reintroduce exactly the false positive fixed in `ef649c86`, where a calm
screen reads as a stall. The host already evaluates it correctly in
`MediaQualityController.clientLinkStalled`, and the arrival gap it uses is already on the wire,
so the signal is measurable in this phase even though it does not flow through the detector.
Wiring it there belongs with the host-side liveness work in Phase 3.

### Consequences

- Good, because Phase 1 cannot regress anything: it observes and reports, and every input is
  edge-triggered, so a stable link costs one `getifaddrs` per report window.
- Good, because it settles empirically whether the QUIC connection survives a tunnel
  re-establish. The tailnet addresses are stable across a handover, so the connection may
  survive where the sockets beneath it do not; that determines whether Phase 2 needs a full
  re-dial or merely a probe.
- Good, because the four switch classes are now distinguished rather than merged. Route
  switches (tailnet direct <-> DERP) were measured as transparent -- magicsock re-selected the
  path three times mid-session with no break -- so reacting to them is a known non-goal.
- Bad, because it adds a wire field pair and a per-window syscall for something that takes no
  action yet. Accepted: the alternative is choosing a trigger from inference, which this arc has
  already shown to be expensive.
- Neutral, and to be resolved by the measurement: `sessionResumeTTL = 20` is almost certainly
  wrong once detection drops to ~2s, but the right value depends on the worst observed reconnect
  time, which Phase 1 supplies.

### Confirmation

`LinkChangeDetectorTests` pins the discrimination the measurement depends on: an address change
is caught when the path snapshot is byte-identical, an unmoved path reports nothing, the first
observation of each signal is a baseline rather than a transition, and one handover firing
several causes reports all of them rather than collapsing to a generic "changed".

The device confirmation is a real WiFi-to-cellular toggle showing `linkCauses=` in the host log
with a cause that precedes the transport's `Network is down` by a useful margin. Phases 2-4
(probe-then-resume, host-side liveness suspend, TTL retune) are gated on that number.

## Pros and Cons of the Options

### Option A: interface-type trigger

- Good, because it is the simplest possible change and fires at the instant of the change.
- Bad, because it cannot see the 3G case at all, which is half the reproduced freezes.

### Option B: stall-evidence trigger

- Good, because it is universal: it caught the measured freeze 16 seconds before the transport,
  and needs no platform cooperation.
- Bad, because it is inherently reactive -- it requires traffic to have already been lost, so it
  can never be as fast as a path event for the cases a path event covers.

### Option C: measure first, act second

- Good, because the trigger gets chosen from device data rather than from a plausible story.
- Bad, because it costs a release cycle before anything improves for the user.

## Links

- ADR-0030 single QUIC session transport (built the resume path this will finally trigger)
- ADR-0088 measure link health ourselves (added the first path awareness in the codebase)
- ADR-0087 stall recovery is transport, not quality policy
