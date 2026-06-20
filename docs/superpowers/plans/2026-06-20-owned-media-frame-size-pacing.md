# Owned Media Frame-Size Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Smooth owned QUIC datagram delivery for large HEVC frames so scroll motion does not arrive as bursty 100 ms plus completion spikes.

**Architecture:** Keep the single owned QUIC media surface and existing ACK-driven admission. Move packet pacing from a binary normal/backpressure choice to a pure frame-size-aware policy that can choose normal, large-frame, jumbo-frame, or backpressure pacing after packetization. This is RDP-aligned in the narrow sense: admission decides when a frame lifecycle may start, while transport pacing controls packet delay variation for the frame already admitted.

**Tech Stack:** Swift, Network.framework QUIC datagrams, VideoToolbox HEVC, existing owned-media diagnostics, `just check`, physical iPhone attached-console runs.

---

## Current Finding

The latest attached-console run after start-to-start admission still showed:

- client render/sample/enqueue work usually below `1 ms`,
- no repair pressure, `resendRequests=0`, `expiredKeyframes=0`, `malformedOrAuthDrops=0`,
- large frames around `130` to `200` packets causing `firstToCompleteMs` spikes from roughly `90 ms` to `220 ms`,
- host ACK starvation after those bursts, with admission falling to roughly `3 FPS` at the tail.

So this slice does not touch decode, display, packet repair, codec, chroma, or admission policy. It targets datagram burst shape only.

## Files

- Modify `host/AgentDeskHost/SharedTypes.swift`: add pure pacing reason and policy types next to `OwnedMediaDatagramPacing`.
- Modify `host/AgentDeskHost/MediaTransport.swift`: add `pacingReason` to `OwnedMediaSendStats`.
- Modify `host/AgentDeskHost/OwnedMediaChannelServer.swift`: choose pacing after packetization using packet count, keyframe status, and backpressure state.
- Modify `host/AgentDeskHost/Config.swift`: add large and jumbo frame pacing knobs.
- Modify `.env.example`: document the new knobs.
- Modify `host/AgentDeskHostTests/ScrollQualityTests.swift`: add pure policy tests and update send-stats tests.
- Modify `tools/owned-media-diagnostics-summary.sh`: summarize pacing reason counts and max send duration by reason.

---

## Task 1: Pure Pacing Policy

**Files:**
- Modify `host/AgentDeskHost/SharedTypes.swift`
- Test `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing policy tests**

Add these tests near `ownedMediaDatagramPacingSwitchesUnderBackpressure`:

```swift
@Test func ownedMediaPacingKeepsSmallFramesOnNormalPacing() {
    let policy = OwnedMediaDatagramPacingPolicy(
        largeFramePacketThreshold: 64,
        jumboFramePacketThreshold: 128,
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
        jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
    )

    let choice = policy.choose(
        packetCount: 5,
        isKeyframe: false,
        isBackpressured: false,
        normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
        backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
    )

    #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000))
    #expect(choice.reason == .normal)
}

@Test func ownedMediaPacingSmoothsLargeDeltaFramesBeforeBackpressure() {
    let policy = OwnedMediaDatagramPacingPolicy(
        largeFramePacketThreshold: 64,
        jumboFramePacketThreshold: 128,
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
        jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
    )

    let choice = policy.choose(
        packetCount: 96,
        isKeyframe: false,
        isBackpressured: false,
        normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
        backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
    )

    #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500))
    #expect(choice.reason == .largeFrame)
}

@Test func ownedMediaPacingSmoothsJumboDeltaFramesBeforeBackpressure() {
    let policy = OwnedMediaDatagramPacingPolicy(
        largeFramePacketThreshold: 64,
        jumboFramePacketThreshold: 128,
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
        jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
    )

    let choice = policy.choose(
        packetCount: 180,
        isKeyframe: false,
        isBackpressured: false,
        normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
        backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
    )

    #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500))
    #expect(choice.reason == .jumboFrame)
}

@Test func ownedMediaPacingLetsBackpressureWinOverFrameSize() {
    let policy = OwnedMediaDatagramPacingPolicy(
        largeFramePacketThreshold: 64,
        jumboFramePacketThreshold: 128,
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
        jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
    )

    let choice = policy.choose(
        packetCount: 180,
        isKeyframe: false,
        isBackpressured: true,
        normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
        backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
    )

    #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500))
    #expect(choice.reason == .backpressure)
}

@Test func ownedMediaPacingKeepsKeyframesOnNormalOrBackpressurePacing() {
    let policy = OwnedMediaDatagramPacingPolicy(
        largeFramePacketThreshold: 64,
        jumboFramePacketThreshold: 128,
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
        jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
    )

    let normalKeyframe = policy.choose(
        packetCount: 180,
        isKeyframe: true,
        isBackpressured: false,
        normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
        backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
    )

    #expect(normalKeyframe.reason == .normal)
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```sh
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: fail with `Cannot find 'OwnedMediaDatagramPacingPolicy' in scope`.

- [ ] **Step 3: Add policy types**

Add next to `OwnedMediaDatagramPacing` in `host/AgentDeskHost/SharedTypes.swift`:

```swift
enum OwnedMediaDatagramPacingReason: String, Equatable, Sendable {
    case normal
    case largeFrame = "large-frame"
    case jumboFrame = "jumbo-frame"
    case backpressure
}

struct OwnedMediaDatagramPacingChoice: Equatable, Sendable {
    let pacing: OwnedMediaDatagramPacing
    let reason: OwnedMediaDatagramPacingReason
}

struct OwnedMediaDatagramPacingPolicy: Equatable, Sendable {
    let largeFramePacketThreshold: Int
    let jumboFramePacketThreshold: Int
    let largeFramePacing: OwnedMediaDatagramPacing
    let jumboFramePacing: OwnedMediaDatagramPacing

    func choose(
        packetCount: Int,
        isKeyframe: Bool,
        isBackpressured: Bool,
        normal: OwnedMediaDatagramPacing,
        backpressure: OwnedMediaDatagramPacing
    ) -> OwnedMediaDatagramPacingChoice {
        if isBackpressured {
            return OwnedMediaDatagramPacingChoice(pacing: backpressure, reason: .backpressure)
        }
        if !isKeyframe && packetCount >= max(jumboFramePacketThreshold, largeFramePacketThreshold) {
            return OwnedMediaDatagramPacingChoice(pacing: jumboFramePacing, reason: .jumboFrame)
        }
        if !isKeyframe && packetCount >= largeFramePacketThreshold {
            return OwnedMediaDatagramPacingChoice(pacing: largeFramePacing, reason: .largeFrame)
        }
        return OwnedMediaDatagramPacingChoice(pacing: normal, reason: .normal)
    }
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused test command.

Expected: new pacing tests pass.

---

## Task 2: Config Surface

**Files:**
- Modify `host/AgentDeskHost/Config.swift`
- Modify `.env.example`

- [ ] **Step 1: Add central config values**

Add after the normal datagram burst config in `host/AgentDeskHost/Config.swift`:

```swift
static let ownedMediaLargeFramePacketThreshold = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_LARGE_FRAME_PACKET_THRESHOLD",
    defaultValue: 64
)
static let ownedMediaJumboFramePacketThreshold = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_PACKET_THRESHOLD",
    defaultValue: 128
)
static let ownedMediaLargeFrameBurstPacketCount = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PACKET_COUNT",
    defaultValue: 24
)
static let ownedMediaLargeFrameBurstPauseUs = nonNegativeInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PAUSE_US",
    defaultValue: 1_500
)
static let ownedMediaJumboFrameBurstPacketCount = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_BURST_PACKET_COUNT",
    defaultValue: 16
)
static let ownedMediaJumboFrameBurstPauseUs = nonNegativeInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_BURST_PAUSE_US",
    defaultValue: 1_500
)
```

- [ ] **Step 2: Document the knobs**

Add to `.env.example` after `AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PAUSE_US`:

```sh
AGENTDESK_OWNED_MEDIA_LARGE_FRAME_PACKET_THRESHOLD=64    # large delta frames get smoother pacing
AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_PACKET_THRESHOLD=128   # jumbo delta frames get the smoothest non-backpressure pacing
AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PACKET_COUNT=24  # packets before pause for large non-keyframes
AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PAUSE_US=1500    # pause for large non-keyframes
AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_BURST_PACKET_COUNT=16  # packets before pause for jumbo non-keyframes
AGENTDESK_OWNED_MEDIA_JUMBO_FRAME_BURST_PAUSE_US=1500    # pause for jumbo non-keyframes
```

---

## Task 3: Server Pacing Selection

**Files:**
- Modify `host/AgentDeskHost/OwnedMediaChannelServer.swift`
- Modify `host/AgentDeskHost/MediaTransport.swift`
- Test `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Extend send stats**

Add one field to `OwnedMediaSendStats`:

```swift
let pacingReason: OwnedMediaDatagramPacingReason
```

Update current test construction in `ownedMediaSendStatsReportsDurationAndPacing`:

```swift
pacingReason: .backpressure,
```

Add:

```swift
#expect(stats.pacingReason == .backpressure)
```

- [ ] **Step 2: Add policy dependencies to the channel server**

In `OwnedMediaChannelServer`, add:

```swift
private let largeFramePacketThreshold: Int
private let jumboFramePacketThreshold: Int
private let largeFrameBurstPacketCount: Int
private let largeFrameBurstPauseUs: Int
private let jumboFrameBurstPacketCount: Int
private let jumboFrameBurstPauseUs: Int
```

Extend `init` with defaults from `Config` and assign them.

- [ ] **Step 3: Replace binary pacing with packet-count pacing**

Replace `currentPacing()` with:

```swift
private func currentPacing(
    packetCount: Int,
    isKeyframe: Bool
) -> (choice: OwnedMediaDatagramPacingChoice, isBackpressured: Bool) {
    stateQueue.sync {
        let isBackpressured = freshness.isClientBehind(backpressure: backpressureConfig)
        let policy = OwnedMediaDatagramPacingPolicy(
            largeFramePacketThreshold: largeFramePacketThreshold,
            jumboFramePacketThreshold: jumboFramePacketThreshold,
            largeFramePacing: OwnedMediaDatagramPacing(
                burstPacketCount: largeFrameBurstPacketCount,
                burstPauseUs: largeFrameBurstPauseUs
            ),
            jumboFramePacing: OwnedMediaDatagramPacing(
                burstPacketCount: jumboFrameBurstPacketCount,
                burstPauseUs: jumboFrameBurstPauseUs
            )
        )
        let choice = policy.choose(
            packetCount: packetCount,
            isKeyframe: isKeyframe,
            isBackpressured: isBackpressured,
            normal: OwnedMediaDatagramPacing(
                burstPacketCount: burstPacketCount,
                burstPauseUs: burstPauseUs
            ),
            backpressure: OwnedMediaDatagramPacing(
                burstPacketCount: backpressureBurstPacketCount,
                burstPauseUs: backpressureBurstPauseUs
            )
        )
        return (choice, isBackpressured)
    }
}
```

In `send(_:)`, call it after `packets` is created:

```swift
let pacing = currentPacing(packetCount: packets.count, isKeyframe: isKeyframe)
```

Then replace `pacing.pacing` reads with `pacing.choice.pacing`, and add `pacingReason: pacing.choice.reason` to `OwnedMediaSendStats`.

- [ ] **Step 4: Include reason in logs**

Update the `owned media quic send` log:

```swift
reason=\(pacing.choice.reason.rawValue, privacy: .public)
```

Update the `owned media host-frame` log in `OwnedMediaTransport.noteSent`:

```swift
pacingReason=\(stats.pacingReason.rawValue, privacy: .public)
```

Update `noteFrameAck` to use the same policy for the logged `pacingBurst` and `pacingPauseUs`, passing `packetCount: 0` and `isKeyframe: false` is not acceptable because it lies about frame-size pacing. Instead, keep ACK logs as current backpressure snapshot only, or rename the fields to `backpressureBurst` and `backpressurePauseUs`. Prefer leaving ACK logs unchanged in this slice.

- [ ] **Step 5: Run focused tests**

Run:

```sh
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: pass.

---

## Task 4: Diagnostics Summary

**Files:**
- Modify `tools/owned-media-diagnostics-summary.sh`

- [ ] **Step 1: Parse pacing reasons**

In the host Perl block, add counters:

```perl
$normalPacing++ if /pacingReason=normal/;
$largePacing++ if /pacingReason=large-frame/;
$jumboPacing++ if /pacingReason=jumbo-frame/;
$backpressurePacing++ if /pacingReason=backpressure/;
if (/pacingReason=([a-z-]+).*sendMs=([0-9.]+)/ || /sendMs=([0-9.]+).*pacingReason=([a-z-]+)/) {
    my ($reason, $sendMs) = defined $2 && $1 !~ /^[0-9.]+$/ ? ($1, $2) : ($2, $1);
    $maxSendByReason{$reason} = $sendMs if $sendMs > ($maxSendByReason{$reason} || 0);
}
```

Print:

```perl
printf "host pacing normal=%d large=%d jumbo=%d backpressure=%d\n", $normalPacing||0, $largePacing||0, $jumboPacing||0, $backpressurePacing||0;
printf "host pacingMaxSend normal=%.1f large=%.1f jumbo=%.1f backpressure=%.1f\n",
    $maxSendByReason{"normal"}||0,
    $maxSendByReason{"large-frame"}||0,
    $maxSendByReason{"jumbo-frame"}||0,
    $maxSendByReason{"backpressure"}||0;
```

- [ ] **Step 2: Smoke the parser**

Run:

```sh
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected: summary prints the new `host pacing` rows even if all counts are zero on an old log.

---

## Task 5: Verification and Physical Acceptance

**Files:**
- No source files.

- [ ] **Step 1: Run full check**

Run:

```sh
just check
```

Expected: pass.

- [ ] **Step 2: Commit and push**

Use a scoped commit:

```sh
git status --short
git add host/AgentDeskHost/SharedTypes.swift host/AgentDeskHost/MediaTransport.swift host/AgentDeskHost/OwnedMediaChannelServer.swift host/AgentDeskHost/Config.swift host/AgentDeskHostTests/ScrollQualityTests.swift .env.example tools/owned-media-diagnostics-summary.sh
git commit -m "fix: pace owned media large frames"
git push
```

- [ ] **Step 3: Run attached-console physical test**

Run only attached console:

```sh
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
just fresh-consoled-run
```

Scroll repeatedly for 20 to 30 seconds, then summarize:

```sh
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected acceptance:

- `client repair resendRequests` stays at `0` or near zero.
- `client timing over300` stays at `0`.
- `client timing over100` drops below the last run's `17` when scroll length is comparable.
- `host pacing large` and `host pacing jumbo` are nonzero during motion.
- `host latestFps admitted/encoded/sent` does not collapse to `2` to `3 FPS` unless the device console or app disconnects.
- Subjective feel improves for rest-to-motion. If it gets worse, revert the runtime commit and keep the diagnostics summary change only if useful.

## Rollback

This slice is isolated. Reverting the runtime behavior means removing `OwnedMediaDatagramPacingPolicy`, the new config values, and `pacingReason` from `OwnedMediaSendStats`, then restoring `OwnedMediaDatagramPacing.choose(isBackpressured:normal:backpressure:)` as the only server selection. No client wire or persisted state changes are involved.

## Self-Review

- Spec coverage: the plan only changes owned QUIC packet pacing, matching Task 2. It does not touch codec, chroma, admission, packet repair, client rendering, WebRTC, or dual-plane behavior.
- Placeholder scan: no `TBD`, no deferred edge-case text, and every code task names exact files and commands.
- Type consistency: `OwnedMediaDatagramPacingReason`, `OwnedMediaDatagramPacingChoice`, and `OwnedMediaDatagramPacingPolicy` are introduced before they are used by `OwnedMediaSendStats` and `OwnedMediaChannelServer`.
