---
status: accepted
date: 2026-07-30
refines:
  - ADR-0033
  - ADR-0073
---

# Stall recovery is a transport concern, not quality policy

## Context and Problem Statement

Four measured device sessions on 2026-07-30 split cleanly in two. Two were clean; two froze
for 42.1s and 44.2s of wall clock in stalls of 1.5-12.8 seconds, abandoning 240 and 323
frames. All four ran with the phone's adaptive quality switch OFF, pinned to 2600kbps /
15fps / 0.5 scale. A fifth session with the switch ON, on the same link minutes after the
worst manual one, abandoned 11 frames and froze once for 1.6s.

The freezes are not a bandwidth failure. Across all 1,882 quality windows that day the
client reported **three** lost frames and three resend requests, none of them during a
stall. Each stall has the same shape: the client goes silent (`ackCount=0`, no link-health
reports), the host keeps producing and sending throughout, and then the client reports a
burst of completed frames — 49 in one 0.5s window after the 12.79s stall, 27 after a 2.1s
one. The datagrams arrived. The client processed them late, all at once.

What made the manual sessions worse than the adaptive one was not the pinned numbers: the
client's manual floor (180kbps / 1fps / 33%, `SettingsStore.manualMediaBitrateKbpsRange`) is
*below* the adaptive ladder's own emergency rung. It was that three separate recovery
mechanisms in `MediaQualityController`, `QuicSessionHostMediaState`, and
`QuicSessionHostMediaTransport` were reachable only through a rung change, which a pinned
target never makes.

## Decision Drivers

- ADR-0033 already requires that "the same controller derives the logged pressure classes
  and the policy decision, so diagnostics cannot drift from behavior". The manual branch of
  `observeLinkHealth` violated it directly, hand-building signals with `lossPressure`,
  `queuePressure`, `cadencePressure`, and `freezePressure` hardcoded `false`.
- ADR-0033 also says a client may disable the ladder "while leaving packet repair and
  backpressure active". Backpressure that can jam and never unjam is not active in any
  useful sense.
- ADR-0073's client recovery contract is that the client "keeps the last displayed image,
  and waits for one coalesced keyframe". A contract that instructs the client to wait needs
  the wait to be bounded.
- ADR-0073's stated first validation profile is 180kbps / **1fps** / 0.5 scale with adaptive
  disabled. That profile must be able to recover.
- Recovery must not itself be able to sink the link. Measured keyframes are 47-89KB at the
  low rungs and ~165KB at 0.5 scale, against a link the adaptive session measured at
  300-650kbps.

## Considered Options

- **Option A**: Lower the client's manual presets and document a recommended pin.
- **Option B**: Remove manual mode, or make it a floor the ladder can still descend below.
- **Option C**: Separate stall recovery from the quality ladder so it runs in both modes.

## Decision Outcome

Chose **Option C**. Option A is rejected because the manual floor was already lower than
adaptive's emergency rung, so no preset reachable in the UI would have helped; the target
numbers were never the difference. Option B is rejected because it removes a user control to
work around a host defect, and because the same three mechanisms were also unreachable in
adaptive whenever the rung *held* — Option C fixes both modes, Option B only masks one.

Stall recovery is transport behavior. It runs on every quality window in both modes:

- **Signals are always derived by the controller.** `MediaQualityController.makeSignals` is
  internal and both branches call it. A manual pin means the target does not move; it never
  meant the host stops looking.
- **A stalled window flushes the in-flight accounting.** Once the cap fills,
  `abandonUntilCanProduce` drops exactly one entry per produced frame, so it stays full, and
  every subsequent ACK lands on an entry already abandoned — which `noteAck` correctly
  discards, taking the ACK-age telemetry with it. The flush restores admission and lets the
  next real ACK be measured. It costs nothing on the wire, so it is not rate-limited.
- **A stalled window forces one keyframe, rate-limited.** This is the expensive half, and it
  is spaced by `ownedMediaStallRecoveryMinIntervalMs` (5s) and suppressed while a keyframe
  is already in flight, so a genuinely dead link cannot be driven into a keyframe storm by
  its own stall signal.
- **The GOP gains a wall-clock ceiling.** `ownedMediaKeyframeIntervalFrames` (120) is
  unbounded in time on a change-driven capture: the manual sessions produced 4-6fps, making
  it ~21s, and ADR-0073's 1fps profile makes it two minutes.
  `ownedMediaKeyframeMaxIntervalMs` (15s) bounds it. Whichever interval comes first wins, so
  at 15fps and above the frame count still governs and the ceiling never fires. 15s and not
  less is the bandwidth arithmetic above: a 5s ceiling would spend 142-264kbps on keyframes
  alone.
- **The host raises its own window when the client goes quiet.** `observeLinkHealth` was
  reachable only from `handleLinkHealth`, driven by inbound client messages, so the one
  event the governor most needs to see is the event that stops it being called: during the
  12.79s freeze not one window was evaluated. A timer raises a synthetic window after
  `ownedMediaLinkHealthTickMs` (1s) of client silence.

This reverses one ADR-0033 decision driver, which read: "Stale host in-flight recovery is
not decoder recovery. It reopens admission and feeds quality pressure, but it does not force
a keyframe by itself." That was written when a spurious keyframe was the risk being managed.
The evidence since is that in manual mode there is no other keyframe path inside 20+
seconds, so the client is told to wait for a sync point that the encoder has not been asked
to produce. Stale recovery now does force a keyframe, rate-limited.

A synthetic window is marked `clientReportMissing` and cannot earn recovery credit. A calm
screen and a silent client produce the identical zero-frame window, and only the first is
evidence of a healthy link; without the distinction the ladder would climb into a stall.

### Consequences

- Good, because a manually pinned stream — including ADR-0073's own 1fps validation profile
  — can now recover from a stall, and the worst-case wait for a sync point is bounded at 15s
  instead of two minutes.
- Good, because the manual-mode `mediaQualityWindow` log stops reporting four pressure
  classes as false regardless of the link. Those lines were previously unusable for
  diagnosis, which is why the first pass over the freeze logs read the manual sessions as
  calm.
- Good, because adaptive also recovers when the rung holds, which it previously could not.
- Bad, because recovery keyframes cost bandwidth on exactly the link least able to afford
  them. The 5s floor and the in-flight suppression bound this, but the floor is a guess
  calibrated from one day of measurements and wants device tuning.
- Bad, because the wall-clock GOP ceiling raises rest-bandwidth on genuinely slow streams,
  where the keyframe already dominates: the manual sessions spent ~63kbps on keyframes
  against ~38kbps of payload.
- Neutral, because the host now evaluates quality windows without the client, so window IDs
  no longer count client reports one-for-one.

### Confirmation

`MediaStallRecoveryTests` covers each half: that a manual pin derives real `lossPressure` and
`queuePressure` while leaving its target unmoved, that a jammed in-flight list is flushed and
reopened, that the second keyframe inside the rate-limit window is withheld while its flush
still runs, that a healthy window recovers nothing, that adaptive recovers without a rung
change, and that a host-raised idle window earns no recovery credit where a client-reported
one does. The GOP ceiling is asserted against a 1fps stream, which is only testable because
the decision is a pure function on `OwnedMediaEncodingConfiguration`.

The runtime signal is `owned media stall recovery` in the `owned-media` log category,
carrying the reason, the flushed frame and byte counts, and whether the keyframe was forced
or withheld.

## Pros and Cons of the Options

### Option A

- Good, because it ships without touching the host.
- Bad, because the manual floor was already below adaptive's emergency rung, so it addresses
  a cause the measurements rule out.

### Option B

- Good, because one code path is simpler than two.
- Bad, because it deletes a user control to avoid fixing a host defect, and leaves adaptive
  unable to recover on a held rung.

### Option C

- Good, because it fixes both modes, and separates two concerns that were only ever coupled
  by implementation accident.
- Bad, because it adds a timer and a rate limit, both of which need device tuning.

## Links

- ADR-0033 adaptive media quality ladder
- ADR-0073 freshness-first owned media
- ADR-0021 damage-driven retained graphics (the in-flight cap this flushes)
