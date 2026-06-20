# Owned Media Cadence, Pacing, and Motion Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make owned HEVC motion feel steadier by holding 12 to 15 FPS during scroll-like motion, smoothing large QUIC datagram bursts, and coalescing motion captures without reintroducing dual planes or WebRTC.

**Architecture:** Keep the single owned QUIC media surface. The host remains ACK-driven, but frame cadence is scheduled start-to-start instead of send-end-to-next-start, packet pacing is chosen per frame size, and motion budgeting coalesces raw captures before encode. Crisp rest quality stays unchanged because motion budgeting is short lived and only active under observed capture pressure.

**Tech Stack:** Swift, ScreenCaptureKit, VideoToolbox, Network.framework QUIC datagrams, existing `just check`, physical iPhone attached-console runs.

---

## Files

- Modify `host/AgentDeskHost/SharedTypes.swift`: add pure cadence and pacing policy helpers, extend `OwnedMediaBackpressureConfig` only for central config values that need tests.
- Modify `host/AgentDeskHost/OwnedMediaTransport.swift`: use start-to-start admission scheduling and add a short motion budget around the latest raw capture mailbox.
- Modify `host/AgentDeskHost/OwnedMediaChannelServer.swift`: choose datagram pacing from frame packet count plus backpressure state, and report the selected class in `OwnedMediaSendStats`.
- Modify `host/AgentDeskHost/Config.swift` and `.env.example`: add only tunable thresholds and defaults.
- Modify `host/AgentDeskHostTests/ScrollQualityTests.swift`: add pure unit tests for cadence scheduling, frame-size pacing, and motion budget behavior.
- Modify `tools/owned-media-diagnostics-summary.sh`: include cadence target misses and large-frame pacing counts if new log fields are added.
- Modify `TASKS.md`: add the task row only after implementation is green and physically verified.

---

## Task 1: Start-to-start host admission cadence

**Files:**
- Modify `host/AgentDeskHost/SharedTypes.swift`
- Modify `host/AgentDeskHost/OwnedMediaTransport.swift`
- Test `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing scheduler tests**

Add tests that prove the scheduler targets frame start cadence, not send-completion cadence:

```swift
@Test func ownedMediaCadenceSchedulerUsesAdmissionStartNotSendEnd() {
    var scheduler = OwnedMediaCadenceScheduler()
    scheduler.noteAdmissionStarted(atUptimeNs: 1_000_000_000)

    let delay = scheduler.delayBeforeNextAdmission(
        nowUptimeNs: 1_042_000_000,
        intervalMs: 67
    )

    #expect(delay == 25_000_000)
}

@Test func ownedMediaCadenceSchedulerDoesNotDelayWhenSlotAlreadyPassed() {
    var scheduler = OwnedMediaCadenceScheduler()
    scheduler.noteAdmissionStarted(atUptimeNs: 1_000_000_000)

    let delay = scheduler.delayBeforeNextAdmission(
        nowUptimeNs: 1_080_000_000,
        intervalMs: 67
    )

    #expect(delay == 0)
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```sh
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: fail because `OwnedMediaCadenceScheduler` does not exist.

- [ ] **Step 3: Add the pure scheduler**

Add to `host/AgentDeskHost/SharedTypes.swift`:

```swift
struct OwnedMediaCadenceScheduler: Equatable {
    private(set) var lastAdmissionStartedAtUptimeNs: UInt64?

    mutating func noteAdmissionStarted(atUptimeNs nowUptimeNs: UInt64) {
        lastAdmissionStartedAtUptimeNs = nowUptimeNs
    }

    func delayBeforeNextAdmission(nowUptimeNs: UInt64, intervalMs: Int) -> UInt64 {
        guard let lastAdmissionStartedAtUptimeNs else { return 0 }
        let intervalNs = UInt64(max(intervalMs, 1)) * 1_000_000
        let nextAdmissionNs = lastAdmissionStartedAtUptimeNs &+ intervalNs
        guard nextAdmissionNs > nowUptimeNs else { return 0 }
        return nextAdmissionNs - nowUptimeNs
    }
}
```

- [ ] **Step 4: Wire the scheduler into the encode pump**

In `host/AgentDeskHost/OwnedMediaTransport.swift`, replace `lastAdmissionNs` with `OwnedMediaCadenceScheduler`. Sleep before admission based on `delayBeforeNextAdmission`, then call `noteAdmissionStarted` at the moment a frame is admitted, not after `channel.send` completes.

Expected behavior: a behind interval of `67 ms` plus a `42 ms` send still produces roughly 15 FPS start cadence when ACK budget allows it, instead of falling to roughly 9 FPS.

- [ ] **Step 5: Add diagnostics for target cadence misses**

Log `admissionDelayMs`, `intervalMs`, and `cadenceLateMs` on `owned media host-frame` or a compact `owned media cadence` line.

- [ ] **Step 6: Run focused tests and `just check`**

Run:

```sh
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
just check
```

Expected: both pass.

---

## Task 2: Frame-size-aware QUIC datagram pacing

**Files:**
- Modify `host/AgentDeskHost/SharedTypes.swift`
- Modify `host/AgentDeskHost/OwnedMediaChannelServer.swift`
- Modify `host/AgentDeskHost/Config.swift`
- Modify `.env.example`
- Test `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing pacing policy tests**

Add tests:

```swift
@Test func ownedMediaPacingKeepsSmallFramesOnNormalPacing() {
    let policy = OwnedMediaDatagramPacingPolicy(
        largeFramePacketThreshold: 64,
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500)
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
        largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500)
    )

    let choice = policy.choose(
        packetCount: 113,
        isKeyframe: false,
        isBackpressured: false,
        normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
        backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
    )

    #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500))
    #expect(choice.reason == .largeFrame)
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run the host scroll-quality test command. Expected: fail because the policy type does not exist.

- [ ] **Step 3: Add pacing policy types**

Add to `host/AgentDeskHost/SharedTypes.swift`:

```swift
enum OwnedMediaDatagramPacingReason: String, Equatable {
    case normal
    case largeFrame = "large-frame"
    case backpressure
}

struct OwnedMediaDatagramPacingChoice: Equatable {
    let pacing: OwnedMediaDatagramPacing
    let reason: OwnedMediaDatagramPacingReason
}

struct OwnedMediaDatagramPacingPolicy: Equatable {
    let largeFramePacketThreshold: Int
    let largeFramePacing: OwnedMediaDatagramPacing

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
        if !isKeyframe && packetCount >= largeFramePacketThreshold {
            return OwnedMediaDatagramPacingChoice(pacing: largeFramePacing, reason: .largeFrame)
        }
        return OwnedMediaDatagramPacingChoice(pacing: normal, reason: .normal)
    }
}
```

- [ ] **Step 4: Add config knobs**

Add defaults:

```swift
AGENTDESK_OWNED_MEDIA_LARGE_FRAME_PACKET_THRESHOLD=64
AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PACKET_COUNT=24
AGENTDESK_OWNED_MEDIA_LARGE_FRAME_BURST_PAUSE_US=1500
```

These values are conservative: small frames stay untouched, large deltas get smoother pacing, and backpressure remains stricter than large-frame pacing.

- [ ] **Step 5: Use the policy in `OwnedMediaChannelServer.send`**

Change pacing selection after packetization, because packet count is known only after `MediaDatagramFramePacket.packetize`. Add `pacingReason` to `OwnedMediaSendStats` and logs.

- [ ] **Step 6: Run focused tests, `just check`, then attached-console physical run**

Run:

```sh
just check
AGENTDESK_OWNED_MEDIA_CODEC=hevc AGENTDESK_OWNED_MEDIA_CHROMA=420 just fresh-consoled-run
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected: `firstToCompleteMs` spikes should not increase, `renderGapMs` spikes should become less clustered around large 80 to 130 packet frames, and frame ACKs should remain continuous.

---

## Task 3: Short motion-specific capture budget

**Files:**
- Modify `host/AgentDeskHost/SharedTypes.swift`
- Modify `host/AgentDeskHost/OwnedMediaTransport.swift`
- Modify `host/AgentDeskHost/Config.swift`
- Modify `.env.example`
- Test `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing motion-budget tests**

Add a pure budget helper test. This budget trades temporal detail only. It does not restart `SCStream`, change the capture scale, or reintroduce UI motion hints.

```swift
@Test func ownedMediaMotionBudgetActivatesAfterCaptureCoalescing() {
    var budget = OwnedMediaMotionBudget(
        coalescedCaptureThreshold: 2,
        windowMs: 250,
        activeMs: 400,
        targetIntervalMs: 67
    )

    budget.noteCoalescedCapture(atUptimeNs: 1_000_000_000)
    budget.noteCoalescedCapture(atUptimeNs: 1_100_000_000)

    #expect(budget.isActive(atUptimeNs: 1_200_000_000))
    #expect(budget.intervalMs(atUptimeNs: 1_200_000_000, baseIntervalMs: 34) == 67)
}

@Test func ownedMediaMotionBudgetExpiresBackToBaseCadence() {
    var budget = OwnedMediaMotionBudget(
        coalescedCaptureThreshold: 2,
        windowMs: 250,
        activeMs: 400,
        targetIntervalMs: 67
    )

    budget.noteCoalescedCapture(atUptimeNs: 1_000_000_000)
    budget.noteCoalescedCapture(atUptimeNs: 1_100_000_000)

    #expect(budget.intervalMs(atUptimeNs: 1_600_000_001, baseIntervalMs: 34) == 34)
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Expected: fail because `OwnedMediaMotionBudget` does not exist.

- [ ] **Step 3: Add `OwnedMediaMotionBudget`**

Add to `host/AgentDeskHost/SharedTypes.swift`. Keep it pure and timestamp driven:

```swift
struct OwnedMediaMotionBudget: Equatable {
    let coalescedCaptureThreshold: Int
    let windowMs: Int
    let activeMs: Int
    let targetIntervalMs: Int
    private var coalescedCaptureTimes: [UInt64] = []
    private var activeUntilUptimeNs: UInt64?

    mutating func noteCoalescedCapture(atUptimeNs nowUptimeNs: UInt64) {
        let windowNs = UInt64(max(windowMs, 1)) * 1_000_000
        coalescedCaptureTimes.append(nowUptimeNs)
        coalescedCaptureTimes = coalescedCaptureTimes.filter {
            nowUptimeNs >= $0 && nowUptimeNs - $0 <= windowNs
        }
        if coalescedCaptureTimes.count >= max(coalescedCaptureThreshold, 1) {
            activeUntilUptimeNs = nowUptimeNs &+ UInt64(max(activeMs, 1)) * 1_000_000
        }
    }

    func isActive(atUptimeNs nowUptimeNs: UInt64) -> Bool {
        guard let activeUntilUptimeNs else { return false }
        return nowUptimeNs <= activeUntilUptimeNs
    }

    func intervalMs(atUptimeNs nowUptimeNs: UInt64, baseIntervalMs: Int) -> Int {
        isActive(atUptimeNs: nowUptimeNs) ? max(baseIntervalMs, targetIntervalMs) : baseIntervalMs
    }
}
```

- [ ] **Step 4: Wire budget to capture coalescing**

In `OwnedMediaTransport.startIfReady`, when `mailbox.submit(frame)` returns `true`, notify the budget. In `currentEncodeIntervalNs`, apply `budget.intervalMs` over `admission.encodeIntervalMs`.

This uses observed host-side capture pressure, not gestures or a separate motion plane.

- [ ] **Step 5: Add knobs**

Add:

```sh
AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_COALESCED_CAPTURE_THRESHOLD=2
AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_WINDOW_MS=250
AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_ACTIVE_MS=400
AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_INTERVAL_MS=67
```

- [ ] **Step 6: Verify the budget does not hurt rest crispness**

Physical run command:

```sh
AGENTDESK_OWNED_MEDIA_CODEC=hevc AGENTDESK_OWNED_MEDIA_CHROMA=420 just fresh-consoled-run
```

Acceptance:

- At rest, frames remain native capture scale and HEVC 420.
- During scroll, host logs show motion budget only while captures coalesce.
- Client logs still show `expiredKeyframes=0`, `staleSkips=0`, and continuous ACKs.
- Latest FPS should stay near 12 to 15 FPS during motion rather than 8 to 9 FPS.

---

## Implementation Order

1. Task 1 first. It directly addresses the measured 8 to 9 FPS problem and is the lowest-risk fix.
2. Task 2 second. It targets visible spikes from large frame packet bursts without changing frame admission.
3. Task 3 third. It intentionally trades temporal motion detail when the host is under capture pressure. Do not land it until Task 1 and Task 2 logs prove cadence and pacing alone are insufficient.

## Physical Acceptance Command

Use attached console only:

```sh
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
just fresh-consoled-run
```

After the run:

```sh
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Acceptance for this whole plan:

- No freeze path: `expiredKeyframes=0`, `staleSkips=0`, continuous `frameAck`.
- Motion cadence: host admitted, encoded, sent, and ACKed FPS usually in the 12 to 15 range during scroll.
- Spike budget: fewer `renderGapMs > 200` events than `working-version-3`.
- Transport health: `firstToCompleteMs > 100` does not regress materially from `working-version-3`.
