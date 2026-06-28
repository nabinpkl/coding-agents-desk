# TASKS: v-crisp motion-region crisp-repair over video (with SSOT unification captured)

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

## Position

Scope this iteration: per-region crisp-repair over the full-surface video floor, per ADR-0034 and `docs/superpowers/specs/2026-06-28-motion-region-crisp-repair-design.md`. The order is wire and transport seam first, then the host emitter, then client compositing, then device validation. Reasons:

- The wire variant and the reliable graphics stream are the shared contract both sides depend on; they land first so host and client work cannot drift on the shape (the SharedTypes copies are already duplicated, so contract drift is the main risk).
- The host emitter is built and unit-tested against the coherence invariant before any client compositing, because the invariant (never draw a tile whose hash differs from current capture) is host-side logic and is the part that can be wrong silently.
- Client compositing comes after a verified emitter so the per-region transparency work is exercised by real host output, not a stub.
- Device validation is last and gated on explicit go-ahead per the device-run checkpoint; unit tests cannot judge crisp-after-settle feel.

Reuse is load-bearing: `TileContentCache`, tile extraction/LZFSE encode, `OwnedGraphicsCommand`, and the client `OwnedSurfaceCompositor` are reused, not rebuilt (ADR-0034). The whole-frame `visibleSurface` swap and the scroll-carrier routing are retired, not extended.

## Phase 0: ADR and spec (gate)

- [x] R0a. ADR `architecture-decisions/0034-motion-region-crisp-repair.md`: revive tiles-at-rest as a per-region repair, partially reversing ADR-0026 scoped to rest.
- [x] R0b. Revise `docs/superpowers/specs/2026-06-28-motion-region-crisp-repair-design.md` to the reuse-based architecture (Revision 2).

## Phase 1: wire variant and reliable graphics stream (contract seam)

- [x] R1. Extend `OwnedGraphicsCommand` with `revertTileToVideo(x:Int, y:Int, width:Int, height:Int)` in both `host/AgentDeskHost/SharedTypes.swift` and `client/AgentDeskClient/SharedTypes.swift` mirror, including `Kind`, `validateForCurrentScope`, and encode/decode arms. The new enum case forced the client compositor's exhaustive switch (`OwnedMediaVideoSink.swift`) to handle it, so a minimal forward-correct handler (clear region to transparent via `clearRect`) landed here too; the per-region layer compositing remains R7.
- [x] R2. Round-trip tests for `revertTileToVideo` on host (`OwnedGraphicsCommandCodecTests`) and client (`OwnedSurfaceCompositorCacheTests`), plus a client compositor test asserting revert clears its region to transparent and leaves the rest untouched. Catches the two SharedTypes copies drifting. Host green under `just check`; client green under sim test.
- [ ] R3. Reactivate a reliable host->client graphics `QUIC.Stream` carrying `OwnedGraphics` frames: host opens/accepts it in the session-ready path (`PairingSignalingServer`/`AppDelegate.handleSessionReady`), client intakes it in `QuicSessionClientTransport` (`SessionDialer` opens, a new receive loop decodes). No tiles emitted yet; assert the stream establishes and an `OwnedGraphics` frame round-trips end to end in a transport test.

## Phase 2: host per-region crisp emitter

- [ ] R4. Lift the reusable tile-pixel extraction and LZFSE encode helpers out of `ScrollDeltaEngine` into a standalone helper (e.g. `OwnedTileCodec`) so the emitter uses them without the scroll routing. Refactor only; assert identical bytes for a sample tile vs the prior inline path.
- [ ] R5. Introduce `host/AgentDeskHost/RegionCrispController.swift`: per-tile settle/motion policy over the captured surface and damage rects, using `TileContentCache`. Pure-logic core returning `[OwnedGraphicsCommand]`. Unit tests assert: settle window promotes; any hash change reverts; unchanged hash dedups to `drawCachedTile`; never emits a draw for a hash differing from current capture (the invariant); eager revert on first changed frame.
- [ ] R6. Wire `RegionCrispController` into the encode pump where the captured surface and damage rects are in scope, sending its commands over the R3 stream. Config knobs: settle window ms, crisp byte cap per window (`Config`).

## Phase 3: client per-region compositing

- [ ] R7. Extend `OwnedSurfaceCompositor` for per-region transparency: paint crisp tiles into `surfaceLayer`, transparent elsewhere; honor `revertTileToVideo` by clearing that region to transparent. Retire the whole-frame `visibleSurface` `.video`/`.tiles` `isHidden` swap in `OwnedMediaVideoSink:429`; `surfaceLayer` stays visible over `videoLayer` with transparent-where-video regions.
- [ ] R8. Feed the R3 stream intake into the compositor; tests assert per-region transparency, revert clears a region, slot/hash dedup, and ordered application.

## Phase 4: validation

Trigger: R1 through R8 landed and `just check` green.

- [ ] R9. Device validation (gated on explicit go-ahead): `just fresh-consoled-run`, then observe crisp text within the settle window after motion stops, no stale crisp under induced loss, smooth motion, low rest bandwidth. Capture host owned-media and attached client logs in the same run.

---

## v-next scope (captured, not started)

### SharedTypes single-source-of-truth unification

`SharedTypes.swift` is duplicated host (2409 lines) vs client (2284 lines) and has drifted. Every wire change must edit both. Options:

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Shared Swift package referenced by both xcodeproj | standard SPM | compile-time drift impossible | xcodeproj wiring + module import churn |
| Single shared file referenced by both projects | Xcode cross-project file ref | drift on the shared file | unusual convention, partial (legacy stays dup) |
| Keep duplicated, add per-side round-trip tests | this iteration's R2 | drift at test time, not compile time | tests must be kept in sync too |

### Alternative arc (rejected for now, captured)

- Full SharedTypes unification bundled into this feature. Useful because it removes the drift hazard at the root. Rejected because it is a large structural refactor orthogonal to crisp-repair and would balloon this change. Revisit when the next wire change lands, or when a drift bug bites.

---

## Promotion log

```
R0a      2026-06-28  committed   ADR-0034 motion-region crisp-repair drafted
R0b      2026-06-28  committed   design spec revised to reuse architecture
R1       2026-06-28  committed   OwnedGraphicsCommand.revertTileToVideo on both sides + client handler
R2       2026-06-28  committed   wire round-trip tests both sides + compositor revert test
R3       pending     pending     reactivate reliable graphics stream end to end
R4       pending     pending     lift tile extraction/LZFSE into OwnedTileCodec
R5       pending     pending     RegionCrispController policy + invariant tests
R6       pending     pending     wire emitter into encode pump
R7       pending     pending     client per-region transparency compositing
R8       pending     pending     client intake feeds compositor + tests
R9       pending     pending     device validation (gated)
```
