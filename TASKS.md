# TASKS: v0 scroll-first hybrid retained graphics (with full mixed mode captured)

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

Archived history:
- `tasks/archive/2026-06-19-v0-media-output-friction.md` carries the closed media-output exploration through packet repair.
- `tasks/archive/2026-06-20-v0-owned-single-surface-media.md` carries the completed owned single-surface media ledger through motion budget scaling.

## Position

The next media iteration is a separate worktree experiment for scroll-first hybrid retained graphics. The current owned HEVC path stays valuable: it gives the best observed rest-state text quality and remains the full-frame hardware refresh path. The new work adds a retained client surface and a reliable graphics command stream only for the part where full-screen video is weakest: scroll-like text motion.

Ordering:

- First isolate the experiment in `.worktrees/scroll-hybrid-retained-graphics` so `main` keeps its current working HEVC path while the branch is allowed to break media wire shapes.
- Then verify the graphics stream transport shape before deeper implementation. R27.2 selected a second configured graphics port after reviewing the same-port Network.framework ALPN routing cost; graphics uses `AGENTDESK_GRAPHICS_PORT` instead of sharing `Config.signalingPort`.
- Then lock the compositor timeline before touching rendering. HEVC refreshes and graphics commands must share `(surfaceGeneration, frameId)` ordering, with `capturedAtUptimeNs` used only for diagnostics.
- Then build the scroll command path. Accepted scroll sends `copyRect` plus lossless exposed-strip tiles; rejected or timed-out detection falls back to HEVC for that frame.
- Then build the client retained surface. `@MainActor OwnedSurfaceCompositor` is acceptable for the first slice because it makes correctness obvious, but HEVC-to-BGRA copy, LZFSE tile paint, copyRect, and CALayer commit must be measured as likely bottlenecks from the first compositor task.
- Then integrate hybrid cadence. During accepted scroll, HEVC is suppressed by default and one rest refresh is forced after 250 ms idle.

This iteration is scroll-first hybrid retained graphics, not full Microsoft mixed mode. Full text/image/video classification, region HEVC, codec atlas, and Metal/IOSurface compositing stay captured future scope until logs justify them.

## v0 Phase 0: worktree and platform gates

Phase goal: isolate the experiment and resolve the Network.framework connection shape before implementation depends on it.

- [x] D27.1. Add `.worktrees/` to `.gitignore`, commit on `main`, create `.worktrees/scroll-hybrid-retained-graphics` on branch `codex/scroll-hybrid-retained-graphics`, and run `just check` from the worktree.
- [x] D27.2. Add central host/client `AGENTDESK_GRAPHICS_PORT` config, default `41889`, after selecting a second graphics listener over same-port Network.framework ALPN routing.
- [x] D27.3. Add ADR-0016 recording scroll-first hybrid retained graphics and the R27.2 second configured graphics port decision as the worktree architecture, superseding ADR-0015 inside the branch without editing historical ADR conclusions.
- [x] D27.4. Update `SPEC.md`, `README.md`, `.env.example`, and Just recipes so the worktree describes HEVC full-frame refresh plus reliable retained graphics commands as the active media experiment.

## v0 Phase 1: compositor timeline contracts

Phase goal: make all visual updates share one ordering model before renderer work starts.

- [x] D28.1. Add host/client shared types for `OwnedSurfaceUpdateId(surfaceGeneration, frameId)` with lexicographic strict-newer comparison and diagnostics-only `capturedAtUptimeNs`.
- [x] D28.2. Extend the HEVC full-frame envelope with `surfaceGeneration`, `frameId`, `capturedAtUptimeNs`, and `refreshReason` values `initial`, `rest`, `scroll-correctness`, and `reset`.
- [x] D28.3. Add host/client shared types for `GraphicsChannelHello`, `GraphicsChannelReady`, `OwnedGraphicsFrameHeader`, `OwnedGraphicsCommand`, `OwnedGraphicsFrameAck`, and `OwnedGraphicsResetRequest`.
- [x] D28.4. Define reset ordering: `resetSurface` is accepted only when `surfaceGeneration > committedSurfaceGeneration`, then initializes committed order to `(surfaceGeneration, 0)` before reset tiles apply.
- [x] D28.5. Add contract tests asserting update-id comparison, stale HEVC discard, stale graphics discard, newer-generation reset acceptance, same-generation reset rejection, and reserved `codecTile` rejection.

## v0 Phase 2: reliable graphics stream

Phase goal: add the ordered graphics command carrier while keeping the existing HEVC datagram path alive.

- [ ] R29.1. Add a sibling reliable QUIC graphics connection using ALPN `agentdesk-owned-graphics`, the same TLS identity, and explicit `GraphicsChannelHello` / `GraphicsChannelReady` nonce handshake.
- [x] D29.2. Add authenticated `ADGC` stream framing for graphics frames: magic, version, length, JSON header, and binary payload.
- [ ] R29.3. Route graphics ACK and reset-request controls through the graphics stream control path while leaving HEVC frame ACKs on the current owned-media control path.
- [ ] R29.4. Wire the graphics listener and client dialer to the existing `AGENTDESK_GRAPHICS_PORT` host/client config instead of `Config.signalingPort`.
- [ ] R29.5. Add transport tests for partial stream reads, malformed frame rejection, parse-failure reset request, graphics ACK queue clearing, and HEVC datagram survival after graphics stream errors.

## v0 Phase 3: scroll delta engine

Phase goal: create only the scroll-specialized retained-graphics producer, not a full dirty-region classifier.

- [ ] R30.1. Add `ScrollDeltaEngine` on the host that keeps the previous BGRA frame for scroll detection and surface-size tracking.
- [ ] R30.2. Detect vertical and horizontal scroll up to 240 px in 8 px steps, accepting only confidence `>= 0.92`.
- [ ] R30.3. Enforce a 4 ms per-frame detection budget; timeout emits no graphics commands, logs `scroll-timeout`, and falls back to HEVC for that frame.
- [ ] R30.4. On accepted scroll, emit `copyRect` for the stable moved area plus LZFSE `bitmapTile` commands for newly exposed strips.
- [ ] R30.5. On rejected motion, emit no graphics commands, log `scroll-rejected`, and let HEVC refresh handle the frame.
- [ ] R30.6. On size change, emit `resetSurface`, increment `surfaceGeneration`, and force the next HEVC full-surface refresh.
- [ ] R30.7. Add tests for accepted vertical scroll, accepted horizontal scroll, rejected motion, 4 ms timeout, exposed-strip tile bytes, and resize generation reset.

## v0 Phase 4: retained compositor and HEVC bridge

Phase goal: make the client display one retained surface mutated by both HEVC full refreshes and graphics commands.

- [ ] R31.1. Add `@MainActor OwnedSurfaceCompositor` as the single writer for retained BGRA surface mutation and visible `CALayer` commits.
- [ ] R31.2. Implement retained-surface operations: create, reset, strict-newer update check, overlap-safe `copyRect`, LZFSE tile paint, and stale update discard.
- [ ] R31.3. Add compositor diagnostics for HEVC-to-retained copy time, copyRect time, LZFSE decode time, tile paint time, CALayer commit time, stale discard count, and reset count.
- [ ] R31.4. Add `OwnedHEVCFrameDecoder` using `VTDecompressionSession` on iOS so HEVC refreshes produce `CVPixelBuffer` instead of going directly to `AVSampleBufferDisplayLayer`.
- [ ] R31.5. Copy decoded HEVC frames into `OwnedSurfaceCompositor` as full-surface refreshes ordered by `(surfaceGeneration, frameId)`.
- [ ] R31.6. On HEVC decode failure, send `graphics-reset-request` and force a HEVC reset refresh instead of silently dropping the retained surface.
- [ ] R31.7. Add tests for compositor single-writer entry points, overlap-safe copy, exact tile paint, reset generation rules, stale HEVC discard, stale graphics discard, and HEVC decode failure reset request.

## v0 Phase 5: hybrid cadence integration

Phase goal: let graphics commands own scroll motion while HEVC remains the rest/full-frame correctness path.

- [ ] R32.1. Wire host capture into both current HEVC encode admission and `ScrollDeltaEngine`, sharing one `surfaceGeneration` allocator.
- [ ] R32.2. Suppress HEVC full-frame refresh during accepted scroll by default with central config `AGENTDESK_HYBRID_SCROLL_HEVC_FPS=0`.
- [ ] R32.3. Force one HEVC rest refresh after 250 ms of scroll idle, then return to the current HEVC rest cadence.
- [ ] R32.4. Discard late HEVC refreshes on the client when their `(surfaceGeneration, frameId)` is not strictly newer than the retained surface state.
- [ ] R32.5. Add tests for accepted-scroll HEVC suppression, optional nonzero scroll HEVC FPS tuning, scroll-idle rest refresh, rest cadence recovery, and stale HEVC overwrite prevention.

## v0 Phase 6: device verification and comparison

Phase goal: prove whether the hybrid path improves scroll feel and identify the next bottleneck if it does not.

- [ ] R33.1. Use `just fresh-hybrid-consoled-run` for the physical verification pass and confirm it builds, installs, launches attached console, and preserves `/tmp/agentdesk-client-console.log`.
- [ ] R33.2. Add `tools/hybrid-graphics-diagnostics-summary.sh` summarizing HEVC bytes, scroll accepted/rejected/timeout rates, copyRect count, exposed-strip bytes, graphics ACK RTT, HEVC decode cost, compositor copy/tile/commit cost, and stale discard counts.
- [ ] R33.3. Run a physical iPhone attached-console pass for 20 to 30 seconds of repeated scrolling.
- [ ] R33.4. Acceptance: rest text remains at least as crisp as current HEVC, copyRect is exercised during scroll, scroll detector timeout rate is under 20 percent of scroll frames, HEVC bytes drop during accepted scroll, late HEVC does not overwrite newer graphics state, and there is no repeated reset loop.
- [ ] R33.5. If the run fails, classify the blocker as scroll detection, graphics stream, HEVC decode, HEVC-to-retained copy, LZFSE tile paint, copyRect, CALayer commit, or transport/auth before changing tuning.

---

## v0 full mixed graphics scope (captured, not started)

This scope opens only after R33 proves the scroll-first hybrid path works or identifies a specific bottleneck that requires a broader architecture.

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Full dirty-region classifier | Microsoft-style mixed graphics | Non-scroll text changes without full HEVC frames | CPU detection and ordering complexity can exceed the saved bytes |
| Region HEVC / codec atlas | Future `codecTile` command | Image/video-heavy regions without full-screen codec pressure | Decoder/compositor synchronization becomes the hard part |
| Metal or IOSurface compositor | Client renderer upgrade | Moves BGRA copy, tile paint, and commit cost off the main thread | More rendering complexity before correctness is proven |
| Multipath graphics transport | AVD 2026 network direction | Better resilience under poor networks | Not useful until command model beats local Wi-Fi bottlenecks |

### Alternative arc (rejected for now, captured)

- Pure retained graphics with no HEVC active path. Rejected because hardware HEVC is already the best observed rest-quality ceiling, and deleting it would make the first retained-surface slice CPU-heavy before proving the scroll-copy thesis. Revisit only if HEVC-to-retained decode/copy is the bottleneck and graphics-only rest tiles are cheaper.
- Full Microsoft mixed mode now. Rejected because text/image/video classification and codec tiles are broader than the current failure. Revisit after scroll-first hybrid logs prove the retained compositor and reliable graphics stream.

## Promotion log

```
D27.1     2026-06-20  committed   local worktrees ignored and hybrid graphics branch baseline passed
D27.2     2026-06-20  committed   second configured graphics port chosen after Network.framework ALPN routing review
D27.3     2026-06-20  committed   ADR-0016 records scroll-first hybrid retained graphics
D27.4     2026-06-20  committed   worktree docs describe HEVC plus retained graphics
D28       2026-06-20  committed   compositor timeline contracts and ordering tests
R29       pending     pending     reliable graphics stream and transport tests
D29.2     2026-06-20  committed   ADGC graphics frame envelope contracts and malformed-frame tests
R30       pending     pending     scroll delta engine with timeout and exposed-strip tests
R31       pending     pending     MainActor retained compositor and HEVC decoder bridge
R32       pending     pending     hybrid cadence suppresses HEVC during accepted scroll
R33       pending     pending     attached-console iPhone verification and diagnostics summary
```
