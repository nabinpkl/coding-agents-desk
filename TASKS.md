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
  - 2026-06-22 result: activation passed and the app did not disconnect, but freezes remain. The run showed `copyRects=879`, host scroll accepted `880`, client avg compositor `24.85ms`, max render gap `12010ms`, host HEVC fallbacks `583`, and reset ACK flapping. Remaining blockers are HEVC competition, CPU copyRect compositor cost, and reset ACK matching.

## v0 Phase 10: retained scroll freeze fix

Phase goal: keep retained graphics as the only active-scroll surface and make copyRect cheap enough that it does not feel stepwise.

- [x] D52. Tighten the host HEVC valve in `host/AgentDeskHost/OwnedMediaTransport.swift` so active scroll ownership and recent copyRect acceptance suppress HEVC for scroll timeout, rejected motion, ownership miss, periodic keyframe, and idle refresh until the configured idle window.
- [x] D53. Keep the idle correctness refresh as exactly one HEVC refresh after `AGENTDESK_HYBRID_SCROLL_IDLE_REFRESH_MS`, then return to retained ownership as soon as input or copyRect resumes.
- [x] D54. Keep graphics recovery HEVC bounded to one scaled correctness refresh per `AGENTDESK_HYBRID_GRAPHICS_FALLBACK_MIN_INTERVAL_MS`, and ensure reset or send timeout cannot open an HEVC flood.
- [x] D55. Optimize `client/AgentDeskClient/OwnedMediaVideoSink.swift` so ordinary graphics frames mutate the retained surface in place, use overlap-safe `memmove` for copyRect, and do not clone the full BGRA surface for one small scroll update.
- [x] D56. Extend graphics diagnostics with copyRect, tile-decode, tile-paint, and image-commit timing buckets, plus reset ACK matched or missed counts in the host summary.
- [ ] R57. Run `just check`, then run physical `just fresh-hybrid-consoled-run` and accept only if copyRects remain active, active-scroll HEVC frames stay under five, no render gap exceeds 1000ms, avg compositor is under 10ms, max compositor is under 20ms, and rest text refreshes after idle.
- [x] D58. Keep the owned-media control channel alive while retained graphics owns scroll, so sparse HEVC/full-frame traffic does not let the media QUIC connection idle into timeout and terminate the session.
- [x] D59. Scale host scroll input hints before pixel verification, because the physical run accepted hundreds of copyRects but many were only one-pixel moves and looked frozen.
- [x] D60. Retire the latest physical result: copyRect stayed active, but geometry was wrong because the host emitted full-surface scroll copies, visibly shifting the whole retained desktop instead of the scrolled region.

## v0 Phase 11: region-scoped scroll copy

Phase goal: make retained scroll-copy operate only inside a stable input-focused scroll region, with HEVC fallback until the region is known.

- [x] D61. Add a host scroll region source in `host/AgentDeskHost/ScrollRegionTracker.swift` that samples the host focus point at scroll dispatch time, selects the frontmost normal on-screen window containing that point via a testable window-list provider, and falls back to a cursor-centered region clamped to the capture surface.
- [x] D62. Extend `host/AgentDeskHost/InputDispatcher.swift`, `host/AgentDeskHost/AppDelegate.swift`, and `host/AgentDeskHost/OwnedMediaTransport.swift` so scroll input records focus point and the media transport receives the latest active input-focused region candidate beside the existing scroll hint.
- [x] D63. Scope `host/AgentDeskHost/ScrollDeltaProbe.swift` and `host/AgentDeskHost/ScrollDeltaEngine.swift` to the stable region: probe samples only inside the region, copyRect and exposed-strip bitmapTile are emitted only inside that rectangle, and full-surface copyRect is rejected unless the stable region is the full surface.
- [x] D64. Gate retained scroll ownership on stable region lock: require two consecutive validated matches with same axis/sign and at least 80 percent region overlap before emitting copyRect, use HEVC fallback before lock, suppress HEVC during locked scroll, and release the lock on region drift, cursor exit, or two verification misses.
- [x] D65. Extend diagnostics and `tools/hybrid-graphics-diagnostics-summary.sh` with region source, stability, rect, fallback, full-surface copyRect count, HEVC-before-lock frames, HEVC-during-lock frames, and region release reasons.
- [x] D66. Add host/client coverage for window-region selection, cursor fallback clamping, stable-region locking, region-scoped vertical and horizontal copyRect envelopes, pixels outside the region staying unchanged, HEVC fallback before lock, and diagnostics summary parsing.
- [ ] R67. Run `just check`, then physical `just fresh-hybrid-consoled-run`; accept only if copyRects remain active, no whole-screen shift is visible, outside-scroll UI stays stable, active-scroll HEVC appears only before region lock or after region loss, and rest text refreshes after idle.

## v0 Phase 12: inner viewport scroll copy and HEVC recovery

Phase goal: promote region-scoped scroll copy from whole-window geometry to the actual inner scrolling viewport, and prevent HEVC or reset recovery from poisoning retained scroll ownership.

- [x] D68. Record the latest physical finding: copyRect is active and not full-desktop, but the stable region is the whole app window (`152,78,1874,2102`), HEVC fallback still redraws during scroll, and graphics reset/reconnect can end in malformed receive failure.
- [x] D69. Add a host `ScrollViewportTracker` that derives a stable inner viewport from shifted-pixel evidence inside the outer window region, requiring two matching validations, minimum size, 80 percent overlap, and a visible chrome/sidebar inset before lock.
- [x] D70. Scope `ScrollDeltaEngine` envelopes to the stable viewport only: copyRect and exposed-strip bitmapTile stay inside the viewport, whole-window copy is rejected, and no viewport lock emits no graphics envelope.
- [x] D71. Split HEVC fallback from retained-baseline realignment: suppress HEVC whenever the host cannot realign the retained baseline, and run `observeFallbackFrame` only after idle correctness refresh or an allowed realignment state.
- [x] D72. Harden graphics reset and stream durability: typed EOF/frame/control errors replace generic malformed on stream closure, reset requests are de-duplicated per generation, reconnect forces a fresh generation reset, and reset stripes satisfy both decoded-byte and wire-byte caps.
- [x] D73. Extend diagnostics summary and fixtures to report viewport-locked copyRects, whole-window copyRects, HEVC visual-only fallbacks, HEVC baseline realignments, graphics EOF versus malformed, and reset retry suppression.
- [ ] R74. Run `just check`, then physical `just fresh-hybrid-consoled-run`; accept only if viewport-locked copyRects are active, whole-window copyRects are zero, outside-scroll chrome/sidebar stays fixed, HEVC baseline realignment happens only after idle, and graphics reset does not loop into malformed reconnect churn.

## v0 Phase 13: viewport-first scroll ownership

Phase goal: stop treating viewport detection as a post-acceptance refinement. The failed R74 physical run showed reset stripes were ACKed and graphics compositor cost was low, but scroll never accepted: host scroll `accepted=0`, `timeout=688`, `blindTimeout=570`, client `copyRects=0`, and HEVC carried motion with render gaps up to `6096ms`. The current pipeline must classify the inner viewport before expensive full-window offset scanning.

- [ ] R75. Record host scroll input diagnostics in `host/AgentDeskHost/ScrollActivityTracker.swift` and `host/AgentDeskHost/OwnedMediaTransport.swift`, logging raw scroll `dx`, `dy`, phase, scaled predicted offset, candidate offsets, hint expiry, and whether the encode pump consumed an active input or ownership hint.
- [ ] R76. Replace `ScrollDeltaEngine` ordering so active input or ownership never runs blind 960-candidate probing; active scroll uses bounded candidates only, and a miss returns `viewport-search-miss` or `owned-scroll-miss` without HEVC baseline realignment.
- [ ] R77. Add a viewport-first probe in `host/AgentDeskHost/ScrollViewportTracker.swift`: use the active scroll axis/sign and outer window region to find likely inner scrolling bands directly, then verify offset only inside the candidate viewport before any `copyRect` envelope is built.
- [ ] R78. Change `host/AgentDeskHost/OwnedMediaTransport.swift` HEVC fallback during active viewport search so repeated `scroll-timeout` does not call `observeFallbackFrame(frame)` and does not send a full-frame HEVC refresh more than the bounded recovery interval.
- [ ] R79. Extend `tools/hybrid-graphics-diagnostics-summary.sh` to report input-hint consumption, viewport-search misses, active-scroll blind-scan count, active-scroll HEVC baseline realignment count, and viewport-first acceptance count.
- [ ] R80. Add tests proving active scroll cannot enter blind scan, viewport-first probing locks an inner body rectangle before full-window offset acceptance, scroll-timeout during active viewport search does not realign the retained baseline, and physical `just fresh-hybrid-consoled-run` shows `viewport-locked copyRects > 0`.

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

## v0 Phase: Mac-initiated tailnet pairing for remote/TestFlight clients

Phase goal: let a remote iPhone pair with no typing and no QR by leaning on the Tailscale mesh both devices already share. The Mac lists tailnet peers, the user picks the iPhone (that pick is the host-side authorization), and the Mac pushes a signed pairing offer over a dedicated plain-TCP port; the iPhone runs the unchanged handshake and the host auto-approves the pre-approved nonce. Replaces the reverted locator-code path. Decisions in ADR-0019. Independent of the retained-scroll work above; shares the worktree only.

- [x] R54.0. Revert the locator-code pairing (commit) to restore a green clean base: QR + SIGUSR1 + the original handshake intact.
- [x] R54.1. Shared `PairingOfferFrame` length-prefixed codec + streaming parser in both `SharedTypes.swift` copies; `Config.offerPort` (default 41890, `AGENTDESK_OFFER_PORT`) in both targets; round-trip / chunked / zero-length tests.
- [x] R54.2. Host: decode the `Peer` map in `TailnetDiscovery`, add `peerDevices()` returning `TailnetDeviceOption` (drops IPv4-less peers, orders online iOS first); extract a pure `TailscaleStatusParser` with `TailnetDiscoveryTests`.
- [x] R54.3. Host: `Pairing` pre-approval (`markPreApproved`/`consumePreApproval`, swept with the nonce, no second consumption point); `PairingSignalingServer.handlePair` issues the token directly for a pre-approved nonce; `PairingTests` additions.
- [x] R54.4. Host: `PairingOfferSender` (outbound plain TCP, length-prefixed offer) and the menu-bar device picker (`PopoverViewController.devicePicker`, `AppDelegate.showDevicePicker`/`pairWithDevice` mint+mark+push). QR stays on SIGUSR1.
- [x] R54.5. Client: `PairingOfferListener` (inbound `NWListener` on the offer port) feeding the unchanged `handleIncomingPairingURL`; `NSLocalNetworkUsageDescription`; unpaired screen shows this device's tailnet IPv4; listener torn down on background.
- [x] R54.6. Docs: ADR-0019, README index, this block.
- [x] R54.8. Show which device the host paired with: carry the picked tailnet hostname through pre-approval (`markPreApproved(name:)` -> `consumePreApproval` -> `setName`), persist it on `PairedDeviceRecord.name`, and show it (with the fingerprint as a secondary line) in the host popover. The pick path never prompts (the pick is the authorization), independent of `AGENTDESK_AUTO_APPROVE`.
- [ ] R54.7. Acceptance (physical, HITL): iPhone + Mac on one tailnet; open AgentDesk on the phone, pick it in the Mac popover, reach a live session with no typing and no QR. Confirms the PRIMARY RISK (inbound TCP over utun); if it fails, fall back to iPhone-dials-Mac per ADR-0019.

---

## v0 Phase: live tailnet device discovery

Phase goal: the device picker should list real iPhones by name, live, with no stored state. Tailscale carries no broadcast/multicast, so discovery is host-initiated unicast: the Mac probes online iOS peers and lists the ones that identify themselves. Replaces labeling peers by their Tailscale hostname (always "localhost" on iOS). Decisions folded into ADR-0019.

- [x] R55.1. Generalize the offer-port framing to carry any JSON body (`OfferPortFrame`/`OfferPortFrameParser` yield `Data`); add `DeviceIdentityRequest` (whois), `DeviceIdentity`, and `OfferPortMessage.classify` routing; update the offer-frame tests.
- [x] R55.2. Client answers a host whois on the offer port with its display-only identity; `PairingClient.deviceDisplayName()` reused for the handshake name; the listener snapshots `localIdentity` at start.
- [x] R55.3. Host `TailnetIdentityProber` (dial peer offer port, whois, read identity, 1.5s timeout); `showDevicePicker` probes online iOS peers concurrently behind a Scanning state and lists only responders by reported name.
- [x] R55.4. Docs: ADR-0019 live-discovery refinement, this block.
- [ ] R55.5. Acceptance (physical, HITL): with AgentDesk open on the iPhone, the Mac picker shows it by name (not "localhost") within a couple of seconds; picking it pairs.

---

## v0 Phase: content-addressed tile cache (ADR-0021)

Phase goal: make a regional scroll and any repeated on-screen content nearly free on the ~2Mbps reliable graphics channel, with crisp lossless text. Damage is gridded into fixed cells; each dirty cell runs a decision ladder (rung 1 omit if it matches the retained baseline, rung 2 `drawCachedTile` if its content hash hits an LRU slot the client already holds, rung 3 `cacheTile` paint-and-store). `.fullFrame` rides the same ladder, so an all-cached whole-surface frame ships zero bytes instead of a ~338KB JPEG (the prior freeze). Design and plan: `docs/superpowers/specs/2026-06-24-content-tile-cache-design.md`, `docs/superpowers/plans/2026-06-24-content-tile-cache.md`.

- [x] TileCache-P0. Prefactor (no behavior change): delete dead `codecTile` wire case, `ScrollRegionTracker` machinery, 5 unused viewport config knobs; unify the three tile-build paths into one `buildTile` seam.
- [x] TileCache-P1. Rung 1: omit a dirty cell whose pixels equal the retained baseline; an all-unchanged tiles frame becomes `.noChange` (freeze fix, no wire change).
- [x] TileCache-P2. Rungs 2-3: `TileContentCache` host unit, `cacheTile`/`drawCachedTile` wire commands, client slot store and handlers, engine decision ladder, LRU recency refresh on draw-cached hits, per-frame cacheStores/cacheHits logging.
- [x] Phase A. Dead-code purge exposed by the prefactor: HEVC type hierarchy and encoder-config fields, QUIC datagram owned-media channel + SharedTypes, owned-graphics admission, scroll-ownership and HEVC-fallback machinery, cadence/motion-budget config, and the write-only datagram media-capability validation cluster.
- [x] Phase B. Cache-ladder unification: route `.fullFrame` through rung 1/2/3, per-tile rung-3 encoding choice (LZFSE for text, JPEG for busy cells), per-frame byte budget bounding a brand-new fullframe; ADR-0021 accepted (supersedes ADR-0015 and ADR-0016).
- [x] Phase C. Scroll-detection cleanup: lift the 13 `DamageScrollClassifier` thresholds into `Config` (`AGENTDESK_HYBRID_CLASSIFIER_*`); derive scroll axis from band geometry so copyRect is attempted when the input hint window has lapsed (single sub-surface band, surface-verified, conservative against disjoint-block and full-surface false positives); raise the tile-coverage gate 0.15 -> 0.6 now that fullframe rides the ladder.
- [ ] TileCache-Acc. Acceptance (physical/sim, user-driven HITL): bursty CLI scroll lands `acceptedBy=damage` with `hintActive=false` and `copyRects>0`, `drawCachedTile` hits on re-exposed lines, `fullframe-scroll-miss` drops, text stays crisp, no freeze on sustained fast flicks.

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
R51       2026-06-22  done        physical run kept copyRect active without disconnect, but showed HEVC competition, compositor cost, and reset ACK flapping
D52-D56   2026-06-22  done        stricter active-scroll HEVC valve, in-place copyRect compositor, reset ACK parser fix, and `just check` green
R57       2026-06-22  blocked     physical run showed cheap active copyRects, avg compositor 3.12ms and max 7.90ms, but visible motion froze; media QUIC timed out to reconnecting and many retained moves were one-pixel `dy=-1`
D58-D59   2026-06-22  done        media keepalive plus 24 px input-scroll scaling; focused tests and `just check` green
D60       2026-06-22  retired     physical rerun showed copyRect active but wrong full-surface geometry; region-scoped copy starts at R61
D61-D66   2026-06-22  done        input-focused stable scroll region, region-scoped copyRect, diagnostics, and tests; `just check` green
R67       2026-06-22  retired     physical run fixed full-desktop copy but selected the whole app window, so inner viewport detection starts at R68
D68-D73   2026-06-22  done        inner viewport detection, viewport-scoped envelopes, HEVC baseline-safe suppression, graphics stream/reset diagnostics, and `just check` green
R74       2026-06-22  blocked     physical run froze: reset stripes ACKed, but host scroll accepted 0, blind timeouts 570, client copyRects 0, and HEVC carried motion with multi-second render gaps
R75-R80   pending     pending     viewport-first scroll ownership: input diagnostics, no active-scroll blind scan, viewport-first probe, HEVC baseline guard, summary coverage, physical acceptance
R54.0     2026-06-21  committed   reverted locator-code pairing; clean QR/handshake base restored
R54.1-R54.6 2026-06-22  committed   Mac-initiated tailnet pairing: offer codec, peer enumeration, host pre-approval, device picker + offer sender, client offer listener, ADR-0019
R54.7     2026-06-22  done        physical pick-to-pair worked: inbound TCP over utun confirmed, direct connection established
R54.8     2026-06-22  committed   host shows the picked device name (persisted on the paired record) instead of the opaque fingerprint
R54.9-R54.11 2026-06-22  committed   show active device when multiple paired, picker IPv4 rows, Tailscale-vs-carrier-CGNAT own-IP fix, client reports model+id name
R55.1-R55.4 2026-06-22  committed   live host-probe device discovery: offer-port identity protocol, client whois replies, iOS-peer prober + async picker, ADR-0019 refinement
R55.5     pending     pending     physical acceptance: picker lists the iPhone by name live
R56.1     2026-06-22  committed   host and client marketing versions decoupled (independent semver per release)
R56.2     2026-06-22  committed   protocol version negotiated at session handshake (ADR-0020); incompatible peer rejected as update-required
R57       2026-06-22  committed   fix on-device TLS failure: Release delegate accepts host cert chain on tailnet CGNAT IP literals (hostname check skipped), FQDN dials stay strict (ADR-0019)
R58       2026-06-22  committed   offer-sent state is escapable: Back button + 30s timeout return to the picker, cancelled when the device dials back
TileCache-P0 2026-06-24  committed   prefactor: delete codecTile/ScrollRegionTracker/viewport knobs, unify the three tile-build paths into one buildTile seam
TileCache-P1 2026-06-24  committed   rung-1 retained-baseline tile skip: unchanged cells omitted, all-unchanged frame becomes .noChange (freeze fix, no wire change)
TileCache-P2 2026-06-24  committed   rungs 2-3 content-addressed cache: TileContentCache host unit, cacheTile/drawCachedTile wire, client slot store, engine decision ladder, LRU recency
PhaseA       2026-06-24  committed   dead-code purge: HEVC hierarchy, QUIC datagram media channel, owned-graphics admission, scroll-ownership, cadence/motion-budget config, write-only media-capability cluster
PhaseB       2026-06-24  committed   cache-ladder unification: fullframe routed through rung 1/2/3, per-tile rung-3 encoding choice, per-frame byte budget; ADR-0021 accepted (supersedes ADR-0015/0016)
PhaseC       2026-06-24  committed   scroll-detection cleanup: 13 classifier thresholds to Config, axis-from-geometry copyRect without a live hint, tile-coverage gate raised 0.15->0.6
TileCache-Acc pending     pending     physical/sim acceptance: bursty CLI scroll copyRects with hintActive=false, drawCachedTile hits on re-exposed lines, no freeze on sustained flicks
```
