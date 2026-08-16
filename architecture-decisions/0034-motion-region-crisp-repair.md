---
status: proposed
date: 2026-06-28
refines: ADR-0026 (partially reverses its "retire tiles entirely" target, scoped to rest)
superseded-by: ADR-0102 (its eager-revert mechanism only; settle/promote policy below stands)
---

# Motion-region crisp-repair: revive tiles at rest as a per-region sharpen over video

## Context and Problem Statement

Under the `always_video` default (ADR-0026), every region rides a lossy video codec, so static text never reaches pixel-perfect. The smoothness-first ladder (ADR-0033) spends raster resolution before fps on a constrained link, so the link settles at a reduced-resolution rung and text stays soft even at rest. Raster downscale is a smoothness lever, not a crispness lever. This touches the host encode pump (`OwnedMediaTransport`, `ScreenCaptureKitFrameSource`, `TileContentCache`), the wire (`OwnedGraphicsCommand` in both `SharedTypes.swift` copies), the reliable QUIC stream setup (`PairingSignalingServer`, `SessionDialer`), and the client compositor (`OwnedMediaVideoSink` / `OwnedSurfaceCompositor`).

ADR-0026 explicitly reserved a path back to pixel-exact text ("a crisp-repair layer... if a constrained link or small-font legibility demands it") and noted no combo mode existed yet. That need has now arrived.

## Decision Drivers

- Text at rest must be pixel-perfect; a lossy pass over static text is the regression we are fixing.
- Motion must stay smooth; the video carrier and ADR-0033 ladder keep that job unchanged.
- Per-region: a persistently moving region must not hold static text soft elsewhere.
- Coherence: never show stale text crisply. Video is the live floor; crisp is best-effort.
- Reuse over rebuild: the dormant tile primitives (content-hash cache, tile encode, tile wire commands, client compositor) already exist and must not be duplicated by a parallel stack.
- Do not revive the failed half: tiles as a motion carrier failed on device three times (ADR-0022/0023/0024). Tiles at rest were always the proven half.

## Considered Options

- **Option A**: New parallel crisp stack (new wire message types, new reliable stream, new client sink and overlay layer) beside the existing tile path.
- **Option B**: Raise the ladder's resolution priority so video itself gets crisper at rest.
- **Option C**: Revive the dormant tile-at-rest primitives as a per-region crisp-repair layer over a full-surface video floor, driven by a per-tile content-hash settle policy.

## Decision Outcome

Chose **Option C**. Option A loses because it duplicates `TileContentCache`, the `OwnedGraphicsCommand` tile vocabulary, and the client `OwnedSurfaceCompositor`, all of which already exist; a second stack is rebuild-what-exists. Option B loses because video over static text is lossy by nature and cannot reach pixel-exact, and pushing the ladder to high-resolution rungs fights the thin link (the exact failure ADR-0033 was built around). Option C reuses the proven primitives and adds only a per-tile settle policy on the host, one new wire command (`revertTileToVideo`), and per-region (rather than whole-frame) compositing on the client.

This partially reverses ADR-0026's Option C target of retiring the tile substrate entirely. The reversal is scoped: tiles return only as the at-rest crisp-repair layer, never as a motion carrier. The reliable graphics stream that ADR-0026 parked is reactivated; ADR-0026's premise that a reliable channel cannot share the datagram connection is obsolete on the `NetworkConnection<QUIC>` API the code now targets (OS 26), which already runs a reliable stream and datagrams on one connection.

### Consequences

- Good, because static text becomes pixel-perfect per region shortly after motion stops, while motion stays on the smooth video carrier.
- Good, because it reuses dormant proven code instead of duplicating it, and it retires the whole-frame `visibleSurface` swap that no longer fits a per-region model.
- Bad, because it revives a path ADR-0026 was deleting, so the codebase carries the tile compositor again (accepted: it was never fully removed, and rest-tiles are the proven half).
- Bad, because per-region compositing (surfaceLayer transparent over videoLayer per tile) is genuinely new behavior beyond the old mutually-exclusive toggle.
- Neutral, because the ADR-0033 ladder is unchanged; crispness is now a separate motion-driven axis.

### Confirmation

- Host unit test: `RegionCrispController` never emits a draw for a tile whose hash differs from the current capture (the coherence invariant), promotes only after the settle window, and reverts on the first changed frame.
- Wire round-trip test for `revertTileToVideo` on both host and client.
- Device validation (gated): crisp text within the settle window after motion stops, no stale crisp under induced loss, smooth motion, low rest bandwidth.

## Pros and Cons of the Options

### Option A (parallel crisp stack)
- Good: clean separation from legacy tile code.
- Bad: duplicates cache, wire vocabulary, and compositor; two code paths for "a crisp tile."

### Option B (crisper video at rest)
- Good: no tile path at all.
- Bad: lossy over static text never reaches pixel-exact; fights the thin link.

### Option C (revive tiles-at-rest as per-region repair)
- Good: reuses proven primitives; minimal new wire; correct coherence model.
- Bad: reintroduces the compositor; per-region compositing is new work; needs this ADR to own the ADR-0026 reversal.
