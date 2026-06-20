# TASKS: v0 retained scroll ownership stabilization (with full mixed graphics captured)

`R<N>` = remaining. Flip to `D<N>` once landed and tests are green.

Archived history:
- `tasks/archive/2026-06-19-v0-media-output-friction.md` carries the closed media-output exploration through packet repair.
- `tasks/archive/2026-06-20-v0-owned-single-surface-media.md` carries the completed owned single-surface media ledger through motion budget scaling.
- `tasks/archive/2026-06-20-v0-scroll-first-hybrid-retained-graphics.md` carries the first hybrid retained-graphics worktree through the initial graphics stream, compositor, HEVC bridge, and physical-run diagnosis.

## Position

The next iteration makes the retained graphics path own scroll motion. The prior run showed that the architecture is present but not yet active in the hot path: scroll detection timed out, the graphics stream did not produce sustained `copyRect` frames, and HEVC continued carrying motion until admission drained into visible freezes.

Ordering:

- First make scroll detection cheap enough to succeed. The current detector copies and compares full-resolution BGRA before accepting scroll, so it times out and hands motion back to HEVC.
- Then make the graphics stream durable. A disconnected graphics stream cannot be the stateful graphics channel, and reset requests must not depend only on the dead stream they are trying to recover.
- Then make accepted scroll suppress HEVC until idle refresh. HEVC remains the rest-quality and image/video fallback path, not a competing motion path for text scroll.
- Then add graphics-frame lifecycle ACK and backpressure. Host graphics pacing should use graphics queue depth and compositor progress, not HEVC render-gap state.
- Then keep HEVC drain tuning secondary. It can limit damage when the retained path misses, but it is not the ceiling path while copyRect is timing out.

This is still scroll-first hybrid retained graphics, not full Microsoft mixed mode. The slice adopts the Microsoft-ish lesson that text-like scroll should be retained-surface commands with lifecycle ACKs, while hardware HEVC remains available for full-frame refresh and image/video-heavy content.

## v0 Phase 0: evidence gate

Phase goal: pin the current failure shape before changing behavior.

- [x] R34.1. Add `tools/hybrid-graphics-diagnostics-summary.sh` summarizing host and client logs for scroll accepted, rejected, timeout, graphics reset, graphics reconnect, copyRect count, exposed-strip bytes, HEVC bytes, HEVC packet count, graphics ACK RTT or compositor timing, graphics queue depth when present, drain events, and admission holds.
- [x] R34.2. Add representative parser fixtures under `tests/fixtures/owned-media/` covering the current freeze run: zero scroll-accepted, many scroll-timeout lines, a disconnected graphics reset request, HEVC 100-plus packet frames, and repeated admission drain.
  - 2026-06-20 progress: local parser, fixtures, and narrow shell test are implemented and wired into `just check`.
- [ ] R34.3. Run `just fresh-hybrid-consoled-run` on physical iPhone for 20 to 30 seconds and record the baseline summary before implementation changes.
- [ ] R34.4. Acceptance: baseline output states whether the blocker is scroll detection, graphics stream durability, HEVC competition, graphics ACK pacing, or fallback HEVC drain.

## v0 Phase 1: cheap scroll detection

Phase goal: make scroll detection finish within budget before building full exposed-strip payloads.

- [ ] R35.1. Refactor `host/AgentDeskHost/ScrollDeltaEngine.swift` into a two-stage detector: sampled luma or downsampled probe first, full exposed-strip extraction only after an offset is accepted.
- [ ] R35.2. Replace full-resolution BGRA comparison in `bestScrollOffset` with sampled bands that can evaluate vertical and horizontal offsets without copying the entire frame.
- [ ] R35.3. Preserve the current acceptance contract: max offset 240 px, stride 8 px, confidence `>= 0.92`, timeout fallback to HEVC, and no graphics command on rejected motion.
- [ ] R35.4. Add diagnostics for probe time, payload-build time, accepted offset, confidence, timeout reason, and sampled pixel count.
- [ ] R35.5. Add tests proving accepted vertical and horizontal scroll build `copyRect` plus exposed-strip `bitmapTile` only after probe acceptance, non-scroll motion emits no command, and a forced probe timeout does not allocate exposed-strip payload.
- [ ] R35.6. Acceptance: physical scroll run shows scroll detector timeout rate below 20 percent of scroll frames and sustained `copyRects>0` on the client.

## v0 Phase 2: durable graphics stream

Phase goal: make the reliable graphics channel recoverable enough to carry stateful surface commands.

- [ ] R36.1. Extend `host/AgentDeskHost/OwnedMediaTransport.swift` and `client/AgentDeskClient/OwnedMediaTransport.swift` so graphics stream disconnect, timeout, receive failure, and send failure enter a reconnect state instead of permanently disabling retained graphics.
- [ ] R36.2. Route graphics reset requests through a live fallback control path when the graphics stream is disconnected, then force a graphics-stream reconnect and next-generation `resetSurface`.
- [ ] R36.3. Add a graphics handshake replay fence for reconnect attempts using the current session identity and fresh nonces.
- [ ] R36.4. Add host diagnostics for graphics channel state: connected, disconnected, reconnecting, reconnect failed, reset queued, reset sent, reset acked.
- [ ] R36.5. Add client diagnostics for graphics receive errors, reconnect attempts, reset request path, and stale frame discard after reconnect.
- [ ] R36.6. Add tests proving a graphics stream receive error reconnects, reset request does not depend on the dead stream, stale pre-reconnect frames cannot overwrite the reset generation, and HEVC datagrams continue while graphics reconnects.
- [ ] R36.7. Acceptance: physical scroll run has no unrecovered `graphics-reset-request-failed ... Socket is not connected` loop, and copyRect resumes after one forced graphics stream close.

## v0 Phase 3: accepted-scroll HEVC suppression

Phase goal: prevent full-screen HEVC from competing with copyRect during text scroll.

- [ ] R37.1. In `host/AgentDeskHost/OwnedMediaTransport.swift`, make accepted scroll an explicit HEVC admission suppressor until the configured scroll-idle refresh window expires.
- [ ] R37.2. Keep `AGENTDESK_HYBRID_SCROLL_HEVC_FPS=0` as the default and treat nonzero values as diagnostics-only tuning, not the production path.
- [ ] R37.3. Force exactly one HEVC full-surface refresh after `AGENTDESK_HYBRID_SCROLL_IDLE_REFRESH_MS`, then return to rest cadence.
- [ ] R37.4. Ensure late HEVC refreshes still obey `(surfaceGeneration, frameId)` ordering and cannot overwrite newer graphics commands.
- [ ] R37.5. Add tests proving accepted scroll suppresses HEVC, rejected or timed-out scroll falls back to HEVC, idle emits one refresh, nonzero scroll HEVC FPS is rate-limited, and stale HEVC refresh is discarded after newer graphics commit.
- [ ] R37.6. Acceptance: during accepted scroll, host HEVC bytes drop near zero until idle refresh, while graphics ACKs continue advancing.

## v0 Phase 4: graphics lifecycle ACK and backpressure

Phase goal: pace retained graphics frames using the graphics surface lifecycle.

- [ ] R38.1. Extend `OwnedGraphicsFrameAck` in host/client shared types with compact fields for `queueDepthBytes`, `queuedFrames`, `totalGraphicsFramesApplied`, and `compositorMs`.
- [ ] R38.2. Track graphics in-flight frames and bytes on the host by `(surfaceGeneration, frameId)` and clear them only when graphics ACKs arrive.
- [ ] R38.3. Add host graphics admission policy: normal admits a small number of unacked graphics frames, behind coalesces to latest raw capture, severe sends no new graphics commands until ACKs clear or reconnect/reset fires.
- [ ] R38.4. Keep graphics coalescing upstream of command construction so stale captures do not build LZFSE strips that will never be sent.
- [ ] R38.5. Add client queue-depth diagnostics before `OwnedSurfaceCompositor` mutation and after visible layer commit.
- [ ] R38.6. Add tests proving graphics ACKs clear in-flight frames, queue depth enters behind mode, severe mode coalesces raw captures without building command payloads, and reset frames bypass normal coalescing only when generation advances.
- [ ] R38.7. Acceptance: repeated scroll shows graphics admitted FPS near 12 to 15 under motion, low queue depth, and no long graphics ACK stalls.

## v0 Phase 5: fallback HEVC guardrails

Phase goal: keep HEVC useful as a fallback without letting it hide retained-path failures.

- [ ] R39.1. Add explicit diagnostics when scroll timeout or graphics disconnect causes HEVC fallback, including fallback reason and encoded frame byte count.
- [ ] R39.2. Cap fallback HEVC damage during active scroll by coalescing raw captures and limiting recovery keyframes to decoder-continuity failures, not graphics stream failures.
- [ ] R39.3. Keep existing HEVC drain tuning in place but remove any path that treats HEVC drain recovery as success while copyRect is not firing.
- [ ] R39.4. Add tests proving graphics failure fallback does not request repeated HEVC keyframes, HEVC drain does not mark retained graphics healthy, and fallback reasons appear in diagnostics.
- [ ] R39.5. Acceptance: if copyRect fails, logs say so directly and HEVC fallback remains usable rather than freezing silently.

## v0 Phase 6: physical comparison

Phase goal: decide whether the retained scroll path beats the current HEVC-only ceiling.

- [ ] R40.1. Run `just fresh-hybrid-consoled-run` on physical iPhone with default HEVC 420 and retained graphics enabled.
- [ ] R40.2. Scroll repeatedly for 20 to 30 seconds and save `tools/hybrid-graphics-diagnostics-summary.sh` output.
- [ ] R40.3. Compare against the archived first hybrid run: scroll timeout rate, copyRect count, HEVC bytes during scroll, graphics ACK RTT, render gaps, drain events, and user-visible freeze reports.
- [ ] R40.4. Acceptance: rest text remains HEVC-crisp, accepted scroll is driven by copyRect plus exposed strips, HEVC does not compete during active scroll, and the screen does not freeze after sustained motion.
- [ ] R40.5. If acceptance fails, classify the blocker as probe accuracy, graphics reconnect, graphics queue depth, compositor cost, LZFSE strip cost, CALayer commit, HEVC fallback, or network transport before the next edit.

---

## v0 full mixed graphics scope (captured, not started)

This scope opens only after R40 proves scroll-first retained graphics works or identifies a bottleneck that requires the broader mixed-mode architecture.

| Option | Source | What it catches | Failure shape |
| ------ | ------ | --------------- | ------------- |
| Full dirty-region classifier | Microsoft-style mixed graphics | Non-scroll text edits and cursor-near text changes without full HEVC frames | CPU detection and ordering complexity can exceed saved bytes |
| Region HEVC / codec atlas | Future `codecTile` command | Image/video-heavy regions without full-screen codec pressure | Decoder/compositor synchronization becomes the hard part |
| Metal or IOSurface compositor | Client renderer upgrade | Moves BGRA copy, tile paint, and commit cost off the main thread | More renderer complexity before correctness is proven |
| QUIC FEC or transport loss-delay control | RDP UDP-like recovery | Packet-loss-heavy networks after command model works | Current evidence points to detection/admission starvation, not packet loss |

### Alternative arc (rejected for now, captured)

- More HEVC drain tuning. Useful as a fallback guardrail. Rejected as the primary path because the freeze run showed copyRect was not firing and HEVC continued carrying motion until admission drained. Revisit only after scroll detection and graphics stream durability are healthy.
- Full Microsoft mixed mode now. Useful because it handles text, images, video, and arbitrary dirty regions. Rejected because the current failure is narrower: scroll-copy is timing out and graphics transport is not durable. Revisit after scroll-first ownership proves or disproves the retained-surface spine.
- Pure retained graphics with no HEVC active path. Useful because it removes full-screen codec competition. Rejected because HEVC remains the best observed rest-quality ceiling and is still needed for full-frame correctness refreshes.

---

## Promotion log

```
D27-D32   2026-06-20  archived    initial scroll-first hybrid retained graphics implementation moved to tasks/archive
R34       pending     pending     evidence gate and hybrid diagnostics summary
R35       pending     pending     cheap scroll detection before full BGRA payload work
R36       pending     pending     durable graphics stream reconnect and reset recovery
R37       pending     pending     accepted-scroll HEVC suppression until idle refresh
R38       pending     pending     graphics lifecycle ACK and queue-depth backpressure
R39       pending     pending     fallback HEVC guardrails after retained-path failures
R40       pending     pending     physical iPhone comparison and blocker classification
```
