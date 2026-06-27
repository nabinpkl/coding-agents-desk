# RDP-alignment readiness review: scroll hybrid retained graphics

Design-only review. No product code was modified to produce this document. It records the confirmed freeze root cause, the RDP/OS principles the host should be aligned against, a subsystem-by-principle scorecard, three redesign options with judge scores and a recommendation, an immediately actionable minimal freeze fix, and a proposed `TASKS.md` rewrite block for review.

## Context

The hybrid retained-graphics path froze on physical hardware. The freeze is not a tuning miss. It is two structural defects in the brute-force pixel-diff scroll detector, plus one decisive divergence from how RDP and the OS itself model "what changed".

Confirmed root cause, from code plus real host logs, not re-derived here:

- `ScrollDeltaProbe.bestOffset` (the no-hint path) runs a full -240..240 sweep over both axes, which is 960 candidates, and the 4 ms `detectionBudgetMs` is checked only after both loops finish (`ScrollDeltaProbe.swift:146,198,238`). Real logs: `candidates=960 probeMs=35-60 reason=probe-budget-exceeded`. About 570 such frames ran synchronously inside the encode pump (`OwnedMediaTransport.swift:1021`), starving HEVC admission. Client backlog reached 182 frames and `maxRenderGapMs=6096`, which is the frozen screen.
- Even when the sweep completes it never accepts. Coarse 10x8 sampling (`probeScale=108`) makes every small offset score about 0.97 with runner-up about 0.955, so the 0.06 accept margin (`ScrollDeltaEngine.swift:155` `confidenceMargin`) is structurally unsatisfiable. The winning offset is 1px noise. `accepted=0`, `timeout=688`.
- The input hint covers only 118 of 688 scroll-active frames (the 180 ms active window in `ScrollActivityTracker`). The other 570 fall to the blind scan because `allowBlindScan = scrollHint == nil` (`OwnedMediaTransport.swift:1005`).
- The non-hinted fallback realigns the retained baseline every frame (`HybridHEVCFallbackPolicy.baselineDecision -> .realign -> scrollDeltaEngine.observeFallbackFrame -> viewportTracker.release()`), so the 2-frame viewport validation streak never forms. `baselineRealignments=256`.

Decisive RDP-divergence finding: macOS ScreenCaptureKit already delivers per-frame damage via `SCStreamFrameInfoDirtyRects`, and the host reads none of it. `ScreenCaptureKitFrameSource.swift:135-155` keeps only `sampleBuffer.imageBuffer` and drops all `SCStreamFrameInfo` attachments. The brute-force pixel-diff scroll detector reinvents a signal the OS already provides. The default capture pixel format is yuv420 (`Config.swift`), not BGRA, so the probe often runs the slow luma path.

The available-but-unused damage signal is the spine of this entire review. Every redesign below is judged on whether it consumes that signal instead of recomputing it.

## RDP and OS principles

These are the distilled, citation-backed principles RDP uses to move on-screen content without re-sending pixels, plus the macOS-native source for each "what changed" signal. Each principle carries at least one dated citation. Citations are load-bearing; do not strip them when this document is summarized.

### P1. Retained surfaces, not a single framebuffer

The client holds addressable on-screen and offscreen surfaces that operations mutate in place. This is the structural prerequisite for every no-pixel trick: if the client retains pixel state in named surfaces, the server sends only the delta operation, never the whole screen.

- MS-RDPEGFX surface management commands (`RDPGFX_CREATE_SURFACE_PDU`, `RDPGFX_DELETE_SURFACE_PDU`, `RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU`, `RDPGFX_RESET_GRAPHICS_PDU`) manage offscreen surface lifetime and map an offscreen surface to the visible output buffer. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/5229ee1e-1cb4-4178-9739-a36f1258b685 (2025-08-11)
- MS-RDPEGFX Graphics Pipeline Extension, version 19.0. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/da5c75f9-cd99-450c-98c4-014a496942b0 (2026-05-11)

### P2. On-screen-to-on-screen copy is the core no-pixel primitive

Move or scroll a region by copying pixels the client already holds. The wire cost is a few coordinates regardless of region size. This is the single highest-leverage win for scroll-heavy content.

- MS-RDPEGDI `ScrBlt` (`SCRBLT_ORDER`) performs a bit-block transfer from a source region to a destination region with maximum encoded field length 13 bytes. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/a4e322b0-cd64-4dfc-8e1a-f24dc0edc99d (2024-04-23)
- MS-RDPEGFX `RDPGFX_SURFACE_TO_SURFACE_PDU` copies bitmap data from a source surface to a destination surface (or replicates within the same surface), carrying `surfaceIdSrc`, `surfaceIdDest`, a single `rectSrc`, and an array of `destPts`. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/0b19d058-fff0-43e5-8671-8c4186d60529 (2025-08-11)

### P3. Content-addressed bitmap cache: store a region once, replay by slot index

Repeated visual content (icons, reappearing chrome, content scrolled off then back on) should never be re-encoded after the first send. A client cache lets the server say "paint cache slot N here" for a few bytes.

- MS-RDPEGFX `RDPGFX_CACHE_TO_SURFACE_PDU`: `surfaceId` must identify a valid offscreen surface and `cacheSlot` a valid Bitmap Cache entry; the cached bitmap is copied to each point in `destPts` with a SRCCOPY ROP3. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/b2a60ac5-f4fe-4a31-855d-e7db2fab5729 (2025-08-11)
- MS-RDPEGDI caches: cached items are referenced by cache entry (plus cache ID where multiple caches exist), and an item must be cached before it is referenced; the server drives eviction to keep client and server caches in sync. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/a922b0f7-7dc9-4b55-8567-be4d1038d97f (2024-04-23)
- MS-RDPBCGR `TS_BITMAPCACHE_PERSISTENT_LIST_PDU` carries 64-bit content-hash keys so a client can tell the server which bitmaps it already holds across reconnects. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/a6218d19-5505-445d-acea-1b3f5b0097dc (2026-03-06)

### P4. Pixels travel as encoded wire-to-surface payloads, decoupled from where they land

When content is genuinely new, it is compressed and addressed to a surface region so it composes with retained state. The codec stays orthogonal to the surface, move, and cache layer.

- MS-RDPEGFX `RDPGFX_WIRE_TO_SURFACE_PDU_1` and `RDPGFX_WIRE_TO_SURFACE_PDU_2` transfer an encoded bitmap to an offscreen surface; the codec is negotiated separately. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/5229ee1e-1cb4-4178-9739-a36f1258b685 (2025-08-11)
- MS-RDPRFX RemoteFX is a tile-based DWT codec using `CT_TILE_64x64` tiles with scalar quantization; the progressive variant refines tiles over successive frames. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdprfx/ee99f7e0-bbfe-4617-9b2b-0054eeabe48f (no date verifiable)

### P5. Frame markers batch operations into one atomic logical frame with an ID

A single visual update is usually several operations. Explicit start/end markers with a monotonic frame ID let the client composite into the retained surface and flip only at end-of-frame. They are also the natural hook to coalesce several capture frames into one logical update when the link is behind.

- MS-RDPEGFX logical frames are delineated by `RDPGFX_START_FRAME_PDU` and `RDPGFX_END_FRAME_PDU`, each tracked by frame ID until acknowledged. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/5bd8ea57-60b9-4488-a21d-b93671102bbe (2025-08-11)

### P6. Frame acknowledgement with queue depth is the backpressure signal

On a constrained link the server can out-produce the client's decode rate. An explicit ack carrying a quantitative client backlog bounds in-flight work and lets the server degrade quality, coalesce, or skip instead of ballooning latency.

- MS-RDPEGFX `RDPGFX_FRAME_ACKNOWLEDGE_PDU` carries `queueDepth` (unprocessed bytes buffered at the client, with `QUEUE_DEPTH_UNAVAILABLE` and `SUSPEND_FRAME_ACKNOWLEDGEMENT` sentinels), `frameId`, and `totalFramesDecoded`. https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegfx/0241e258-77ef-4a58-b426-5039ed6296ce (2025-08-11)

### P7. "What changed" is an input, not something the protocol computes

The per-region operation chooser (move vs cache-replay vs encoded-pixels) needs a dirty-region signal upstream of the wire. On Windows the mirror/composition layer supplies it. On macOS ScreenCaptureKit supplies it directly.

- ScreenCaptureKit `SCStreamFrameInfo.dirtyRects` retrieves the areas of a video frame that changed since the prior frame; `contentRect` retrieves the content rectangle. https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/dirtyrects (no date verifiable)
- ScreenCaptureKit exposes per-frame metadata via `SCStreamFrameInfo` attachments (`contentRect`, `contentScale`, `scaleFactor`, `dirtyRects`) and is available on macOS 12.3+. https://developer.apple.com/videos/play/wwdc2022/10156/ (no date verifiable)

Caveat carried from the research: `dirtyRects` is best-effort and can be empty or coarse, so an encoded-pixel fallback must always exist, and a `contentRect`/resolution change is a surface reset trigger (the RDP `RESET_GRAPHICS` analogue).

## Alignment scorecard

Status is one of aligned, partial, violated, absent. Severity reflects how directly the gap drives the observed freeze or the missed bandwidth win.

| Subsystem | Principle | Status | Severity | Evidence (file:line) |
| --- | --- | --- | --- | --- |
| Scroll detector stack | P7 dirty-region drives the chooser | violated | high | `ScrollDeltaProbe.swift:146,198` full -240..240 sweep as the change signal; `ScrollDeltaEngine.swift:482-520` consumes only the raw `CVPixelBuffer`, no `dirtyRects` |
| Capture source | P7 read OS damage | absent | high | `ScreenCaptureKitFrameSource.swift:135-149` keeps only `imageBuffer`; no `SCStreamFrameInfo` attachment read |
| Host chooser | P7 per-region classifier | violated | high | `OwnedMediaTransport.swift:1005` `allowBlindScan = scrollHint == nil`; chooser is whole-frame, not per-rect (`1029-1244`); `baselineDecision` defaults to `.realign` (`SharedTypes.swift:1795`) |
| Scroll detector stack | P2 on-screen copy primitive | partial | high | `ScrollDeltaEngine.swift:703-763` `makeScrollEnvelope` emits the correct `copyRect` + exposed tile, but it is gated behind the brute-force search and a viewport streak the non-hinted path destroys every frame (`200-204`) |
| Host scroll/HEVC | P1 retained surface survives | partial | high | retained model exists (`commitPendingSurface`, `surfaceGeneration`) but is realigned away on every non-hinted frame; `baselineRealignments=256` |
| Scroll detector stack | P6 frame-ack backpressure on detection | absent | high | no ack/queue-depth feeds detection; `detectionBudgetMs` is a static 4 ms read post-hoc (`ScrollDeltaProbe.swift:238`) |
| Owned-media pump | P6 frame-ack backpressure on encode | aligned | medium | `OwnedMediaTransport.swift:388-406` `noteAck` consumes `renderGapMs/frameAgeMs/clientBacklogFrames/clientBacklogBytes`; graphics ack carries `queuedFrames/queueDepthBytes` (`106`). Cannot rescue a pump blocked 35-60 ms per frame before admission |
| Owned-media pump | P5 frame markers | aligned | low | `surfaceGeneration` + `graphicsFrameId` bracket the `copyRect`+tile envelope (`OwnedMediaTransport.swift:1040-1042`); no coalescing of fast capture frames into one logical frame |
| Host encode | P4 codec orthogonal, addressed to region | partial | medium | encoded path is decoupled (`bitmapTile` + `compressLZFSE`), but reset is whole-surface LZFSE stripes (`ScrollDeltaEngine.swift:616-653`) and HEVC fallback is whole-frame, not wire-to-surface-region |
| Host scroll | P3 content-addressed cache | absent | medium | no hash->slot map, no cache command; scrolled-off-then-back content is re-encoded every time |
| Host scroll | P3 (cacheId, cacheIndex) addressing | absent | low | `OwnedGraphicsCommand` is limited to `resetSurface/bitmapTile/copyRect`; any non-translational repeat costs pixels |

Top three by severity: (1) P7 violated/absent across capture, detector, and chooser; the OS damage signal is dropped and reinvented as a 960-candidate sweep that starves admission. (2) P1 partial: the retained baseline churns 256 times so the copy primitive never amortizes. (3) P6 absent on the detection path: a static 4 ms budget read after the loops is the only lever, which is what let the client backlog reach 182 frames.

## Redesign options

Three altitudes were generated and scored by a judge panel on two lenses: correctness/root-cause elimination, and simplicity/maintainability.

### Option A: minimal-patch (keep the pixel-diff detector, make it non-blocking and able to accept)

Four surgical host-side edits.

Key changes:
- `ScrollDeltaProbe.swift:146,198,522`: add a per-candidate `if isOverBudget { break }` inside both candidate loops and the refine loop, replacing the single post-loop read at `238`. This is the literal freeze fix: it caps probe cost near the 4 ms budget instead of always running 960 candidates plus refine.
- `ScrollDeltaProbe.swift`: raise `targetSampleColumns/targetSampleRows` (from 10/8 toward verification density) so `probeScale` stops collapsing neighbouring offsets to within ~0.015, paired with the in-loop abort so the denser scan stays bounded.
- `ScrollDeltaEngine.swift:155-156`: add an absolute-confidence accept branch (accept at confidence >= ~0.97 even when confidence-minus-second-best < margin), gated to the hinted/directed small candidate set; keep the margin as the wide-scan guard.
- `ScrollActivityTracker.swift:58`: widen `activeWindowMs` from 180 ms toward 250-300 ms so the hint covers far more than 118/688 frames.
- `ScrollDeltaEngine.swift:154`: bound the blind range to recent accepted offsets (e.g. +-48) instead of +-240.
- `SharedTypes.swift:1776-1796`: add a recent-scroll-intent branch to `baselineDecision` so a brief miss during a gesture returns `.visualOnly` instead of `.realign`, letting the viewport streak form.

Wire-shape deltas: none. No client change. Only host-internal struct fields (an effective-max-offset parameter and a `recentScrollIntent: Bool` on the policy context), neither crosses the wire.

Migration: none. No state-format or wire migration, consistent with the no-migration-scaffolding convention. Update `ScrollQualityTests.swift` where it asserts the old 0.06-margin acceptance or the post-loop budget semantics.

Pros: directly removes the freeze; makes scroll actually accept (accepted 0 -> >0); small, reviewable, independently revertable; keeps the correct copy/retained/framing primitives.

Cons and risks: preserves a fragile base. The detector still ignores `dirtyRects` and still does luma matching on yuv420, so worst-case cost stays O(frame) and the four overlapping trackers remain. The in-loop abort is now load-bearing for correctness, not just safety. The absolute-confidence accept risks admitting a 1px-noise offset on low-detail content, producing a torn copy. Several thresholds are log-tuned heuristics that drift across content and macOS versions. The static 4 ms budget stays the only detection backpressure lever.

Judge scores: correctness 7/10, simplicity 3/10. Notes: hits both proven root causes at the exact verified sites and is honest about what it leaves, but it net-adds complexity to the most fragile code in the tree and leaves the O(frame) worst case.

### Option B: damage-driven host classifier (recommended)

Read `SCStreamFrameInfoDirtyRects` + `contentRect` off every sample buffer, carry them on `CapturedVideoFrame`, and replace the entire brute-force pixel-diff stack with a single per-frame chooser that turns OS damage geometry plus the input-scroll delta into `copyRect`+`bitmapTile` envelopes. The client retained-surface compositor, the `OwnedGraphicsCommand` wire (`resetSurface/copyRect/bitmapTile`), the graphics frame-ack/queue-depth backpressure, and HEVC as the rest/full-frame path are all kept verbatim.

A vertical scroll is detected as: a tall dirty rect spanning most of `contentRect` whose y-extent equals the input-hint magnitude. The host emits one `copyRect` of the unchanged band (shift the retained surface by the hinted dy) plus one `bitmapTile` of the newly exposed strip whose height equals `|dy|`. No candidate sweep, no confidence margin, no 2-frame viewport streak. Unmatched dirty rects tile-encode the union rect instead of forcing a whole-frame HEVC reset.

Key changes:
- `ScreenCaptureKitFrameSource.swift:135`: read `CMSampleBufferGetSampleAttachmentsArray`, decode `SCStreamFrameInfo` `dirtyRects` (via `CGRect(dictionaryRepresentation:)`), `contentRect`, `scaleFactor`, `status`. Skip frames whose `status != .complete`. Convert each dirty rect from `contentRect`-relative points into native surface pixels (multiply by backing scale, clamp, y-flip to top-left origin to match the BGRA surface).
- `VideoFrameSource.swift:23`: add `damageRects: [PixelRect]` and `contentRectPixels: PixelRect?` to `CapturedVideoFrame`. Empty `damageRects` means "signal unavailable, treat as full-frame change".
- New `DamageScrollClassifier.swift`: pure function `classify(damageRects, contentRect, inputHint, retained) -> DamageClassification` with `.scroll/.tiles/.fullFrame/.noChange`. Scroll accept gates on a single directed verification of the hinted offset over a thin sampled stripe (match >= 0.90), never a search.
- `ScrollDeltaEngine.swift`: strip to a retained-surface mutator plus envelope builder. Delete `bestScrollOffset`, `makeProbeSampler`, the confidence constants, `allowBlindScan` and its branch, and `observeFallbackFrame`'s `viewportTracker.release()` churn. Keep `makeSurface`, `makeScrollEnvelope`, the striped reset, `compressLZFSE`, `commitPendingSurface`. Add `.tiles` mapping to N `bitmapTile` commands.
- `OwnedMediaTransport.swift:994-1028`: delete `allowBlindScan`, replace `scrollDeltaEngine.evaluate` with the pure `classify` call before admission gating, keep the `graphicsChannel.send` + `commitPendingSurface` + ack/backpressure path verbatim.
- `baselineDecision` becomes damage-driven: realign only the rects the HEVC frame overwrote, never the whole baseline.

Wire-shape deltas: none on the wire. The client compositor already implements the RDP retained-surface primitive correctly and needs no change. The only additions are host-internal `CapturedVideoFrame` fields and a new host file.

Migration: none across the wire. Internal struct additions only, no persisted-state wipe.

Pros: deletes the freeze class by construction (classification is O(damage)x1, computed off the admission-serialized pump), not by budget tuning. Removes the unsatisfiable-margin failure mode at the root by verifying one geometrically-implied offset. Retires five overlapping stateful trackers. Reuses the already-correct copy path and wire.

Cons and risks: bigger blast radius (deletes five trackers, adds a file and two frame fields). The +-2px band-height vs `|dy|` match and >=90% width span are heuristics that can misfire on partial-window scrolls or overlay damage. The no-hint geometric sign derivation is the shakiest sub-case, though it is still gated by the verification step.

Judge scores: correctness 9/10, simplicity highest of the three. Notes: strongest root-cause-to-risk ratio; handles the decisive assumption soundly (status filtering, points-to-native-pixel conversion with y-flip, damage-not-motion treated as a candidate then verified, documented full-frame fallback when damage is empty or coarse).

### Option C: ground-up rewrite

Same damage-driven core as Option B but as a broader restructuring (full chooser-to-envelope rewiring, reworked backpressure integration, a deferred bitmap cache, restated migration). Shares Option B's sound core and O(damage) freeze elimination.

Judge score: correctness 7/10. Notes: scored below Option B on the correctness lens because it widens the surface that must be re-proven without eliminating anything Option B does not already eliminate, and the design as presented was truncated mid-`OwnedMediaTransport` change. More blast radius for no additional root-cause coverage.

### Recommendation

Adopt Option B, the damage-driven host classifier, as the target architecture. It is the only option that eliminates the freeze by construction rather than by budget tuning, and it removes the unsatisfiable-margin failure at the root by verifying one geometrically-implied offset instead of picking a winner among coarse near-ties. Its load-bearing assumption is handled honestly: it treats `dirtyRects` as damage geometry, not as motion, filters on `SCStreamFrameInfoStatus == .complete`, converts points to native pixels with scale factor and y-flip, and gates every `copyRect` on a single directed verification with a documented full-frame fallback when the signal is empty or coarse. Option C shares this correct core but adds unverified surface and was truncated, so it is not worth the extra blast radius. Option A is a fragile patch on a fragile base.

This recommendation favors the clean-slate path on merit: the brute-force probe is reinventing a signal the OS already computes, and no amount of tuning the sweep changes that the work is O(frame) when it should be O(damage).

Sequencing: land the minimal freeze fix (below) first as a standalone, independently revertable hotfix that stops the production freeze today. Then build the damage-driven classifier behind it and retire the probe once damage classification is proven on real logs. Do not ship the minimal-patch absolute-confidence accept as the permanent answer; it leaves the O(frame) worst case and the torn-copy risk that Option B removes.

Grafts to carry from Option A into Option B:
- Land the per-candidate in-loop budget abort (`ScrollDeltaProbe.swift:146,198,522`) as the first commit so the freeze stops while the classifier is built.
- Widen `ScrollActivityTracker.activeWindowMs`; Option B leans on the input hint for the common path, so a wider, better-aligned window raises its hinted-fast-path hit rate.
- Keep the input-hint magnitude as the primary dy source and treat the damage band as the corroborating extent/position check; this hardens Option B's shakiest no-hint corner.
- Reuse an absolute-confidence accept threshold as the acceptance test inside Option B's single-offset verification, replacing the margin test.

## Minimal freeze fix (immediately actionable)

This is the smallest set of host-only edits that stops the production freeze and makes scroll acceptance reachable, regardless of which larger redesign lands. It is safe to ship first.

1. In-loop probe budget abort. `host/AgentDeskHost/ScrollDeltaProbe.swift:146` and `:198`: at the top of each candidate-loop iteration add a guarded abort that returns best-so-far as timed out when the budget has elapsed. Apply the same in `refine()` at `:522`. Replace the single post-loop `isOverBudget` read at `:238` so the scan stops near the 4 ms budget instead of always running all 960 candidates plus refine. This caps probe cost so the encode pump (`OwnedMediaTransport.swift:1021`) stops blocking HEVC admission, and the 182-frame backlog and 6096 ms render gap cannot form.

2. Force the live path off blind scan. `host/AgentDeskHost/OwnedMediaTransport.swift:1005`: set `allowBlindScan = false` in the live path (do not let it be `scrollHint == nil`). A frame with no usable offset source emits no graphics commands and falls back to HEVC for that frame, instead of triggering the 960-candidate sweep. This deletes the entire blind-scan freeze contribution (570 frames) immediately.

3. Stop baseline realign during scroll intent. `host/AgentDeskHost/SharedTypes.swift:1776-1796` (`HybridHEVCFallbackPolicy.baselineDecision`): add a recent-scroll-intent branch so a brief miss within a trailing scroll window returns `.visualOnly` instead of falling through to the default `.realign` at `:1795`. Plumb `recentScrollIntent: Bool` into the policy context and set it at the call site (`OwnedMediaTransport.swift:1278`). This stops `observeFallbackFrame -> viewportTracker.release()` from running every non-hinted frame, so `baselineRealignments` falls and the 2-frame viewport streak can form.

Verify with `just iphone-console-run`: confirm `probeMs` collapses toward 4 ms in host logs and `/tmp/agentdesk-client-console.log`, that blind-scan frame share goes to zero, and that `baselineRealignments` drops with `viewportStable=true` appearing. Update `ScrollQualityTests.swift` where it asserts the old post-loop budget or 0.06-margin contracts.

## Proposed TASKS.md rewrite block (for review, do not apply yet)

The current `TASKS.md` frames R74 as a viewport-acceptance run and R75-R80 as "viewport-first scroll ownership". That framing is now wrong: the failure is not that viewport detection runs too late, it is that the host recomputes a damage signal the OS already provides, blocks the pump doing it, and can never accept under coarse sampling. The block below corrects the R74 note and replaces the viewport-first R75-R80 cluster with a damage-driven cluster. Review before applying.

```markdown
## v0 Phase 13: damage-driven retained graphics (replaces viewport-first framing)

Phase goal: stop reinventing change detection. macOS ScreenCaptureKit already
delivers per-frame damage via SCStreamFrameInfoDirtyRects, and the host drops it
(ScreenCaptureKitFrameSource.swift:135-155). Replace the brute-force pixel-diff
scroll stack with a damage-driven per-frame classifier that turns OS damage
geometry plus the input-scroll delta into copyRect+bitmapTile envelopes. Keep the
client retained-surface compositor, the copyRect/bitmapTile/resetSurface wire, the
graphics frame-ack backpressure, and HEVC as the full-frame path unchanged.
Governed by ADR (damage-driven retained graphics), proposed.

- [ ] R74. (corrected note) The physical run did not fail because viewport
  detection was late. It froze on a synchronous 960-candidate -240..240 probe
  (ScrollDeltaProbe.swift:146,198) whose 4ms budget is read only after both loops
  (:238), running inline in the encode pump (OwnedMediaTransport.swift:1021) and
  starving HEVC admission: accepted=0, blindTimeout=570, maxRenderGapMs=6096,
  client backlog 182. Two structural defects compound it: the 0.06 confidenceMargin
  (ScrollDeltaEngine.swift:155) is unsatisfiable under coarse 10x8 sampling
  (probeScale=108, every offset ~0.97), and the non-hinted fallback realigns the
  retained baseline every frame (baselineRealignments=256), so the viewport streak
  never forms. Decisive finding: the OS damage signal (SCStreamFrameInfoDirtyRects)
  is available and unused. R74 stays blocked; superseded by the R75 cluster below.

- [ ] R75. Land the minimal freeze hotfix as a standalone revertable commit:
  in-loop budget abort in ScrollDeltaProbe (lines 146, 198, 522, replacing the
  post-loop read at 238); set allowBlindScan=false in the live path
  (OwnedMediaTransport.swift:1005); add a recent-scroll-intent branch to
  HybridHEVCFallbackPolicy.baselineDecision (SharedTypes.swift:1776-1796) so a brief
  scroll-gesture miss returns .visualOnly not .realign. Verify probeMs collapses
  toward 4ms and blind-scan share goes to zero on physical hardware.

- [ ] R76. Read SCStreamFrameInfo damage in ScreenCaptureKitFrameSource.swift:135:
  decode dirtyRects, contentRect, scaleFactor, status from the sample-buffer
  attachments; skip status != .complete; convert dirtyRects from contentRect-relative
  points to native surface pixels (backing scale, clamp, y-flip). Thread damageRects
  and contentRectPixels onto CapturedVideoFrame (VideoFrameSource.swift:23), empty
  list meaning best-effort-unavailable.

- [ ] R77. Add DamageScrollClassifier.swift: pure function
  classify(damageRects, contentRect, inputHint, retained) -> .scroll/.tiles/
  .fullFrame/.noChange. Scroll accept requires a damage band spanning most of
  contentRect width, band height within +-2px of the hinted |dy|, and a single
  directed verification (>=0.90) of the hinted offset over a thin stripe. No search,
  no confidence margin, no 2-frame streak.

- [ ] R78. Strip ScrollDeltaEngine to a retained-surface mutator + envelope builder:
  delete bestScrollOffset, makeProbeSampler, the confidence/margin/maxScrollOffset
  constants, allowBlindScan and the blind branch, and observeFallbackFrame's
  viewportTracker.release() churn. Map classify output through the existing
  makeScrollEnvelope (.scroll), per-rect bitmapTile commands (.tiles), and the
  existing striped reset (.fullFrame). Retire ScrollActivityTracker pixel-matching,
  ScrollCopyOwnership, ScrollViewportTracker, and ScrollRegionTracker into one
  motion-vector source.

- [ ] R79. Wire the classifier into OwnedMediaTransport before admission gating:
  delete allowBlindScan, call classify as a pure function of (damageRects, retained)
  so detection is never serialized behind a pixel scan, keep graphicsChannel.send +
  commitPendingSurface + noteGraphicsFrameSent + ack/backpressure verbatim. Make
  baselineDecision realign only the rects an HEVC frame overwrote, never the whole
  baseline.

- [ ] R80. Diagnostics + tests + physical acceptance: extend
  tools/hybrid-graphics-diagnostics-summary.sh to report dirtyRect counts, scroll vs
  tiles vs fullFrame classifications, per-frame classify cost, and baseline realign
  counts. Add tests proving classification is O(damage) not O(frame), that a hinted
  scroll emits copyRect without any sweep, that an empty-damage frame falls back to
  full-frame, and that scroll misses do not realign the retained baseline. Physical
  just fresh-hybrid-consoled-run must show viewport-locked copyRects > 0,
  maxRenderGapMs back under the rest-state budget, and zero probe-budget-exceeded.

Deferred (not in this cluster): content-addressed bitmap cache (P3) and frame
coalescing (P5). Neither pays until damage-driven move detection is proven.
```
