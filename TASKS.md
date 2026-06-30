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
- [~] R3. Folded into R6 (host lane) and R8 (client lane). Investigation found the ADGC envelope framing the lane needs is already round-trip tested on both sides, there is no live-QUIC loopback harness (live establishment is only verifiable at the gated R9 run), and a standalone lane would be inert pairing-path plumbing with no producer or consumer. The reliable `.graphics` stream is therefore built where it is exercised: the host side in R6, the client side in R8, validated live at R9.

## R6/R7/R8 integration map (call sites, from the encode-pump read)

- Host pump tap: `QuicSessionHostMediaTransport.drainEncodeQueue` / `enqueue` (`OwnedMediaTransport.swift`) is where `CapturedVideoFrame` arrives with `.pixelBuffer` (BGRA `CVPixelBuffer`), `.damageRects`, dims. Lock the pixel buffer, extract BGRA `Data` (reuse the `ScrollDeltaEngine.makeSurface` approach), run `RegionCrispController.observe(...)`, and send the emission as an `OwnedGraphicsFrameEnvelope` over the lane. Surface generation + monotonic frameId are owned here; send a `resetSurface(dims)` once per session before the first crisp tile so the client compositor's `validateGraphicsFrame` accepts `cacheTile`/`drawCachedTile`. Call `RegionCrispController.reset()` when the lane (re)attaches.
- Host lane delivery: add `graphicsLaneReadyHandler` to `PairingSignalingServer` mirroring `inputLaneReadyHandler` (init param + the `.graphics` case in `handle(_:context:)`, gated on `context.activeSession`). `AppDelegate` wires it (next to the `inputLaneReadyHandler` closure at ~line 339) to route the `GraphicsLaneServer` to the session's transport via the `sessions` registry.
- Client lane: `SessionDialer` (both dial ~line 110 and resume ~line 230) opens a third `connection.openStream()`, sends a `.graphics` role marker, passes it to `QuicSessionClientTransport`, which runs a receive loop feeding `OwnedGraphicsStreamFrameParser` and applies envelopes via `OwnedMediaVideoSink.applyGraphicsFrame`.
- R7 visibility: under `always_video` `surfaceLayer.isHidden = true`. Crisp tiles will be painted but invisible until `surfaceLayer` composites over `videoLayer` per region (transparent where on video). Without R7 the R9 run shows no crisp change, so R7 is required for the end-to-end proof.

## Phase 2: host per-region crisp emitter

- [x] R4. `host/AgentDeskHost/OwnedTileCodec.swift`: standalone `OwnedTileCodec.extractTile(...)` and `compressLZFSE(...)` mirroring the dormant `ScrollDeltaEngine` helpers, so the emitter reuses proven extraction/encode without scroll routing. Tests assert exact sub-rect extraction, out-of-bounds rejection, and lossless LZFSE round-trip. (The dormant `ScrollDeltaEngine`/`FrameComposer`/`MotionGovernor` remain a separate dead-code removal once crisp-repair proves out.)
- [x] R5. Introduce `host/AgentDeskHost/RegionCrispController.swift`: per-tile settle/motion policy over the captured surface and damage rects, using `TileContentCache`. Pure-logic core returning `[OwnedGraphicsCommand]`. Unit tests assert: settle window promotes; any hash change reverts; unchanged hash dedups to `drawCachedTile`; never emits a draw for a hash differing from current capture (the invariant); eager revert on first changed frame. Observability (from R1/R2/R4 review M2/m6): when `OwnedTileCodec.compressLZFSE` returns nil for a settled tile, the controller must count/log the dropped-crisp tile rather than swallow it silently; the tile simply stays on video (the floor), but the drop must be diagnosable. R5 review re-pass split this into two counters R6 logging must keep distinct: `droppedCrispTileCount` (compression failure, a real per-tile error) and `throttledCrispTileCount` (slot-cap, self-healing, a tuning signal to raise `hybridTileCacheSlots`). R6 must also document at the encode-pump call site that `reset()` is required at the start of every media session, not only after a drop.
- [ ] R6. Build the host reliable graphics lane and wire `RegionCrispController` into the encode pump. Add `.graphics` to `QuicSessionStreamRole` (both `SignalingChannel` copies), a `GraphicsLaneServer` (mirrors `InputChannelServer`) that owns the accepted stream and sends `OwnedGraphicsFrameEnvelope.encode()` bytes, host dispatch + ready-handler wiring (`PairingSignalingServer`/`AppDelegate`), then feed `RegionCrispController` output over it from the encode pump. Config knobs: settle window ms, crisp byte cap per window (`Config`). Live establishment validated at R9. Carried from the R5 review: (a) MAJOR-1 commit seam: addressed via `RegionCrispController.reset()` (landed), which the R6 caller MUST invoke on media session (re)connect. For a reliable ordered stream, commit-on-produce is safe within a session (delivery is in-order or the connection dies); the only divergence is a fresh client's empty slot cache on reconnect, which reset() clears. The encode pump must enqueue emissions in produce order on the single lane. (b) raise `hybridTileCacheSlots` (512) above the max visible tile count (~551 for a full Retina screen at 64px) so crisp tiles do not thrash/drop; (c) feed damage rects to limit per-frame rehashing (full-surface FNV every frame is ~220MB/s at 30fps); (d) HIGH-4: coordinate any `resetSurface` emission with a `RegionCrispController` reset so stale `crispHash` state cannot suppress a needed redraw.

## Phase 3: client per-region compositing

- [ ] R7. Extend `OwnedSurfaceCompositor` for per-region transparency: paint crisp tiles into `surfaceLayer`, transparent elsewhere; honor `revertTileToVideo` by clearing that region to transparent. Retire the whole-frame `visibleSurface` `.video`/`.tiles` `isHidden` swap in `OwnedMediaVideoSink:429`; `surfaceLayer` stays visible over `videoLayer` with transparent-where-video regions.
- [ ] R8. Build the client reliable graphics lane and feed it into the compositor. Open the `.graphics` stream in `SessionDialer`, send the role marker, add a receive loop in `QuicSessionClientTransport` that reassembles ADGC frames via `OwnedGraphicsStreamFrameParser` and applies them to `OwnedSurfaceCompositor`. Tests assert per-region transparency, revert clears a region, slot/hash dedup, and ordered application. Live establishment validated at R9.

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
R3       2026-06-28  folded      reliable graphics lane folded into R6 (host) and R8 (client)
R4       2026-06-29  committed   OwnedTileCodec extraction + LZFSE, wired + tested
R5       2026-06-29  committed   RegionCrispController policy + invariant tests (TDD, 6 behaviors green)
R6       2026-06-29  committed   host graphics lane + crisp pump tap (live validation at R9)
R6.1     2026-06-29  committed   YUV->BGRA in crisp tap; capture is YUV 4:2:0, extractBGRA was inert
R6-vfy   2026-06-29  verified    sim device-verify: crisp fires live (settle 110 tiles/378KB, dropped=0, throttled=0, resized=false, laneAttached=false, no convert failures)
R7       pending     pending     client per-region transparency compositing
R8       pending     pending     client intake feeds compositor + tests
R9       pending     pending     device validation (gated)
```
