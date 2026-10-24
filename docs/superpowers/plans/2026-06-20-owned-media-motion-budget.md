# Owned Media Motion Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a short motion-specific host encode budget so scroll/motion frames stay small enough for stable delivery while rest frames keep the current crisp HEVC quality.

**Architecture:** Keep the single owned QUIC surface and the existing ACK-driven admission model. The host derives a local `OwnedMediaMotionBudget` from admission mode, frame age, backlog, and unacknowledged byte pressure, then updates VideoToolbox session properties before encoding each admitted frame. No client wire changes are needed.

**Tech Stack:** Swift, VideoToolbox, Network QUIC datagrams, Swift Testing, `just check`, physical iPhone attached console.

---

## File Structure

- Modify `host/AgentDeskHost/Config.swift` to add central environment knobs for motion bitrate, motion FPS, and motion activation thresholds.
- Modify `host/AgentDeskHost/SharedTypes.swift` to add a small pure `OwnedMediaMotionBudgetPolicy` plus tests around pressure classification and budget selection.
- Modify `host/AgentDeskHost/OwnedMediaTransport.swift` to compute a budget before encode, pass it into `VideoToolboxOwnedMediaEncoder.encode`, and include the chosen budget in host diagnostics.
- Modify `host/AgentDeskHost/MediaTransport.swift` only if send stats need a field for budget correlation. Prefer keeping the budget in transport diagnostics unless tests show send stats are the cleaner seam.
- Modify `.env.example` to document the new knobs.
- Modify `tools/owned-media-diagnostics-summary.sh` to summarize motion budget usage and packet-size changes.
- Modify `host/AgentDeskHostTests/ScrollQualityTests.swift` for pure policy tests and encoder-call contract tests.

## Defaults

The defaults should be conservative and reversible through config:

- `AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_ENABLED=1`
- `AGENTDESK_OWNED_MEDIA_MOTION_BITRATE_KBPS=5000`
- `AGENTDESK_OWNED_MEDIA_MOTION_FPS=15`
- `AGENTDESK_OWNED_MEDIA_MOTION_FRAME_AGE_MS=80`
- `AGENTDESK_OWNED_MEDIA_MOTION_BACKLOG_FRAMES=1`
- `AGENTDESK_OWNED_MEDIA_MOTION_INFLIGHT_BYTES=120000`
- `AGENTDESK_OWNED_MEDIA_REST_BUDGET_HOLD_MS=500`

Reasoning from the last run: the host already reaches about 12 to 15 admitted FPS, but large deltas still create visible gaps. The first budget should target frame size, not lower cadence below the current usable baseline.

## Task 1: Motion Budget Policy

**Files:**
- Modify: `host/AgentDeskHost/SharedTypes.swift`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing tests for pressure-to-budget mapping**

Add tests near the existing admission and pacing tests:

```swift
@Test func ownedMediaMotionBudgetStaysRestWhenDisabled() {
    let policy = OwnedMediaMotionBudgetPolicy(
        enabled: false,
        restBitrateKbps: 8_000,
        restFps: 30,
        motionBitrateKbps: 5_000,
        motionFps: 15,
        motionFrameAgeMs: 80,
        motionBacklogFrames: 1,
        motionInflightBytes: 120_000,
        restBudgetHoldMs: 500
    )

    let budget = policy.choose(
        mode: .behind,
        frameAgeMs: 200,
        backlogFrames: 2,
        unacknowledgedBytes: 200_000,
        lastMotionBudgetAtUptimeNs: nil,
        nowUptimeNs: 1_000_000_000
    )

    #expect(budget.mode == .rest)
    #expect(budget.bitrateKbps == 8_000)
    #expect(budget.expectedFrameRate == 30)
}

@Test func ownedMediaMotionBudgetTurnsOnForBehindFrameAge() {
    let policy = Self.motionBudgetPolicy()

    let budget = policy.choose(
        mode: .behind,
        frameAgeMs: 90,
        backlogFrames: 0,
        unacknowledgedBytes: 0,
        lastMotionBudgetAtUptimeNs: nil,
        nowUptimeNs: 1_000_000_000
    )

    #expect(budget.mode == .motion)
    #expect(budget.bitrateKbps == 5_000)
    #expect(budget.expectedFrameRate == 15)
}

@Test func ownedMediaMotionBudgetTurnsOnForBacklogOrInflightBytes() {
    let policy = Self.motionBudgetPolicy()

    let backlog = policy.choose(
        mode: .normal,
        frameAgeMs: 20,
        backlogFrames: 1,
        unacknowledgedBytes: 0,
        lastMotionBudgetAtUptimeNs: nil,
        nowUptimeNs: 1_000_000_000
    )
    let bytes = policy.choose(
        mode: .normal,
        frameAgeMs: 20,
        backlogFrames: 0,
        unacknowledgedBytes: 130_000,
        lastMotionBudgetAtUptimeNs: nil,
        nowUptimeNs: 1_100_000_000
    )

    #expect(backlog.mode == .motion)
    #expect(bytes.mode == .motion)
}

@Test func ownedMediaMotionBudgetHoldsBeforeReturningToRest() {
    let policy = Self.motionBudgetPolicy()

    let held = policy.choose(
        mode: .normal,
        frameAgeMs: 20,
        backlogFrames: 0,
        unacknowledgedBytes: 0,
        lastMotionBudgetAtUptimeNs: 1_000_000_000,
        nowUptimeNs: 1_300_000_000
    )
    let restored = policy.choose(
        mode: .normal,
        frameAgeMs: 20,
        backlogFrames: 0,
        unacknowledgedBytes: 0,
        lastMotionBudgetAtUptimeNs: 1_000_000_000,
        nowUptimeNs: 1_501_000_000
    )

    #expect(held.mode == .motion)
    #expect(restored.mode == .rest)
}
```

Add helper:

```swift
private static func motionBudgetPolicy() -> OwnedMediaMotionBudgetPolicy {
    OwnedMediaMotionBudgetPolicy(
        enabled: true,
        restBitrateKbps: 8_000,
        restFps: 30,
        motionBitrateKbps: 5_000,
        motionFps: 15,
        motionFrameAgeMs: 80,
        motionBacklogFrames: 1,
        motionInflightBytes: 120_000,
        restBudgetHoldMs: 500
    )
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: fails because `OwnedMediaMotionBudgetPolicy` does not exist.

- [ ] **Step 3: Implement the pure budget types**

Add to `host/AgentDeskHost/SharedTypes.swift` near cadence and pacing types:

```swift
enum OwnedMediaEncodeBudgetMode: String, Equatable, Sendable {
    case rest
    case motion
}

struct OwnedMediaEncodeBudget: Equatable, Sendable {
    let mode: OwnedMediaEncodeBudgetMode
    let bitrateKbps: Int
    let expectedFrameRate: Int
}

struct OwnedMediaMotionBudgetPolicy: Equatable, Sendable {
    let enabled: Bool
    let restBitrateKbps: Int
    let restFps: Int
    let motionBitrateKbps: Int
    let motionFps: Int
    let motionFrameAgeMs: Double
    let motionBacklogFrames: Int
    let motionInflightBytes: Int
    let restBudgetHoldMs: Int

    var restBudget: OwnedMediaEncodeBudget {
        OwnedMediaEncodeBudget(
            mode: .rest,
            bitrateKbps: restBitrateKbps,
            expectedFrameRate: restFps
        )
    }

    var motionBudget: OwnedMediaEncodeBudget {
        OwnedMediaEncodeBudget(
            mode: .motion,
            bitrateKbps: motionBitrateKbps,
            expectedFrameRate: motionFps
        )
    }

    func choose(
        mode: OwnedMediaCadenceMode,
        frameAgeMs: Double,
        backlogFrames: Int,
        unacknowledgedBytes: Int,
        lastMotionBudgetAtUptimeNs: UInt64?,
        nowUptimeNs: UInt64
    ) -> OwnedMediaEncodeBudget {
        guard enabled else { return restBudget }
        if mode == .behind || mode == .draining ||
            frameAgeMs >= motionFrameAgeMs ||
            backlogFrames >= motionBacklogFrames ||
            unacknowledgedBytes >= motionInflightBytes {
            return motionBudget
        }
        guard let lastMotionBudgetAtUptimeNs else { return restBudget }
        let holdNs = UInt64(max(restBudgetHoldMs, 0)) * 1_000_000
        if nowUptimeNs >= lastMotionBudgetAtUptimeNs &&
            nowUptimeNs - lastMotionBudgetAtUptimeNs < holdNs {
            return motionBudget
        }
        return restBudget
    }
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command. Expected: all `ScrollQualityTests` pass.

- [ ] **Step 5: Commit**

```bash
git add host/AgentDeskHost/SharedTypes.swift host/AgentDeskHostTests/ScrollQualityTests.swift
git commit -m "test: define owned media motion budget policy"
git push origin main
```

## Task 2: Config Knobs

**Files:**
- Modify: `host/AgentDeskHost/Config.swift`
- Modify: `.env.example`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing config tests**

Add:

```swift
@Test func ownedMediaMotionBudgetConfigParsesBooleanAndThresholds() {
    #expect(Config.enabledFlag(environmentKey: "MISSING", defaultValue: true, environment: [:]))
    #expect(!Config.enabledFlag(environmentKey: "FLAG", defaultValue: true, environment: ["FLAG": "0"]))
    #expect(!Config.enabledFlag(environmentKey: "FLAG", defaultValue: true, environment: ["FLAG": "false"]))
    #expect(Config.enabledFlag(environmentKey: "FLAG", defaultValue: false, environment: ["FLAG": "1"]))
    #expect(Config.enabledFlag(environmentKey: "FLAG", defaultValue: false, environment: ["FLAG": "true"]))
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Expected: fails because `Config.enabledFlag` does not exist.

- [ ] **Step 3: Add config properties**

Add to `Config` after existing owned-media bitrate and FPS:

```swift
static let ownedMediaMotionBudgetEnabled = enabledFlag(
    environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_ENABLED",
    defaultValue: true,
    environment: ProcessInfo.processInfo.environment
)
static let ownedMediaMotionBitrateKbps = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_BITRATE_KBPS",
    defaultValue: 5_000
)
static let ownedMediaMotionFps = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_FPS",
    defaultValue: 15
)
static let ownedMediaMotionFrameAgeMs = positiveDouble(
    environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_FRAME_AGE_MS",
    defaultValue: 80
)
static let ownedMediaMotionBacklogFrames = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_BACKLOG_FRAMES",
    defaultValue: 1
)
static let ownedMediaMotionInflightBytes = positiveInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_INFLIGHT_BYTES",
    defaultValue: 120_000
)
static let ownedMediaRestBudgetHoldMs = nonNegativeInt(
    environmentKey: "AGENTDESK_OWNED_MEDIA_REST_BUDGET_HOLD_MS",
    defaultValue: 500
)
```

Add helper:

```swift
static func enabledFlag(
    environmentKey: String,
    defaultValue: Bool,
    environment: [String: String]
) -> Bool {
    guard let raw = environment[environmentKey]?.lowercased() else {
        return defaultValue
    }
    switch raw {
    case "1", "true", "yes", "on":
        return true
    case "0", "false", "no", "off":
        return false
    default:
        return defaultValue
    }
}
```

- [ ] **Step 4: Document `.env.example`**

Add:

```bash
AGENTDESK_OWNED_MEDIA_MOTION_BUDGET_ENABLED=1        # enables temporary motion encode budget from ACK/backlog pressure
AGENTDESK_OWNED_MEDIA_MOTION_BITRATE_KBPS=5000       # motion VideoToolbox bitrate target while client is behind
AGENTDESK_OWNED_MEDIA_MOTION_FPS=15                  # motion VideoToolbox expected frame rate while client is behind
AGENTDESK_OWNED_MEDIA_MOTION_FRAME_AGE_MS=80         # frame age threshold that enters motion budget
AGENTDESK_OWNED_MEDIA_MOTION_BACKLOG_FRAMES=1        # client backlog threshold that enters motion budget
AGENTDESK_OWNED_MEDIA_MOTION_INFLIGHT_BYTES=120000   # unacked byte threshold that enters motion budget
AGENTDESK_OWNED_MEDIA_REST_BUDGET_HOLD_MS=500        # hold motion budget briefly after pressure clears
```

- [ ] **Step 5: Run focused tests and commit**

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
git add host/AgentDeskHost/Config.swift host/AgentDeskHostTests/ScrollQualityTests.swift .env.example
git commit -m "feat: configure owned media motion budget"
git push origin main
```

## Task 3: Runtime Budget Selection

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing tests for budget selection inputs**

Add tests for a helper that builds the policy from config-like values and picks motion budget when admission has pressure. If direct testing of `OwnedMediaTransport` is too broad, keep the test on a small `OwnedMediaMotionBudgetState` type in `SharedTypes.swift`.

```swift
@Test func ownedMediaMotionBudgetStateRecordsLastMotionUse() {
    var state = OwnedMediaMotionBudgetState()
    let policy = Self.motionBudgetPolicy()

    let motion = state.choose(
        policy: policy,
        mode: .behind,
        frameAgeMs: 120,
        backlogFrames: 1,
        unacknowledgedBytes: 130_000,
        nowUptimeNs: 1_000_000_000
    )
    let held = state.choose(
        policy: policy,
        mode: .normal,
        frameAgeMs: 20,
        backlogFrames: 0,
        unacknowledgedBytes: 0,
        nowUptimeNs: 1_300_000_000
    )

    #expect(motion.mode == .motion)
    #expect(held.mode == .motion)
    #expect(state.lastMotionBudgetAtUptimeNs == 1_300_000_000)
}
```

- [ ] **Step 2: Implement `OwnedMediaMotionBudgetState`**

Add:

```swift
struct OwnedMediaMotionBudgetState: Equatable {
    private(set) var lastMotionBudgetAtUptimeNs: UInt64?

    mutating func choose(
        policy: OwnedMediaMotionBudgetPolicy,
        mode: OwnedMediaCadenceMode,
        frameAgeMs: Double,
        backlogFrames: Int,
        unacknowledgedBytes: Int,
        nowUptimeNs: UInt64
    ) -> OwnedMediaEncodeBudget {
        let budget = policy.choose(
            mode: mode,
            frameAgeMs: frameAgeMs,
            backlogFrames: backlogFrames,
            unacknowledgedBytes: unacknowledgedBytes,
            lastMotionBudgetAtUptimeNs: lastMotionBudgetAtUptimeNs,
            nowUptimeNs: nowUptimeNs
        )
        if budget.mode == .motion {
            lastMotionBudgetAtUptimeNs = nowUptimeNs
        }
        return budget
    }
}
```

- [ ] **Step 3: Wire state into `OwnedMediaTransport`**

Add a property:

```swift
private var motionBudgetState = OwnedMediaMotionBudgetState()
```

Add a locked helper:

```swift
private func currentEncodeBudget(nowUptimeNs: UInt64) -> OwnedMediaEncodeBudget {
    lock.withLock {
        motionBudgetState.choose(
            policy: makeMotionBudgetPolicy(),
            mode: admission.mode,
            frameAgeMs: admission.latestClientFrameAgeMs,
            backlogFrames: admission.latestClientBacklogFrames,
            unacknowledgedBytes: admission.unacknowledgedBytes,
            nowUptimeNs: nowUptimeNs
        )
    }
}

private func makeMotionBudgetPolicy() -> OwnedMediaMotionBudgetPolicy {
    OwnedMediaMotionBudgetPolicy(
        enabled: Config.ownedMediaMotionBudgetEnabled,
        restBitrateKbps: configuration.targetBitrateKbps,
        restFps: configuration.expectedFrameRate,
        motionBitrateKbps: Config.ownedMediaMotionBitrateKbps,
        motionFps: Config.ownedMediaMotionFps,
        motionFrameAgeMs: Config.ownedMediaMotionFrameAgeMs,
        motionBacklogFrames: Config.ownedMediaMotionBacklogFrames,
        motionInflightBytes: Config.ownedMediaMotionInflightBytes,
        restBudgetHoldMs: Config.ownedMediaRestBudgetHoldMs
    )
}
```

In `runEncodePump`, after the admission decision and before `encoder.encode`, compute:

```swift
let budget = currentEncodeBudget(nowUptimeNs: admissionNs)
```

Pass `budget` into the encoder call.

- [ ] **Step 4: Run focused tests and commit**

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
git add host/AgentDeskHost/SharedTypes.swift host/AgentDeskHost/OwnedMediaTransport.swift host/AgentDeskHostTests/ScrollQualityTests.swift
git commit -m "feat: select owned media motion encode budget"
git push origin main
```

## Task 4: VideoToolbox Dynamic Budget Application

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Add a pure applied-budget cache test**

Add:

```swift
@Test func ownedMediaEncoderBudgetApplicationSkipsUnchangedBudget() {
    var applied = OwnedMediaAppliedEncodeBudget()

    #expect(applied.shouldApply(OwnedMediaEncodeBudget(mode: .rest, bitrateKbps: 8_000, expectedFrameRate: 30)))
    applied.noteApplied(OwnedMediaEncodeBudget(mode: .rest, bitrateKbps: 8_000, expectedFrameRate: 30))
    #expect(!applied.shouldApply(OwnedMediaEncodeBudget(mode: .rest, bitrateKbps: 8_000, expectedFrameRate: 30)))
    #expect(applied.shouldApply(OwnedMediaEncodeBudget(mode: .motion, bitrateKbps: 5_000, expectedFrameRate: 15)))
}
```

- [ ] **Step 2: Add the cache type**

Add near encoder support types:

```swift
struct OwnedMediaAppliedEncodeBudget: Equatable {
    private(set) var budget: OwnedMediaEncodeBudget?

    func shouldApply(_ next: OwnedMediaEncodeBudget) -> Bool {
        budget != next
    }

    mutating func noteApplied(_ next: OwnedMediaEncodeBudget) {
        budget = next
    }
}
```

- [ ] **Step 3: Extend encoder API**

Change:

```swift
func encode(
    _ frame: CapturedVideoFrame,
    forceKeyframe: Bool = false,
    allowPeriodicKeyframe: Bool = true,
    requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
) async -> OwnedMediaFrameEnvelope?
```

to:

```swift
func encode(
    _ frame: CapturedVideoFrame,
    budget: OwnedMediaEncodeBudget,
    forceKeyframe: Bool = false,
    allowPeriodicKeyframe: Bool = true,
    requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
) async -> OwnedMediaFrameEnvelope?
```

Thread `budget` through `encode(... completion:)`.

- [ ] **Step 4: Apply dynamic session properties before each encode**

Inside the locked encoder section, after `ensureSession(for:)`, apply budget when changed:

```swift
try applyBudgetIfNeeded(budget, to: sessionToEncode)
```

Implement:

```swift
private var appliedBudget = OwnedMediaAppliedEncodeBudget()

private func applyBudgetIfNeeded(_ budget: OwnedMediaEncodeBudget, to session: VTCompressionSession) throws {
    guard appliedBudget.shouldApply(budget) else { return }
    try setProperty(kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: budget.bitrateKbps * 1000), on: session)
    try setProperty(kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: budget.expectedFrameRate), on: session)
    appliedBudget.noteApplied(budget)
    logger.notice("owned encoder budget mode=\(budget.mode.rawValue, privacy: .public) bitrate=\(budget.bitrateKbps, privacy: .public)kbps fps=\(budget.expectedFrameRate, privacy: .public)")
}
```

Reset `appliedBudget` when a compression session is invalidated or recreated.

- [ ] **Step 5: Preserve session creation defaults**

Keep `ensureSession` using rest configuration for initial property setup. The dynamic budget call applies the current motion or rest settings immediately after session creation and before the frame is submitted.

- [ ] **Step 6: Run focused tests and commit**

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
git add host/AgentDeskHost/OwnedMediaTransport.swift host/AgentDeskHostTests/ScrollQualityTests.swift
git commit -m "feat: apply owned media motion encoder budget"
git push origin main
```

## Task 5: Diagnostics and Summary

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift`
- Modify: `tools/owned-media-diagnostics-summary.sh`
- Test: representative script smoke using `/tmp/agentdesk-client-console.log`

- [ ] **Step 1: Add budget fields to host-frame logs**

In `OwnedMediaFrameLifecycle`, add:

```swift
var encodeBudget: OwnedMediaEncodeBudget?
```

Add `budget` to `noteAdmitted` or a new `noteBudgeted(frame:budget:)`, then include in `owned media host-frame`:

```swift
budgetMode=\(snapshot.lifecycle.encodeBudget?.mode.rawValue ?? "unknown", privacy: .public)
budgetKbps=\(snapshot.lifecycle.encodeBudget?.bitrateKbps ?? 0, privacy: .public)
budgetFps=\(snapshot.lifecycle.encodeBudget?.expectedFrameRate ?? 0, privacy: .public)
```

- [ ] **Step 2: Parse budget usage**

Update `tools/owned-media-diagnostics-summary.sh` to print:

```text
host budget rest=<count> motion=<count>
host budgetPacketMax rest=<max-packets> motion=<max-packets>
host budgetBytesMax rest=<max-bytes> motion=<max-bytes>
```

Use the same awk style as existing pacing summary.

- [ ] **Step 3: Smoke the summary**

Run:

```bash
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected: prints the new budget lines. On old logs, counts may be zero but the script must still exit successfully.

- [ ] **Step 4: Commit**

```bash
git add host/AgentDeskHost/OwnedMediaTransport.swift tools/owned-media-diagnostics-summary.sh
git commit -m "chore: report owned media motion budget diagnostics"
git push origin main
```

## Task 6: Full Verification and Physical Run

**Files:**
- No source edits unless verification exposes a bug.

- [ ] **Step 1: Run full check**

```bash
just check
```

Expected: host and client builds and tests pass.

- [ ] **Step 2: Run attached iPhone console**

```bash
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
just fresh-consoled-run
```

Scroll for 20 to 30 seconds, then stop the attached console after the user says `done`.

- [ ] **Step 3: Summarize diagnostics**

Run:

```bash
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected improvements versus the `5e8c006` baseline:

- Motion budget count is nonzero during scroll.
- Large motion frames shrink. Target: fewer frames over 64 packets and no repeated 128 plus packet motion frames outside keyframes.
- `firstToCompleteMs > 100` should drop below the previous `9` count for a comparable 20 to 30 second scroll.
- `maxRenderGapMs` should move below the previous `306.9` if frame sizes are the limiting factor.
- Client render path remains cheap: enqueue and work stay around sub-ms to low single-digit ms.
- Packet repair stays quiet on normal Wi-Fi. Resend activity should not become the primary path.

- [ ] **Step 4: Commit verification doc update only if needed**

If the physical run changes the recommended defaults, update `.env.example` in the same logical commit as the tuning fix. Do not add a new runtime path.

## Non-Goals

- Do not change HEVC versus H.264.
- Do not change 4:2:0 versus 4:4:4.
- Do not add WebRTC, dual planes, Rust, MoQ, or FEC.
- Do not send motion hints from the client UI.
- Do not scale capture resolution in this slice. The budget should first try encoder bitrate/FPS because rest crispness is non-negotiable and capture-scale changes are visually more invasive.

## Risk Notes

- VideoToolbox may not honor `AverageBitRate` or `ExpectedFrameRate` changes immediately for an active HEVC hardware session. The budget logs must prove property application and compare resulting packet counts. If packet counts do not shrink, the next slice should evaluate controlled session recreation or capture-scale budgeting.
- Reducing motion bitrate can make moving text less readable. The expected trade is acceptable only while scrolling; the rest-budget hold must be short enough to return crispness quickly after motion.
- Lowering expected FPS without lowering bitrate may not reduce frame size enough. The first implementation changes both together to give the encoder a clear target.

## Self-Review

- Spec coverage: the plan keeps single owned QUIC media, VideoToolbox, ACK admission, and crisp rest-state priority from `SPEC.md`.
- Placeholder scan: every task names files, commands, and expected behavior.
- Type consistency: `OwnedMediaEncodeBudget`, `OwnedMediaMotionBudgetPolicy`, and `OwnedMediaMotionBudgetState` are introduced before they are used by runtime wiring.
