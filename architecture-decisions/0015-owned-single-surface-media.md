---
status: superseded by ADR-0021
date: 2026-06-19
supersedes:
  - ADR-0004
  - ADR-0012
  - ADR-0013
  - ADR-0014
---

# Owned single-surface media

## Context and Problem Statement

R25 testing showed that hardware VideoToolbox output is the right quality ceiling for AgentDesk, but carrying experimental media alternatives in the active source made every change branch through paths that were no longer being judged. The codebase now needs one current media architecture for `MediaStack`, `MediaTransport`, session-ready wire shape, datagram metadata, receiver repair, and current docs.

## Decision Drivers

- Rest-state text crispness remains non-negotiable.
- Input is already smooth through the dedicated WebSocket and should not move.
- The video path needs explicit control over encoded-frame timing, packet repair, late-frame skip, and keyframe recovery.
- Pre-v0 allows breaking wire changes, so compatibility scaffolding would add noise without protecting users.
- Current source and current docs must not expose removed media-mode branches.

## Considered Options

- **Keep the old media alternatives in source.** Preserve runtime branch points while the owned path continues to mature.
- **Keep a second visual surface for motion.** Retain separate surfaces and switch on scroll.
- **Promote owned QUIC plus VideoToolbox as the only media path.** Delete old runtime branches and use one encoded surface.
- **Jump directly to mixed graphics.** Add dirty regions, scroll-copy commands, or text/detail primitives now.

## Decision Outcome

Chose **owned QUIC plus VideoToolbox as the only media path** because the current bottleneck is packet recovery and render freshness inside the owned path, not session authentication, input, pairing, or runtime selection. `MediaStack` constructs the owned transport directly. `SessionReady` carries only the media capability and expiry. Encoded-frame envelopes carry codec, dimensions, timestamps, keyframe state, and parameter sets, but no surface identifier. `ADMD` datagrams use version 2 with a flags byte; bit 0 marks a keyframe. Packet repair is first resort, stale delta expiry is skipped, and keyframe fallback is reserved for incomplete keyframes, decoder failures, malformed packets, or authentication failures.

### Consequences

- Good, because the active runtime has one video composition path and one recovery policy to measure.
- Good, because old runtime branches cannot hide packet, decoder, or render-latency failures.
- Good, because input, pairing, auth, Keychain state, and Tailscale-only networking remain stable.
- Bad, because there is no library-owned media fallback if the owned path performs poorly.
- Bad, because AgentDesk now owns enough media transport behavior that pacing, repair, and congestion policy must stay observable.
- Neutral, because historical ADRs remain the record of why earlier paths existed.

### Confirmation

This decision is followed when:

- `MediaStack` constructs owned media directly.
- `SessionReady` has no media mode or surface list.
- `ADMD` datagrams decode only version 2 and keyframe state comes from flags.
- Client repair skips expired delta frames and requests keyframes only for keyframe loss or decoder continuity break.
- Active source and current docs have no old runtime media terms except historical ADRs and archived task ledgers.
- `just check` runs the guard before host and client builds.

## Pros and Cons of the Options

### Keep the old media alternatives in source

- Good, because reverting a feel regression would be faster.
- Bad, because active behavior keeps depending on removed branch points and tests defend obsolete seams.

### Keep a second visual surface for motion

- Good, because it previously separated rest quality from motion cadence.
- Bad, because scroll-driven switching created restore timing and gesture-state coupling that is not part of the current model.

### Promote owned QUIC plus VideoToolbox as the only media path

- Good, because it puts all measurement on the path that has the highest observed text-quality ceiling.
- Good, because it narrows current debugging to packet repair, stale-frame skip, decoder continuity, and render gap.
- Bad, because it accepts more owned transport responsibility.

### Jump directly to mixed graphics

- Good, because mixed graphics is likely the long-term ceiling for screen content.
- Bad, because it is too large before the one-surface full-frame path has produced clean packet and render evidence.

## Links

- ADR-0004: earlier media transport seam.
- ADR-0012: owned media control and reuse map.
- ADR-0013: single-surface datagram media experiment.
- ADR-0014: QUIC datagram carrier experiment.
- `SPEC.md`: current media stack, module boundaries, and owned-media wire shapes.
- `TASKS.md`: R26 owned single-surface cleanup ledger.
