# Owned-media datagram transport correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. NOTE: this repo's AGENTS.md says implement slices inline in the main loop; do not delegate implementation to subagents. Treat the sub-skill structure as the task ordering, execute inline.

**Goal:** Make the ADR-0025 HEVC motion carrier actually deliver host -> client by sending the video over a dedicated QUIC datagram connection (`isDatagram = true`), replacing the failed attempt to ride datagrams on the reliable graphics `NWConnectionGroup`.

**Architecture:** The reliable graphics path is unchanged: one QUIC `NWConnectionGroup` (multiplex, `isDatagram=false`) on `graphicsPort` carrying the tile streams. The motion carrier becomes a SECOND, independent QUIC transport: a host `NWListener` with `isDatagram=true` on a new `ownedMediaDatagramPort`, and a client `NWConnection` with `isDatagram=true` to that port. HEVC frames are packetized (existing `MediaDatagramFramePacket`) and sent with `connection.send`, burst-paced. Client-> host keyframe requests ride the same datagram connection. Both transports coexist exactly as they did pre-0022; the merge onto one group (the current broken wiring) is removed.

**Tech Stack:** Swift, Network.framework (QUIC datagrams via `NWProtocolQUIC.Options.isDatagram` + `maxDatagramFrameSize`), VideoToolbox HEVC (unchanged), existing `MediaDatagramFramePacket`/`MediaDatagramFrameRepairBuffer`/`OwnedMediaFrameEnvelope`.

## Root cause this corrects

On device, every host video datagram failed with `POSIXErrorCode 89: Operation canceled` (`sendErrors` 166 -> 9564, `groupMisses=0`), and the client received zero. Cause: the wiring sent HEVC datagrams via `group.send` on the reliable graphics group (`isDatagram=false` + `maxDatagramFrameSize`). Network.framework does not deliver datagrams that way. The proven pre-0022 carrier (`45c5cf3^`) used a dedicated `isDatagram=true` `NWConnection` with `connection.send`. This plan restores that mechanism, fitted to the current `OwnedMediaTransport` structure.

NOT a bug (corrected from an earlier misread): the encoder is not keyframing every frame. The send log samples every 30th frame and the keyframe interval is also 30, so only periodic keyframes were ever logged. Inter-prediction works.

## Global Constraints

- Carrier is OFF by default. Everything in this plan is gated on `Config.ownedMediaVideoMotionEnabled` (host) / its client mirror. With the flag off, no datagram listener/connection is created and behavior is byte-identical to today. The 7-day daily-driver acceptance test must not regress.
- No hardcoded config. New tunables are `Config` statics with an `AGENTDESK_`-prefixed env override. The new port also goes through `launch-env.sh`'s allowlist and the `iphone-console-run` `--environment-variables` JSON.
- `SharedTypes.swift` and `MediaDatagramFramePacket.swift` are duplicated host/client; any wire-relevant change applies to BOTH identically.
- Pre-v0: breaking the wire is free; host and client are rebuilt together. No migration code.
- Voice/commit rules per AGENTS.md. Auto-commit and push each green unit. Device install/launch is a checkpoint: prepare, state the command, wait for "run it".
- Tests follow current conventions: unit-test the pure/testable seams (pacing, control round-trip); the live QUIC datagram path is integration-validated on device, not in unit tests.

## File structure

- `host/AgentDeskHost/Config.swift` — add `ownedMediaDatagramPort`.
- `client/AgentDeskClient/Config.swift` — add `ownedMediaDatagramPort` (mirror).
- `host/AgentDeskHost/MediaTransport.swift` — add `mediaDatagramALPN`; add a `mediaDatagram()` listener configuration (`usesDatagrams: true`, port, `maxDatagramFrameSize`); revert `graphics()` to `maxDatagramFrameSize: nil`.
- `client/AgentDeskClient/MediaTransport.swift` — add `datagramALPN` mirror; revert reliable params to not advertise datagrams.
- `host/AgentDeskHost/OwnedMediaVideoDatagramServer.swift` (new) — owns the datagram `NWListener`, the active datagram `NWConnection`, receive-control handler, and a burst-paced `send`.
- `host/AgentDeskHost/OwnedMediaDatagramSendPacer.swift` (new, pure) — burst sizing/pause decisions; unit-tested.
- `host/AgentDeskHost/OwnedMediaTransport.swift` — start/stop the datagram server; route `sendVideoDatagram` and the keyframe-request through it; delete the group-datagram send/receive code.
- `client/AgentDeskClient/OwnedMediaTransport.swift` — open the datagram `NWConnection` after the graphics group; receive video datagrams on it; send keyframe-request on it; delete `setReceiveHandler`-on-group and `group.send` control code; stop advertising datagrams on the reliable group.
- Tests: `host/AgentDeskHostTests/OwnedMediaDatagramSendPacerTests.swift` (new); extend `MediaDatagramCarrierTests` for the control-message round-trip if not already covered.

## Phases

**Phase 0 — Remove the broken merged-group datagram code.** Strip `maxDatagramFrameSize` from the reliable graphics group on both ends and the `graphics()` listener config; delete `group.setReceiveHandler` (client+host) and `group.send`-based `sendVideoDatagram`/`sendVideoControl`. Green state: carrier flag still compiles, video simply not sent yet (motion falls through to tiles, as before this iteration). This isolates the rewrite from the dead path.

**Phase 1 — Config + listener/connection parameters.** Add `ownedMediaDatagramPort` (host+client, default 41891, env `AGENTDESK_OWNED_MEDIA_DATAGRAM_PORT`). Add the `mediaDatagram()` host listener config and the datagram ALPN constants. Unit: config defaults/override; listener-config equality.

**Phase 2 — Host datagram server + pacer.** `OwnedMediaDatagramSendPacer` (pure, unit-tested: given N packets and burst/pause knobs, yields the burst boundaries). `OwnedMediaVideoDatagramServer`: start an `isDatagram=true` listener gated by the flag, accept the latest client datagram connection, install a receive handler that decodes `OwnedMediaControlMessage` (keyframe-request) and forwards it, and a `send(_ packets:)` that paces bursts via the pacer and reports send errors. Wire into `OwnedMediaTransport.start/stop` and re-point the encode-pump fork's `sendVideoDatagram` at it. Keep the diagnostics (groupMisses->connection-nil, sendErrors).

**Phase 3 — Client datagram connection.** After the reliable graphics group reaches `.ready`, open an `isDatagram=true` `NWConnection` to `host:ownedMediaDatagramPort` (flag-gated), install the video-datagram receive handler (existing `handleVideoDatagram` + repair buffer), and send keyframe-requests on it. Tear it down with the session. Keep the rx diagnostics.

**Phase 4 — Device checkpoint.** Prepare and wait for "run it": reinstall client, `host-run` + `iphone-console-run-dev` with the carrier on. Success = client logs `video datagram rx=` climbing and `frame-complete`, host `sendErrors` near zero, scroll renders as HEVC under the link budget, motion-stop sharpens to tiles with no black gap. Capture host + attached client logs in the same run.

**Phase 5 — Tuning + ADR/docs.** Only after the round-trip works: revisit `ownedMediaBitrateKbps` (8000 is high) and `ownedMediaVideoKeyframeIntervalFrames` (30 is frequent) against measured device bytes. Update ADR-0025 with the dedicated-datagram-connection decision and why the merged-group approach failed (the `Operation canceled` finding). Update `launch-env.sh` allowlist and `iphone-console-run` env JSON for the new port. No client marketing-version bump needed beyond the 1.5.0 already set unless a further client feature lands.

## Open design points to resolve during Phase 2/3 (not invent silently)

- Host-side association of a datagram connection to the active session: for single-client dev, the latest accepted datagram connection is treated as active (mirrors `activeGraphicsConnectionId`). The `MediaDatagramFramePacket` HMAC (fixed shared key, QUIC already secures the channel) guards integrity. If multi-client ever matters, a first-datagram hello carrying the session id is the upgrade path. Note the single-client assumption in code.
- Whether an `isDatagram=true` QUIC `NWListener` delivers a member via `newConnectionHandler` as an `NWConnection` (expected, matches pre-0022) is device-verified in Phase 4; if the API shape differs, adjust in that iteration.

## Verification

- Per phase: `just check` (host) and the client build/`just sim-test` green; commit and push.
- Device (Phase 4 checkpoint): the success criteria above, comparing scroll bytes/feel against the tile baseline.
