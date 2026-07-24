# TASKS: v9 freshness-first mobile media

`R<N>` = remaining. Flip to `D<N>` only after the complete slice has landed and its
tests are green. This ledger continues from R117 in the active v8 ledger without
changing that iteration's outstanding physical checkpoint.

## Position

This iteration makes owned-media video latest-frame-wins before tuning any adaptive
policy. ADR-0073 lands first because it changes ACK, resend, and recovery semantics.
Host accounting lands before client gap skipping so late ACKs cannot corrupt the
new admission state. The fixed 180 kbps / 1 fps / 0.5 profile and diagnostics land
after both transport sides expose the final counters. Physical validation remains a
human-gated final phase.

## v9 Phase 0: decision gate

- D118. Accept ADR-0073, supersede proposed ADR-0028, index the decision, and update
  `SPEC.md` so media ACKs bound accounting without blocking the latest capture.

## v9 Phase 1: host latest-frame admission

- R119. Extend `host/AgentDeskHost/GraphicsSendState.swift` with cumulative ACK
  retirement and explicit oldest-frame abandonment metadata, then replace
  backpressure retry in `QuicSessionHostMediaState.reserveUpdateId` with bounded
  abandonment while retaining capacity pacing.
- R120. Extend host backpressure and media-state tests to prove frame-cap and
  byte-cap abandonment, stale-ACK isolation, cumulative ACK retirement,
  abandoned-keyframe release, one-current-plus-one-latest capture ownership, and
  fixed-target stability.

## v9 Phase 2: nonblocking loss recovery

- R121. Replace the client repair deadline in
  `client/AgentDeskClient/OwnedMediaFrameRepairBuffer.swift` with opportunistic
  resend plus immediate gap skipping, and make the transport discard dependent
  deltas behind one coalesced keyframe request until a complete keyframe arrives.
- R122. Replace the host task-tail datagram sender with a serial burst scheduler that
  services one repair burst before the next live burst without allowing repair
  traffic to starve video.
- R123. Add deterministic client and host tests for repair-before-overtake,
  overtake-without-wait, late-packet rejection, keyframe-request coalescing,
  recovery-keyframe retry, and repair/live burst fairness.

## v9 Phase 3: fixed profile and evidence

- R124. Extend client manual settings to support 180 kbps and 1 fps, preserve 180
  through slider rounding, apply the 180 / 1 / 0.5 target atomically, and make
  client presentation summaries use the fixed target instead of the 30 fps ceiling.
- R125. Add bounded host and client freshness diagnostics for replaced captures,
  abandoned in-flight frames and bytes, served or missed resends, gap skips,
  discarded recovery deltas, keyframe recovery, pending depth, and presentation
  gaps, with focused schema tests.

## v9 Phase 4: verification and authorized device acceptance

- R126. Run targeted host and client tests plus `just check`, self-review the
  integrated diff, and confirm no tracked source or project file changed as a build
  side effect.
- R127. Stop at the device checkpoint; after explicit approval run
  `just motion-verify stable 1 60` with adaptive off and the fixed 180 kbps / 1 fps /
  0.5 profile, preserving paired host and attached-client evidence from the same
  run.

## Promotion log

```text
D118     2026-07-23  complete    ADR-0073 accepted; 582 host tests and full check green
R119-120 pending     pending     host latest-frame admission and accounting
R121-123 pending     pending     nonblocking client recovery and resend scheduling
R124-125 pending     pending     fixed profile and freshness evidence
R126     pending     pending     integrated compile, tests, and self-review
R127     checkpoint  pending     authorized physical mobile-data validation
```
