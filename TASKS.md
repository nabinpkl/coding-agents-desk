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

- [x] R35.1. Refactor `host/AgentDeskHost/ScrollDeltaEngine.swift` into a two-stage detector: sampled luma or downsampled probe first, full exposed-strip extraction only after an offset is accepted.
- [x] R35.2. Replace full-resolution BGRA comparison in `bestScrollOffset` with sampled bands that can evaluate vertical and horizontal offsets without copying the entire frame.
- [x] R35.3. Preserve the current acceptance contract: max offset 240 px, stride 8 px, confidence `>= 0.92`, timeout fallback to HEVC, and no graphics command on rejected motion.
- [x] R35.4. Add diagnostics for probe time, payload-build time, accepted offset, confidence, timeout reason, and sampled pixel count.
- [x] R35.5. Add tests proving accepted vertical and horizontal scroll build `copyRect` plus exposed-strip `bitmapTile` only after probe acceptance, non-scroll motion emits no command, and a forced probe timeout does not allocate exposed-strip payload.
  - 2026-06-21 progress: direct BGRA probe, host diagnostic logs, and scroll unit coverage landed locally. Physical timeout-rate acceptance remains R35.6.
  - 2026-06-21 progress: direct 420 luma probing now accepts a 32 px scroll before payload build, and the probe returns as soon as confidence crosses the threshold instead of timing out after a valid match.
- [ ] R35.6. Acceptance: physical scroll run shows scroll detector timeout rate below 20 percent of scroll frames and sustained `copyRects>0` on the client.

## v0 Phase 2: durable graphics stream

Phase goal: make the reliable graphics channel recoverable enough to carry stateful surface commands.

- [x] R36.1. Extend `host/AgentDeskHost/OwnedMediaTransport.swift` and `client/AgentDeskClient/OwnedMediaTransport.swift` so graphics stream disconnect, timeout, receive failure, and send failure enter a reconnect state instead of permanently disabling retained graphics.
- [x] R36.2. Route graphics reset requests through a live fallback control path when the graphics stream is disconnected, then force a graphics-stream reconnect and next-generation `resetSurface`.
- [x] R36.3. Keep graphics reconnect validation scoped to the active session identity and fresh graphics hello/ready nonces, without marking the graphics capability stale after the first connection.
- [x] R36.4. Add host diagnostics for graphics channel state: connected, disconnected, reconnecting, reconnect failed, reset queued, reset sent, reset acked.
- [x] R36.5. Add client diagnostics for graphics receive errors, reconnect attempts, reset request path, and stale frame discard after reconnect.
- [x] R36.6. Add tests proving a graphics stream receive error reconnects, reset request does not depend on the dead stream, stale pre-reconnect frames cannot overwrite the reset generation, and HEVC datagrams continue while graphics reconnects.
- [ ] R36.7. Acceptance: physical scroll run has no unrecovered `graphics-reset-request-failed ... Socket is not connected` loop, and copyRect resumes after one forced graphics stream close.

## v0 Phase 3: accepted-scroll HEVC suppression

Phase goal: prevent full-screen HEVC from competing with copyRect during text scroll.

- [x] D37.1. In `host/AgentDeskHost/OwnedMediaTransport.swift`, make accepted scroll an explicit HEVC admission suppressor until the configured scroll-idle refresh window expires.
- [x] D37.2. Keep `AGENTDESK_HYBRID_SCROLL_HEVC_FPS=0` as the default and treat nonzero values as diagnostics-only tuning, not the production path.
- [x] D37.3. Force exactly one HEVC full-surface refresh after `AGENTDESK_HYBRID_SCROLL_IDLE_REFRESH_MS`, then return to rest cadence.
- [x] D37.4. Ensure late HEVC refreshes still obey `(surfaceGeneration, frameId)` ordering and cannot overwrite newer graphics commands.
- [x] D37.5. Add tests proving accepted scroll suppresses HEVC, idle emits one refresh, and nonzero scroll HEVC FPS is rate-limited, with existing scroll-timeout and stale-update ordering tests covering fallback and discard invariants.
- [ ] R37.6. Acceptance: during accepted scroll, host HEVC bytes drop near zero until idle refresh, while graphics ACKs continue advancing.

## v0 Phase 4: graphics lifecycle ACK and backpressure

Phase goal: pace retained graphics frames using the graphics surface lifecycle.

- [x] D38.1. Extend `OwnedGraphicsFrameAck` in host/client shared types with compact fields for `queueDepthBytes`, `queuedFrames`, `totalGraphicsFramesApplied`, and `compositorMs`.
- [x] D38.2. Track graphics in-flight frames and bytes on the host by `(surfaceGeneration, frameId)` and clear them only when graphics ACKs arrive.
- [x] D38.3. Add host graphics admission policy: normal admits a small number of unacked graphics frames, behind coalesces to latest raw capture, severe sends no new graphics commands until ACKs clear or reconnect/reset fires.
- [x] D38.4. Keep graphics coalescing upstream of command construction so stale captures do not build LZFSE strips that will never be sent.
- [x] D38.5. Add client queue-depth diagnostics before `OwnedSurfaceCompositor` mutation and after visible layer commit.
- [x] D38.6. Add tests proving graphics ACKs clear in-flight frames, queue depth enters behind/severe mode, compositor-only behind mode cannot deadlock, and reset frames bypass admission holds only through the explicit reset path.
- [ ] R38.7. Acceptance: repeated scroll shows graphics admitted FPS near 12 to 15 under motion, low queue depth, and no long graphics ACK stalls.

## v0 Phase 5: fallback HEVC guardrails

Phase goal: keep HEVC useful as a fallback without letting it hide retained-path failures.

- [x] D39.1. Add explicit diagnostics when scroll timeout or graphics disconnect causes HEVC fallback, including fallback reason and encoded frame byte count.
- [x] D39.2. Cap fallback HEVC damage during active scroll by coalescing raw captures and limiting recovery keyframes to decoder-continuity failures, not graphics stream failures.
- [x] D39.3. Keep existing HEVC drain tuning in place but remove any path that treats HEVC drain recovery as success while copyRect is not firing.
- [x] D39.4. Add tests proving graphics failure fallback does not request repeated HEVC keyframes, HEVC drain does not mark retained graphics healthy, and fallback reasons appear in diagnostics.
- [ ] R39.5. Acceptance: if copyRect fails, logs say so directly and HEVC fallback remains usable rather than freezing silently.

## v0 Phase 6: physical comparison

Phase goal: decide whether the retained scroll path beats the current HEVC-only ceiling.

- [ ] R40.1. Run `just fresh-hybrid-consoled-run` on physical iPhone with default HEVC 420 and retained graphics enabled.
- [ ] R40.2. Scroll repeatedly for 20 to 30 seconds and save `tools/hybrid-graphics-diagnostics-summary.sh` output.
- [ ] R40.3. Compare against the archived first hybrid run: scroll timeout rate, copyRect count, HEVC bytes during scroll, graphics ACK RTT, render gaps, drain events, and user-visible freeze reports.
- [ ] R40.4. Acceptance: rest text remains HEVC-crisp, accepted scroll is driven by copyRect plus exposed strips, HEVC does not compete during active scroll, and the screen does not freeze after sustained motion.
- [ ] R40.5. If acceptance fails, classify the blocker as probe accuracy, graphics reconnect, graphics queue depth, compositor cost, LZFSE strip cost, CALayer commit, HEVC fallback, or network transport before the next edit.

## v0 Phase 7: input-guided scroll-copy activation

Phase goal: make copyRect fire by using host scroll input as the classifier prior, then verifying a narrow pixel candidate set instead of scanning the whole surface.

- [x] D41.1. Add a host-only `ScrollActivityTracker` that records recent `NormalizedInput.scroll(dx:dy:phase)` events before `InputDispatcher.dispatch(_:)` and exposes active hints with axis, sign, predicted offset, candidate offsets, active-until time, and event count.
- [x] D41.2. Wire the input event loop to record scroll hints before dispatching CGEvents, and pass the latest active hint into `OwnedMediaTransport` and `ScrollDeltaEngine.evaluate`.
- [x] D41.3. Add a hint-guided `ScrollDeltaProbe` path that verifies only same-axis, same-sign candidates from the input prediction, accepts confidence `>= 0.88`, breaks adjacent ties by closeness to predicted offset, and rejects zero-motion ambiguity.
- [x] D41.4. Keep blind scan as no-hint fallback only, still bounded by the 4 ms budget and still falling back to HEVC on timeout or rejected motion.
- [x] D41.5. Make active-hint timeout log `scroll-hint-timeout` and allow HEVC fallback only when no graphics update has been accepted for 120 ms.
- [x] D41.6. Extend diagnostics and `tools/hybrid-graphics-diagnostics-summary.sh` to report hint-guided accepted frames, hint timeouts, blind timeouts, copyRects, HEVC fallback reason counts, and max probe ms.
- [x] D41.7. Add host tests for signed candidate generation, hint expiry, hint-guided 1 px, 15 px, and 80 px vertical scroll acceptance, sequential latest-delta scroll acceptance with cumulative fallback candidates, predicted-offset tie break, zero-motion ambiguity rejection, bounded candidate counts, no-hint fallback behavior, and accepted-scroll copyRect payload construction.
- [x] D41.8. Retire the R41 physical acceptance gate: the latest physical iPhone run activated retained scroll and produced copyRect evidence, but sustained ownership failed, so continuation is split into R42-R46.

## v0 Phase 8: retained scroll ownership

Phase goal: keep scroll motion owned by retained graphics after activation instead of falling back to blind scan or competing HEVC.

- [x] D42. Add a scroll ownership latch in `host/AgentDeskHost/ScrollActivityTracker.swift` and `host/AgentDeskHost/OwnedMediaTransport.swift` that persists the accepted scroll axis, sign, and recent frame ownership until idle release, with diagnostics for `ownership=accepted`, `ownership=miss`, and `ownership=released`.
- [x] D43. Replace the active-scroll blind-scan path in `host/AgentDeskHost/ScrollDeltaEngine.swift` with a no-blind-scan ownership candidate path that logs `hintSource=input`, `hintSource=ownership`, or `hintSource=blind` and keeps blind probing only outside an active ownership latch.
- [x] D44. Gate HEVC fallback in `host/AgentDeskHost/OwnedMediaTransport.swift` so active retained ownership suppresses full-frame HEVC on transient ownership misses, logs suppressed-by-ownership counts, and releases to HEVC only after the ownership latch idles or explicitly fails.
- [x] D45. Stripe retained graphics resets across bounded payloads in `host/AgentDeskHost/OwnedMediaTransport.swift` using the retained-surface reset and tile commands already consumed by the client compositor, with reset stripe count, reset stripe ACK timeout, and max reset stripe bytes exposed in diagnostics.
- [ ] R46. Run a physical iPhone comparison with `just fresh-hybrid-consoled-run`, save `tools/hybrid-graphics-diagnostics-summary.sh` output, and classify whether sustained ownership, HEVC fallback gating, striped reset, compositor cost, or transport loss remains the blocker.

## v0 Phase 9: graphics reset and HEVC fallback freeze fix

Phase goal: recover the retained graphics channel without letting HEVC flood the screen while reset ownership is unresolved.

- [x] D47. Introduce active graphics channel identity in `host/AgentDeskHost/OwnedMediaTransport.swift` so each reset, ACK wait, reconnect, and stale frame discard is scoped to the currently installed graphics channel rather than any still-referenced old connection.
- [x] D48. Replace reset stripe ACK waiting in `host/AgentDeskHost/OwnedMediaTransport.swift` with a reset ACK state machine that records sent, wait-success, timeout, reconnect-required, and abandoned states per reset generation.
- [x] D49. Add a HEVC fallback valve in `host/AgentDeskHost/OwnedMediaTransport.swift` that suppresses fallback flood during graphics recovery, allows bounded continuity refresh only after the reset state machine releases it, and logs the valve reason for every suppression or release.
- [x] D50. Extend `tools/hybrid-graphics-diagnostics-summary.sh`, `tools/hybrid-graphics-diagnostics-summary-tests.sh`, and `tests/fixtures/owned-media/` to report active-channel replacement, reset ACK wait success or timeout, graphics recovery state, and HEVC fallback suppression while preserving the existing scroll, reset, HEVC, queue, and drain summary lines.
  - 2026-06-21 result: diagnostics parser and fixture cover reset stripes applied, reset ACK timeout after one successful stripe ACK, graphics disconnect, HEVC 100-plus packet flood, HEVC suppression during recovery, and client `copyRects=0`.
- [ ] R51. Run the physical comparison with `just fresh-hybrid-consoled-run`, save the diagnostics summary, and classify whether the remaining blocker is active-channel identity, reset ACK state, HEVC fallback valve release, client compositor cost, or transport loss.

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

## v0 Phase: code pairing for remote/TestFlight clients

Phase goal: let a remote iPhone pair by typing a short code, with no QR, no Mac-side launch, and no Apple capability. Replaces the reverted iCloud handoff. Decisions in ADR-0018. Independent of the retained-scroll work above; shares the worktree only.

- [x] R53.1. Revert the iCloud pairing handoff (commit) and clean the worktree `.env`, restoring a green clean base.
- [x] R53.2. Add the shared `LocatorCode` codec (`host/.../LocatorCode.swift`, `client/.../LocatorCode.swift`, byte-identical): pack 22-bit CGNAT host part + 30-bit fetch token into 12 Crockford base32 chars with a check symbol; `formatted()` rejects non-CGNAT, `decode` rejects length/checksum/invalid-char and normalizes case + I/L/O. Wire both into app and test targets.
- [x] R53.3. Host: add fetch-token store to `Pairing` (`mintLocatorPairing`, one-use TTL `consumeFetchToken`, per-minute rate limit), a `payload-fetch` first frame (router case + `PairingPayloadFetchRequest/Response` + handler returning the signed payload only on a valid token), and `Config` knobs `fetchTokenTTL`/`fetchRatePerMin`.
- [x] R53.4. Client: `PairingClient.acceptLocatorCode` + `fetchPayload` (dial `wss://<ipv4>:port/pair`, pull the payload, route into the unchanged `performHandshake`), and `resolvedHostForLocator`.
- [x] R53.5. UI: host popover shows the code under the QR; client replaces the removed iCloud button with an "Enter code" action and `handleLocatorCode`.
- [x] R53.6. Tests: `LocatorCodeTests` (round-trip, CGNAT rejection, length/checksum/invalid-char, normalization, parity string) both targets; `PairingTests` (retain+consume-once, TTL expiry, rate limit); `payload-fetch` routing; client decode + malformed + parity. Green host signing-disabled and client simulator.
- [x] R53.7. Production CGNAT-only `URLSessionDelegate` so the IP-literal fetch is trusted (FQDN dials keep default validation), leaning on the signed payload anchor.
- [x] R53.8. Docs: ADR-0018, `.env.example` knobs, `just print-pair-code`.
- [ ] R53.9. Acceptance (physical, HITL): iPhone + Mac on one tailnet; read the code from the menu-bar popover, type it on the phone (no QR, no launch), approve on the Mac, reach a live session. Exercises the production CGNAT TLS path.

---

## Promotion log

```
D27-D32   2026-06-20  archived    initial scroll-first hybrid retained graphics implementation moved to tasks/archive
R34       pending     pending     evidence gate and hybrid diagnostics summary
R35       pending     pending     cheap scroll detection before full BGRA payload work
R36       pending     pending     durable graphics stream reconnect and reset recovery
R35/R36   2026-06-21  committed   420 luma scroll probes accept before timeout and graphics capability reconnects inside the active session
R36.1-R36.6 2026-06-21  committed   durable graphics reconnect, fallback reset control, bounded retry policy, and contract tests
R37.1-R37.5 2026-06-21  committed   accepted-scroll HEVC suppression and one idle refresh covered by host tests
R37.6     pending     pending     physical accepted-scroll HEVC suppression acceptance
R38.1-R38.6 2026-06-21  committed   graphics ACK queue fields, host graphics admission, and client queue diagnostics
R38.7     pending     pending     physical graphics ACK/backpressure acceptance
R39.1-R39.4 2026-06-21  committed   HEVC fallback reasons, graphics-failure keyframe guardrail, and diagnostics summary coverage
R39.5     pending     pending     physical fallback observability acceptance
R40       2026-06-21  blocked     physical iPhone unavailable after devicectl tunnel reset; simulator console smoke launched but did not exercise scroll copyRect
R40       pending     pending     physical iPhone comparison and blocker classification
R41.1-R41.7 2026-06-21  committed   input-guided scroll hints, narrow probe candidates, diagnostics summary, and host tests
R41.8     2026-06-21  retired     physical run activated retained scroll but sustained ownership failed; continuation split into R42-R46
D42       2026-06-21  committed   scroll ownership latch with accepted, miss, and idle release diagnostics
D43       2026-06-21  committed   active ownership uses bounded candidates and labels blind scans explicitly
D44       2026-06-21  committed   HEVC fallback waits for ownership miss budget or fallback delay
D45       2026-06-21  committed   retained reset stripes are sent with ACK waits and bounded decoded payloads
R46       pending     pending     physical comparison for sustained ownership
D47-D49   2026-06-21  committed   active graphics channel identity, reset ACK state machine, and HEVC fallback valve
D50       2026-06-21  committed   diagnostics summary and freeze fixture updated for reset and HEVC recovery
R51       pending     pending     physical comparison for graphics reset and HEVC fallback freeze fix
R53.1     2026-06-21  committed   reverted iCloud pairing handoff; clean base restored
R53.2-R53.8 2026-06-21  committed   locator-code pairing: codec, host fetch-token store and payload-fetch frame, client enter-code path, CGNAT TLS trust, tests, ADR-0018, docs
R53.9     pending     pending     physical TestFlight code-pairing acceptance
```
