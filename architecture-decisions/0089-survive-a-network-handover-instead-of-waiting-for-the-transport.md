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

### What R208 found: the report cannot survive the event it reports

The first device run of Phase 1 produced a real WiFi-to-cellular switch at 18:34:04, confirmed
in the telemetry itself (`client[iface=wifi]` at windowId 620, `client[iface=cellular]` at 622).
Every one of the 976 delivered reports said `linkChanges=0`, `pathChanges=0`, `radioChanges=0`.

The detector was not wrong; the counters never arrived. `flushLinkHealth` drained them and then
handed the report to `sendVideoControl`, which sends a **datagram** over the link being
described and discards the failure. Report loss across the session was 18 windows out of 1348
(1.3%), but **15 of those 18 fell inside the 36-second freeze** -- 18% loss there against 0.2%
at rest, a 76x concentration. The lost windows include 621, the transition itself.

This is not bad luck. The link change is the cause of the loss, so a delta counter is at its
most likely to be destroyed exactly when it finally has something to say. The reporting
mechanism was structurally incapable of reporting the event it existed for.

The fix is cumulative counters and sticky causes: `reportSnapshot()` replaces `drainForReport()`
on all three observers. A dropped report now costs latency rather than evidence -- the next
report that lands still carries the total, and the host recovers the change by diffing. The
per-window value the local console gate needs is still returned, but it never touches the wire,
so losing it costs a log line and nothing else.

Two secondary findings from the same run:

- **The host's degradation machinery works.** `reason=freeze`, four `stall-recovery`, six
  `no-ack-at-cap`, and a drop to rung 3. The stall detector fixed in `ef649c86` ran live for the
  first time and did not produce the calm-screen false positive it was fixed for. What is
  missing is a handover trigger, not stall awareness.
- **This freeze was one-directional, unlike the 16:53 incident.** 67 of 82 client reports still
  arrived during it while `datagramsReceived` stayed 0 throughout, so client-to-host worked and
  host-to-client did not. That is a genuine asymmetry rather than the earlier selection
  artifact, because it rests on 67 positive samples. It means a handover does not necessarily
  black-hole both directions, and Phase 2 can plausibly signal over the surviving uplink.

### The number, recovered from the client's own store

The measurement survived after all, because the client persists its diagnostics to disk and the
host can pull them on demand over the connection (`just client-diagnostics`) -- a path that
needs no WiFi and no privileged log collection. Exactly one record in 1845 carried the causes:

```
iface=cellular ... pathStatus=satisfied pathChanges=2 radio=HSDPA datagramsRecv=0
maxArrivalGapMs=746.8 linkChanges=2
linkCauses=interfaceType(wifi->cellular),localAddress(b2216da5->3c873047)
```

Recorded at 18:34:05, against a freeze that began at 18:34:04.4 and recovered on its own at
18:34:13.4. So:

- **Detection fired within one report window (~0.5s) of the freeze starting.**
- **The transport never fired at all.** The only `Network is down` in the entire host log is
  from session startup at 18:28:34. Through nine seconds of zero received datagrams the QUIC
  connection reported nothing, then traffic resumed. The 18-second figure from D203 was the
  transport's timeout on a session that died; here it simply never noticed.
- The host, meanwhile, received `linkChanges=0` in all 976 reports. Client knew at 18:34:05;
  host never knew.

That settles the Phase 2 trigger question in a way neither Option A nor B anticipated. The
transport is not merely slow to report a handover -- it may never report one, so a recovery path
waiting on transport failure can wait forever while the user watches a frozen screen. And
`sessionResumeTTL = 20s` is not the binding constraint it appeared to be: against ~0.5s
detection there is ample window.

Both live causes fired together on the same transition, which validates the address digest on
real hardware: `localAddress` caught it independently of `interfaceType`, so the 3G case that
`interfaceType` provably cannot see is covered.

The cost of the phase was one device run and a broken instrument found. Committing to a trigger
without it would have shipped a recovery path wired to a signal that is always zero.

### Phase 2: probe, then resume

With the measurement in hand the trigger is decided. A link change **arms** recovery; it does
not fire it. What fires it is a change followed by continued silence past a grace period.

Both halves of that are load-bearing. Firing on the change alone would tear down healthy
sessions on tailnet route switches, which were measured as transparent (magicsock re-selected
the path three times mid-session with no visible break) -- an explicit non-goal. Firing on
silence alone would reconnect a merely idle session, the same calm-screen false positive that
had to be fixed host-side in `clientLinkStalled`, and worse here because acting on it drops a
live session rather than mis-scoring a quality window.

The client cannot see the host's quiet period, so it does not try to infer one. On detecting a
change it sends a keyframe request, which obliges the host to produce a frame if the path
carries anything. The silence that follows is then an unanswered probe rather than ambiguous
quiet. That is what makes this probe-then-resume rather than silence-then-resume.

`HandoverRecoveryPolicy` holds the decision as a pure function so the discrimination is tested
in `just check` rather than only on a device. The grace is 2s
(`ownedMediaHandoverGraceMs`): four times faster than the measured freeze self-healed, still
long enough to let a real handover settle, and far inside the host's 20s resume window so the
resume material is still valid when the client dials.

The second half of Phase 2 is the re-dial, and without it the first half is a regression.
`handleMediaSessionFailed` leaves the client in `.pairedDisconnected`, and nothing moved it out
of there except `applicationWillEnterForeground`, `viewWillAppear`, or the user tapping Connect.
Declaring the session dead faster without re-dialing would replace "frozen for nine seconds,
then recovers" with "disconnected, tap Connect". So a non-rejection media failure now calls
`triggerSessionIfPaired` directly, which already owns the retry-with-delay loop and the
disconnect guards. This also closes the original gap: ADR-0030's resume machinery could never
run during a handover because the app never leaves the foreground.

Note this changes behaviour for the existing five-second-disconnected path too, not only for
handovers. That is deliberate and consistent with the arc: a media session that failed without
a rejection should re-dial rather than wait for a lifecycle event that may never arrive.

### Phase 3: liveness, because a link change is not the only way a session dies

The device run of Phase 2 (R212) confirmed the parts it was built for and then failed in a way
the design did not cover.

What worked: the host now receives
`linkChanges=2 linkCauses=interfaceType(wifi->cellular),localAddress(e6edecb9->3c873047)`, where
the previous run reported zero across all 976 windows, so cumulative counters carry the evidence
through the loss. Recovery armed on the change and tore the session down ~2s later, as designed.

What it cost: the black lasted about eleven seconds (19:06:24.4 to 19:06:35.4), and **9.5 of
those were the phone's cellular path simply not being usable yet**. Detection was never the
bottleneck for this switch; the radio was. Worse, for a freeze that would have self-healed --
like the 3G case in the previous run, back in nine seconds with session state intact -- tearing
down at 2s and re-dialing is a net loss: same radio delay, plus a handshake, plus a new session.

Then the real failure. At 19:07:08 and again at 19:08:04 the connection timed out with the link
completely stable. The host ended the session; the client never noticed and stayed `.connected`,
showing "Mac display unavailable" over a live-looking session. Because the client was not
`.pairedDisconnected`, `triggerSessionIfPaired` no-opped, the pairing screen never rendered, and
**force-quitting the app was the only way out** -- precisely the ADR-0030 symptom this arc set
out to remove, reached by a different route.

Phase 2 cannot catch that by construction: recovery is gated on a detected link change, and the
link never moved. The gate is not wrong, but it is too narrow.

**The trigger should be an unanswered probe, not a link change.** A probe obliges the host to
send something regardless of screen activity, so an unanswered one is evidence the path is dead
whatever the cause. A link change then becomes a reason to probe early rather than the only
reason to probe at all, and the `stall` cause deferred in Phase 1 stops needing the host's quiet
period -- the probe answers that question locally.

Two measurements constrain how:

- **A healthy idle session legitimately receives nothing for a long time.** The carrier keepalive
  is client-to-host only, so with a static screen the host sends nothing. R212 recorded healthy
  windows with arrival gaps up to 12.4s. Any "silent for N seconds" rule with N below that is a
  false-positive generator, which is why the probe rather than the silence has to be the
  evidence.
- **The probe must be cheap.** Phase 2 probes with a keyframe request, which is correct for a
  handover (about one per switch) and unaffordable as a liveness poll: keyframes ran ~244KB in
  this session, so polling an idle session would burn megabytes to prove nothing changed.

So Phase 3 adds a small liveness exchange -- a control datagram the host echoes with a minimal
reply -- and drives recovery from an unanswered echo. That is the piece of wire work Phase 2
avoided by borrowing the keyframe request, and the case that broke here is what makes it
necessary. Sizing (probe interval, unanswered count before recovery) belongs to that phase and
should be set against the same 12.4s healthy-gap ceiling measured here.

Until it lands, `captureUnavailable` shows a **Reconnect** button. It is deliberately a
backstop, not the fix: any recovery path can have a case it does not cover, and when that
happens the user must not be left holding a dead screen with nothing to tap. The label also
stopped claiming "Input stays connected", which R212 proved false -- the session was gone.

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
