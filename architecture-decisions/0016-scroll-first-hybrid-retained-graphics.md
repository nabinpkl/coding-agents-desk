---
status: superseded by ADR-0021
date: 2026-06-20
supersedes: ADR-0015
scope: codex/scroll-hybrid-retained-graphics branch
---

# Scroll-first hybrid retained graphics

## Context and Problem Statement

ADR-0015 made owned QUIC plus VideoToolbox the only active media path after the packet-repair and render-freshness work narrowed the system to one encoded surface. R27 keeps that HEVC path because it is still the best observed rest-state text-quality ceiling, but scroll-like text motion is where full-frame HEVC has the highest cost and weakest feel. This worktree needs a branch-local architecture that adds retained graphics for scroll motion without reopening the old runtime media-mode branches.

This ADR supersedes ADR-0015 inside the `codex/scroll-hybrid-retained-graphics` branch and worktree. ADR-0015 remains the accepted historical record for the owned single-surface media baseline, and its conclusions are not edited.

## Decision Drivers

- Rest-state text crispness still depends on hardware HEVC full-frame refreshes.
- The first retained-graphics slice must solve scroll motion before attempting full mixed graphics.
- HEVC refreshes and graphics commands need one deterministic visual ordering model.
- Reset semantics must prevent stale or same-generation graphics state from replacing newer committed output.
- Transport must keep the existing media datagram channel alive while adding reliable graphics delivery.
- R27.2 already chose a second configured graphics port over same-port Network.framework ALPN routing.
- Correctness must be measurable before optimizing the retained compositor.

## Considered Options

- **Keep ADR-0015 unchanged as the active architecture.** Continue with HEVC-only owned media.
- **Implement full Microsoft-style mixed mode now.** Add broad dirty-region classification, text/image/video region decisions, region HEVC, and codec tiles.
- **Use scroll-first hybrid retained graphics.** Keep HEVC as the full-frame hardware refresh path and add reliable retained graphics commands only for accepted scroll motion.
- **Use same-port ALPN routing for graphics.** Route graphics and media on one listener through Network.framework protocol selection.

## Decision Outcome

Chose **scroll-first hybrid retained graphics** for this worktree. HEVC remains a first-class full-frame hardware refresh path for initial, rest, scroll-correctness, and reset refreshes. Retained graphics is scroll-first instead of full Microsoft mixed mode: graphics commands mutate one retained surface, and the branch does not add full text/image/video classification, region HEVC, or codec atlas behavior in this slice.

All visual updates use lexicographic `(surfaceGeneration, frameId)` ordering only. `capturedAtUptimeNs` is diagnostics only and never participates in ordering. `resetSurface` accepts only a strictly newer `surfaceGeneration`, then initializes committed order to `(surfaceGeneration, 0)` before reset tiles apply. For this slice, all retained-surface mutations serialize through `@MainActor OwnedSurfaceCompositor`.

Graphics uses a sibling reliable QUIC channel with the same TLS identity as owned media and an explicit hello/ready nonce handshake. The channel uses `AGENTDESK_GRAPHICS_PORT`, default `41889`, because R27.2 selected a second configured graphics port over same-port ALPN routing.

Accepted scroll suppresses HEVC full-frame refreshes during active scroll by default and sends one HEVC rest refresh after 250 ms idle. An env-tunable scroll correctness cadence can be added later if logs show that accepted scroll needs periodic HEVC correction. Scroll detection has a 4 ms per-frame budget; timeout emits no graphics commands and falls back to HEVC for that frame. The timeout acceptance target is under 20 percent of scroll frames. MainActor compositor cost is a likely bottleneck and must be diagnosed before moving work off the main actor.

### Consequences

- Good, because the branch preserves the known HEVC quality ceiling while testing whether scroll-copy retained graphics improves motion feel.
- Good, because one retained surface and one lexicographic update order avoid dual-surface restore timing and timestamp-comparison bugs.
- Good, because the second graphics port keeps the graphics transport experiment out of same-port ALPN routing complexity.
- Bad, because HEVC-to-retained copy, LZFSE decode, copyRect, tile paint, and CALayer commit can move the bottleneck into the MainActor compositor.
- Bad, because the branch owns another authenticated transport channel and another nonce handshake.
- Neutral, because full mixed graphics remains captured future scope until scroll-first logs justify it.

### Confirmation

This decision is followed when:

- `TASKS.md` continues to treat ADR-0016 as the R27.3 architecture gate for the scroll-hybrid worktree.
- Shared visual update types compare only `(surfaceGeneration, frameId)`, with `capturedAtUptimeNs` exposed only as diagnostics.
- `resetSurface` rejects same-generation and older-generation resets, then initializes accepted resets to `(surfaceGeneration, 0)`.
- The graphics channel uses `AGENTDESK_GRAPHICS_PORT`, same TLS identity, and explicit hello/ready nonce handshake.
- Accepted-scroll logs show HEVC suppression during active scroll and one HEVC rest refresh after 250 ms idle.
- Scroll detector timeout logs stay under 20 percent of scroll frames during R33 device verification, or the failure is classified before tuning.
- Compositor diagnostics report HEVC-to-retained copy time, copyRect time, LZFSE decode time, tile paint time, CALayer commit time, stale discards, and resets.

## Pros and Cons of the Options

### Keep ADR-0015 unchanged as the active architecture

- Good, because the current owned-media path is already narrow and measurable.
- Bad, because it does not address the scroll-motion case that motivated R27.

### Implement full Microsoft-style mixed mode now

- Good, because it is likely closer to the long-term ceiling for screen content.
- Bad, because broad dirty-region classification, region HEVC, codec tiles, and renderer scheduling would hide whether scroll-copy commands solve the current failure.

### Use scroll-first hybrid retained graphics

- Good, because it tests the smallest retained-graphics slice that could improve scrolling while preserving HEVC correctness.
- Good, because strict update ordering and reset rules are clear enough to test before renderer work starts.
- Bad, because the first compositor is intentionally serialized on the main actor and may become the next bottleneck.

### Use same-port ALPN routing for graphics

- Good, because it would avoid one more configured port.
- Bad, because R27.2 found that Network.framework same-port ALPN routing adds implementation risk before the command model is proven.

## Links

- ADR-0015: owned single-surface media baseline superseded in this branch.
- `TASKS.md`: R27 scroll-first hybrid retained graphics ledger.
- `SPEC.md`: current owned-media baseline before R27.4 updates the worktree docs.
