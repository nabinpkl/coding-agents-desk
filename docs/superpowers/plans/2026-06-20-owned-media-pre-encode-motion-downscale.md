# Owned Media Pre-Encode Motion Downscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded motion-only pre-encode downscale path so the host can reduce HEVC packet bursts during scroll while returning to native crisp frames at rest.

**Architecture:** Keep ScreenCaptureKit capture stable and native by default. The encode pump chooses the existing rest or motion budget, then transforms the frame before VideoToolbox only when the selected budget is motion and `AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN` is greater than `1.0`. The iPhone continues to render the encoded frame as the single surface, with input coordinates remaining in host logical coordinates.

**Tech Stack:** Swift, ScreenCaptureKit, CoreVideo, CoreImage, VideoToolbox, QUIC datagrams, Swift Testing, `just check`, attached iPhone console runs.

---

## File Structure

- Modify `host/AgentDeskHost/SharedTypes.swift`
  - Extend `OwnedMediaEncodeBudget` with `scaleDown: Double`.
  - Extend `OwnedMediaMotionBudgetPolicy` so rest uses `AGENTDESK_OWNED_MEDIA_CAPTURE_SCALE_DOWN` and motion uses `AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN`.
  - Keep budget mode names `rest` and `motion`.
- Modify `host/AgentDeskHost/Config.swift`
  - Add `AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN`, default `1.25`.
  - Reuse existing `positiveDouble` parsing.
- Create `host/AgentDeskHost/OwnedMediaFrameScaler.swift`
  - Owns pre-encode downscale from a `CapturedVideoFrame` to a new `CapturedVideoFrame`.
  - Uses `CIContext` plus `CILanczosScaleTransform`.
  - Returns the original frame for scale `<= 1.0`.
  - Preserves `presentationTimeNs`, `capturedAtUptimeNs`, and `rotation`.
  - Stamps the same BT.709 color attachments the capture source uses.
- Modify `host/AgentDeskHost/OwnedMediaTransport.swift`
  - Add one `OwnedMediaFrameScaler` instance to `OwnedMediaTransport`.
  - In `runEncodePump`, compute the budget, scale the frame before diagnostics admission and before encoder encode.
  - Log `scaleDown`, `sourceSize`, and `encodedInputSize` on cadence and host-frame lines.
  - Do not recreate the VT session explicitly. Let the existing `ensureSession(for:)` rebuild when input pixel size changes.
- Modify `tools/owned-media-diagnostics-summary.sh`
  - Summarize rest and motion scale counts.
  - Summarize max packets and bytes by `scaleDown`.
- Modify `.env.example`
  - Document `AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN=1.25`.
- Modify `SPEC.md`
  - Add one sentence under Recovery Policy or Performance Budgets saying motion budget can downscale pre-encode while rest returns to native capture.
- Modify `host/AgentDeskHostTests/ScrollQualityTests.swift`
  - Add budget policy tests.
  - Add scaler sizing tests that do not need a full ScreenCaptureKit run.
  - Add diagnostics parsing expectation where practical.

## Constraints

- Do not add VT session recreation in this slice.
- Do not change codec, chroma, packet repair, QUIC wire shape, client renderer, input mapping, or pairing.
- Do not change ScreenCaptureKit stream sizing dynamically.
- Do not add dual-plane or WebRTC seams.
- Do not make motion downscale a client-visible input coordinate mode. It is only an encode transport detail.
- Rest-state frames must be native size unless the existing global `AGENTDESK_OWNED_MEDIA_CAPTURE_SCALE_DOWN` is set by the user.

## Task 1: Extend Encode Budget With Scale

**Files:**
- Modify: `host/AgentDeskHost/SharedTypes.swift`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing budget tests**

Add tests near the existing motion budget tests:

```swift
@Test func ownedMediaMotionBudgetCarriesRestAndMotionScaleDown() {
    let policy = OwnedMediaMotionBudgetPolicy(
        enabled: true,
        restBitrateKbps: 8_000,
        restFps: 30,
        restScaleDown: 1.0,
        motionBitrateKbps: 5_000,
        motionFps: 15,
        motionScaleDown: 1.5,
        motionFrameAgeMs: 80,
        motionBacklogFrames: 1,
        motionInflightBytes: 120_000,
        restBudgetHoldMs: 500
    )

    let rest = policy.choose(
        mode: .normal,
        frameAgeMs: 10,
        backlogFrames: 0,
        unacknowledgedBytes: 0,
        lastMotionBudgetAtUptimeNs: nil,
        nowUptimeNs: 1_000_000_000
    )
    let motion = policy.choose(
        mode: .behind,
        frameAgeMs: 120,
        backlogFrames: 0,
        unacknowledgedBytes: 0,
        lastMotionBudgetAtUptimeNs: nil,
        nowUptimeNs: 1_010_000_000
    )

    #expect(rest.mode == .rest)
    #expect(rest.scaleDown == 1.0)
    #expect(motion.mode == .motion)
    #expect(motion.scaleDown == 1.5)
}

@Test func ownedMediaMotionBudgetClampsInvalidScaleDownToOne() {
    let budget = OwnedMediaEncodeBudget(mode: .motion, bitrateKbps: 5_000, expectedFrameRate: 15, scaleDown: 0.5)

    #expect(budget.scaleDown == 1.0)
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: fails because `OwnedMediaEncodeBudget` has no `scaleDown`, and `OwnedMediaMotionBudgetPolicy` has no `restScaleDown` or `motionScaleDown`.

- [ ] **Step 3: Extend budget types**

Change `OwnedMediaEncodeBudget` in `host/AgentDeskHost/SharedTypes.swift` to:

```swift
struct OwnedMediaEncodeBudget: Equatable, Sendable {
    let mode: OwnedMediaEncodeBudgetMode
    let bitrateKbps: Int
    let expectedFrameRate: Int
    private let requestedScaleDown: Double

    var scaleDown: Double {
        max(requestedScaleDown, 1.0)
    }

    init(
        mode: OwnedMediaEncodeBudgetMode,
        bitrateKbps: Int,
        expectedFrameRate: Int,
        scaleDown: Double = 1.0
    ) {
        self.mode = mode
        self.bitrateKbps = bitrateKbps
        self.expectedFrameRate = expectedFrameRate
        self.requestedScaleDown = scaleDown
    }
}
```

Change `OwnedMediaMotionBudgetPolicy` to add:

```swift
let restScaleDown: Double
let motionScaleDown: Double
```

Change `restBudget` to:

```swift
var restBudget: OwnedMediaEncodeBudget {
    OwnedMediaEncodeBudget(
        mode: .rest,
        bitrateKbps: restBitrateKbps,
        expectedFrameRate: restFps,
        scaleDown: restScaleDown
    )
}
```

Change `motionBudget` to:

```swift
var motionBudget: OwnedMediaEncodeBudget {
    OwnedMediaEncodeBudget(
        mode: .motion,
        bitrateKbps: motionBitrateKbps,
        expectedFrameRate: motionFps,
        scaleDown: motionScaleDown
    )
}
```

- [ ] **Step 4: Update existing test helpers**

Update every existing `OwnedMediaMotionBudgetPolicy(...)` construction in `host/AgentDeskHostTests/ScrollQualityTests.swift` to include:

```swift
restScaleDown: 1.0,
motionScaleDown: 1.25,
```

Update `Self.motionBudgetPolicy()` to use the same values.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: all `ScrollQualityTests` pass.

## Task 2: Add Motion Scale Config

**Files:**
- Modify: `host/AgentDeskHost/Config.swift`
- Modify: `.env.example`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing config test**

Add to `ScrollQualityTests`:

```swift
@Test func ownedMediaMotionScaleDownConfigParsesPositiveValues() {
    #expect(Config.positiveDouble(environment: ["AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN": "1.5"], environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN", defaultValue: 1.25) == 1.5)
    #expect(Config.positiveDouble(environment: ["AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN": "0"], environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN", defaultValue: 1.25) == 1.25)
    #expect(Config.positiveDouble(environment: ["AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN": "bad"], environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN", defaultValue: 1.25) == 1.25)
}
```

If `positiveDouble` is private, expose a tiny internal wrapper following the existing `ownedMediaMaxQP(environment:)` pattern:

```swift
static func ownedMediaMotionScaleDown(environment: [String: String]) -> Double {
    positiveDouble(
        environment: environment,
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN",
        defaultValue: 1.25
    )
}
```

Then use that wrapper in the test.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: fails because `ownedMediaMotionScaleDown` does not exist, or because `positiveDouble` is not callable from tests.

- [ ] **Step 3: Add config**

In `host/AgentDeskHost/Config.swift`, add near the other motion budget knobs:

```swift
static let ownedMediaMotionScaleDown = ownedMediaMotionScaleDown(
    environment: ProcessInfo.processInfo.environment
)

static func ownedMediaMotionScaleDown(environment: [String: String]) -> Double {
    positiveDouble(
        environment: environment,
        environmentKey: "AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN",
        defaultValue: 1.25
    )
}
```

If `positiveDouble(environment:environmentKey:defaultValue:)` does not exist yet, add the overload beside the current `positiveDouble(environmentKey:defaultValue:)` helper:

```swift
static func positiveDouble(
    environment: [String: String],
    environmentKey: String,
    defaultValue: Double
) -> Double {
    guard let raw = environment[environmentKey],
          let parsed = Double(raw),
          parsed > 0 else {
        return defaultValue
    }
    return parsed
}
```

Then change the existing `positiveDouble(environmentKey:defaultValue:)` helper to delegate:

```swift
static func positiveDouble(environmentKey: String, defaultValue: Double) -> Double {
    positiveDouble(
        environment: ProcessInfo.processInfo.environment,
        environmentKey: environmentKey,
        defaultValue: defaultValue
    )
}
```

- [ ] **Step 4: Wire config into policy creation**

In `host/AgentDeskHost/OwnedMediaTransport.swift`, update `makeMotionBudgetPolicy()`:

```swift
OwnedMediaMotionBudgetPolicy(
    enabled: Config.ownedMediaMotionBudgetEnabled,
    restBitrateKbps: configuration.targetBitrateKbps,
    restFps: configuration.expectedFrameRate,
    restScaleDown: Config.ownedMediaCaptureScaleDown,
    motionBitrateKbps: Config.ownedMediaMotionBitrateKbps,
    motionFps: Config.ownedMediaMotionFps,
    motionScaleDown: Config.ownedMediaMotionScaleDown,
    motionFrameAgeMs: Config.ownedMediaMotionFrameAgeMs,
    motionBacklogFrames: Config.ownedMediaMotionBacklogFrames,
    motionInflightBytes: Config.ownedMediaMotionInflightBytes,
    restBudgetHoldMs: Config.ownedMediaRestBudgetHoldMs
)
```

- [ ] **Step 5: Document `.env.example`**

Add after `AGENTDESK_OWNED_MEDIA_MOTION_FPS`:

```bash
AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN=1.25        # pre-encode downscale while motion budget is active; 1.0 disables
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: all `ScrollQualityTests` pass.

## Task 3: Add Pre-Encode Frame Scaler

**Files:**
- Create: `host/AgentDeskHost/OwnedMediaFrameScaler.swift`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write failing scaler tests**

Add helper test code to `ScrollQualityTests`:

```swift
@Test func ownedMediaFrameScalerReturnsOriginalFrameWhenScaleIsOne() throws {
    let scaler = OwnedMediaFrameScaler()
    let frame = try Self.makePixelBufferFrame(width: 640, height: 480)

    let scaled = try scaler.scaledFrame(frame, scaleDown: 1.0)

    #expect(CVPixelBufferGetWidth(scaled.pixelBuffer) == 640)
    #expect(CVPixelBufferGetHeight(scaled.pixelBuffer) == 480)
    #expect(scaled.capturedAtUptimeNs == frame.capturedAtUptimeNs)
    #expect(scaled.presentationTimeNs == frame.presentationTimeNs)
}

@Test func ownedMediaFrameScalerDownscalesToEvenDimensions() throws {
    let scaler = OwnedMediaFrameScaler()
    let frame = try Self.makePixelBufferFrame(width: 641, height: 481)

    let scaled = try scaler.scaledFrame(frame, scaleDown: 1.5)

    #expect(CVPixelBufferGetWidth(scaled.pixelBuffer) == 426)
    #expect(CVPixelBufferGetHeight(scaled.pixelBuffer) == 320)
    #expect(scaled.capturedAtUptimeNs == frame.capturedAtUptimeNs)
    #expect(scaled.presentationTimeNs == frame.presentationTimeNs)
}
```

Add the helper inside `ScrollQualityTests`:

```swift
private static func makePixelBufferFrame(width: Int, height: Int) throws -> CapturedVideoFrame {
    var pixelBuffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
        [
            kCVPixelBufferIOSurfacePropertiesKey: [:],
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ] as CFDictionary,
        &pixelBuffer
    )
    guard status == kCVReturnSuccess, let pixelBuffer else {
        throw SessionRejected(reason: .malformed)
    }
    return CapturedVideoFrame(
        pixelBuffer: pixelBuffer,
        presentationTimeNs: 123_000_000,
        capturedAtUptimeNs: 456_000_000,
        rotation: ._0
    )
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: fails because `OwnedMediaFrameScaler` does not exist.

- [ ] **Step 3: Implement scaler**

Create `host/AgentDeskHost/OwnedMediaFrameScaler.swift`:

```swift
import CoreImage
import CoreVideo
import Foundation

enum OwnedMediaFrameScalerError: Error {
    case pixelBufferAllocationFailed
    case renderFailed
}

final class OwnedMediaFrameScaler: @unchecked Sendable {
    private let context: CIContext

    init(context: CIContext = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.sRGB) as Any])) {
        self.context = context
    }

    func scaledFrame(_ frame: CapturedVideoFrame, scaleDown: Double) throws -> CapturedVideoFrame {
        let effectiveScaleDown = max(scaleDown, 1.0)
        guard effectiveScaleDown > 1.0 else { return frame }

        let sourceWidth = CVPixelBufferGetWidth(frame.pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(frame.pixelBuffer)
        let outputWidth = Self.evenDimension(Double(sourceWidth) / effectiveScaleDown)
        let outputHeight = Self.evenDimension(Double(sourceHeight) / effectiveScaleDown)
        guard outputWidth != sourceWidth || outputHeight != sourceHeight else { return frame }

        var output: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            outputWidth,
            outputHeight,
            CVPixelBufferGetPixelFormatType(frame.pixelBuffer),
            [
                kCVPixelBufferIOSurfacePropertiesKey: [:],
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &output
        )
        guard status == kCVReturnSuccess, let output else {
            throw OwnedMediaFrameScalerError.pixelBufferAllocationFailed
        }

        let source = CIImage(cvPixelBuffer: frame.pixelBuffer)
        let scaleX = CGFloat(outputWidth) / CGFloat(max(sourceWidth, 1))
        let scaleY = CGFloat(outputHeight) / CGFloat(max(sourceHeight, 1))
        let scaled = source
            .transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
            .cropped(to: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

        context.render(scaled, to: output)
        Self.stampColorAttachments(output)
        return CapturedVideoFrame(
            pixelBuffer: output,
            presentationTimeNs: frame.presentationTimeNs,
            capturedAtUptimeNs: frame.capturedAtUptimeNs,
            rotation: frame.rotation
        )
    }

    static func evenDimension(_ value: Double) -> Int {
        let rounded = max(2, Int(value.rounded(.down)))
        return rounded.isMultiple(of: 2) ? rounded : rounded - 1
    }

    private static func stampColorAttachments(_ pixelBuffer: CVPixelBuffer) {
        CVBufferSetAttachment(pixelBuffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(pixelBuffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(pixelBuffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
    }
}
```

If CoreImage rendering to the YUV buffer fails at runtime, switch the scaler output pixel format to `kCVPixelFormatType_32BGRA` and relax the expected-pixel-format check for scaled motion frames only. Do not do that in the first implementation unless tests or device run prove it is necessary.

- [ ] **Step 4: Add file to Xcode project**

Update `host/AgentDeskHost.xcodeproj/project.pbxproj` so `OwnedMediaFrameScaler.swift` is compiled in the `AgentDeskHost` target. Match the existing PBX entries for `OwnedMediaTransport.swift`.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: all `ScrollQualityTests` pass.

## Task 4: Wire Scaler Into Encode Pump

**Files:**
- Modify: `host/AgentDeskHost/OwnedMediaTransport.swift`
- Test: `host/AgentDeskHostTests/ScrollQualityTests.swift`

- [ ] **Step 1: Write sizing policy test**

Add to `ScrollQualityTests`:

```swift
@Test func ownedMediaFrameScalerKeepsNativeSizeForRestBudgetAndDownscalesMotionBudget() throws {
    let scaler = OwnedMediaFrameScaler()
    let frame = try Self.makePixelBufferFrame(width: 1_920, height: 1_080)
    let restBudget = OwnedMediaEncodeBudget(mode: .rest, bitrateKbps: 8_000, expectedFrameRate: 30, scaleDown: 1.0)
    let motionBudget = OwnedMediaEncodeBudget(mode: .motion, bitrateKbps: 5_000, expectedFrameRate: 15, scaleDown: 1.5)

    let rest = try scaler.scaledFrame(frame, scaleDown: restBudget.scaleDown)
    let motion = try scaler.scaledFrame(frame, scaleDown: motionBudget.scaleDown)

    #expect(CVPixelBufferGetWidth(rest.pixelBuffer) == 1_920)
    #expect(CVPixelBufferGetHeight(rest.pixelBuffer) == 1_080)
    #expect(CVPixelBufferGetWidth(motion.pixelBuffer) == 1_280)
    #expect(CVPixelBufferGetHeight(motion.pixelBuffer) == 720)
}
```

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
```

Expected: passes if Task 3 landed correctly.

- [ ] **Step 3: Add scaler property**

In `OwnedMediaTransport`, add:

```swift
private let frameScaler = OwnedMediaFrameScaler()
```

- [ ] **Step 4: Scale frame before diagnostics admission and encode**

In `runEncodePump`, after:

```swift
let budget = currentEncodeBudget(nowUptimeNs: admissionNs)
```

insert:

```swift
let sourcePixelSize = Self.pixelSize(frame.pixelBuffer)
let encodeFrame: CapturedVideoFrame
do {
    encodeFrame = try frameScaler.scaledFrame(frame, scaleDown: budget.scaleDown)
} catch {
    logger.error("owned media pre-encode scale failed scaleDown=\(budget.scaleDown, privacy: .public) error=\(String(describing: error), privacy: .public)")
    diagnostics.setPhase(.idle)
    continue
}
let encodePixelSize = Self.pixelSize(encodeFrame.pixelBuffer)
```

Then change:

```swift
diagnostics.noteAdmitted(frame, decision: decision, budget: budget, nowUptimeNs: admissionNs)
diagnostics.noteEncodeStarted(frame: frame, nowUptimeNs: DispatchTime.now().uptimeNanoseconds)
guard let envelope = await encoder.encode(
    frame,
```

to:

```swift
diagnostics.noteAdmitted(encodeFrame, decision: decision, budget: budget, nowUptimeNs: admissionNs)
diagnostics.noteEncodeStarted(frame: encodeFrame, nowUptimeNs: DispatchTime.now().uptimeNanoseconds)
guard let envelope = await encoder.encode(
    encodeFrame,
```

The lifecycle key remains `capturedAtUptimeNs`, so preserving timestamps makes diagnostics continue to work.

- [ ] **Step 5: Add pixel size helper**

Add to `OwnedMediaTransport`:

```swift
private static func pixelSize(_ pixelBuffer: CVPixelBuffer) -> CapturePixelSize {
    CapturePixelSize(
        width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer)
    )
}
```

- [ ] **Step 6: Log scale and sizes**

Extend the cadence log in `runEncodePump`:

```swift
logger.notice("owned media cadence intervalMs=\(intervalMs, privacy: .public) admissionDelayMs=\(Double(delayNs) / 1_000_000.0, privacy: .public) cadenceLateMs=\(Double(cadenceLateNs) / 1_000_000.0, privacy: .public) mode=\(String(describing: decision.mode), privacy: .public) budgetMode=\(budget.mode.rawValue, privacy: .public) budgetKbps=\(budget.bitrateKbps, privacy: .public) budgetFps=\(budget.expectedFrameRate, privacy: .public) scaleDown=\(budget.scaleDown, privacy: .public) sourceSize=\(sourcePixelSize.width, privacy: .public)x\(sourcePixelSize.height, privacy: .public) encodeSize=\(encodePixelSize.width, privacy: .public)x\(encodePixelSize.height, privacy: .public)")
```

Extend `OwnedMediaFrameLifecycle` with:

```swift
var scaleDown: Double = 1.0
var sourceWidth: Int = 0
var sourceHeight: Int = 0
var encodeWidth: Int = 0
var encodeHeight: Int = 0
```

Change `noteAdmitted` signature to accept source and encode sizes:

```swift
func noteAdmitted(
    _ frame: CapturedVideoFrame,
    decision: OwnedMediaAdmissionDecision,
    budget: OwnedMediaEncodeBudget,
    sourcePixelSize: CapturePixelSize,
    encodePixelSize: CapturePixelSize,
    nowUptimeNs: UInt64
)
```

Set the new lifecycle fields. Then extend the host-frame log with:

```swift
scaleDown=\(snapshot.lifecycle.scaleDown, privacy: .public) sourceSize=\(snapshot.lifecycle.sourceWidth, privacy: .public)x\(snapshot.lifecycle.sourceHeight, privacy: .public) encodeSize=\(snapshot.lifecycle.encodeWidth, privacy: .public)x\(snapshot.lifecycle.encodeHeight, privacy: .public)
```

- [ ] **Step 7: Run focused test and host build**

Run:

```bash
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost -only-testing:AgentDeskHostTests/ScrollQualityTests test
xcodebuild -project host/AgentDeskHost.xcodeproj -scheme AgentDeskHost build
```

Expected: both pass.

## Task 5: Update Diagnostics Summary

**Files:**
- Modify: `tools/owned-media-diagnostics-summary.sh`
- Test: shell smoke with current saved logs

- [ ] **Step 1: Add parser output**

In `tools/owned-media-diagnostics-summary.sh`, add host parsing for:

```text
scaleDown=<double>
sourceSize=<width>x<height>
encodeSize=<width>x<height>
```

The summary should print:

```text
host scale rest=<count> motion=<count> scaled=<count>
host scaleMaxPackets scale1=<max> scaled=<max>
host scaleMaxBytes scale1=<max> scaled=<max>
```

Use `scaleDown <= 1.0` as `scale1`; use `scaleDown > 1.0` as `scaled`.

- [ ] **Step 2: Verify old logs still parse**

Run:

```bash
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected: script exits `0`. For logs without scale fields, it should print zeros or omit only the new maxima, but it must not fail.

- [ ] **Step 3: Add representative parser fixture if the repo has shell tests**

Search:

```bash
rg -n "owned-media-diagnostics-summary|diagnostics-summary|shell" tests host client tools
```

If there is an existing shell test harness, add a fixture line:

```text
owned media host-frame frame=42 keyframe=false keyframeReason=none mode=behind budgetMode=motion budgetKbps=5000 budgetFps=15 scaleDown=1.5 sourceSize=3024x1964 encodeSize=2016x1308 captureToAdmissionMs=0.1 encodeMs=24.0 sendMs=12.0 bytes=90000 packets=86 burst=16 pauseUs=2500 pacingReason=backpressure burstPauses=5 maxPacketGapMs=2.0 backpressure=true
```

Assert `scaled=1`, `scaleMaxPackets scaled=86`, and `scaleMaxBytes scaled=90000`.

## Task 6: Update Current Docs

**Files:**
- Modify: `.env.example`
- Modify: `SPEC.md`
- Optional modify: `TASKS.md`

- [ ] **Step 1: Update `.env.example` if not already done**

Confirm this line exists:

```bash
AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN=1.25        # pre-encode downscale while motion budget is active; 1.0 disables
```

- [ ] **Step 2: Update `SPEC.md`**

Under `## Recovery Policy`, after the existing capture freshness bullet, add:

```markdown
- Motion budget can downscale frames before VideoToolbox while client pressure is active. This is a transport pressure control only: rest returns to native capture, the client remains a single surface, and input coordinates stay in host logical space.
```

- [ ] **Step 3: Update `TASKS.md` only if this iteration ledger has an open relevant task**

If `TASKS.md` has an active owned-media diagnostics or tuning section, add one line for the motion-downscale experiment. If no active section exists, do not create a new top-level task just for this plan.

## Task 7: Full Verification and Device Run

**Files:**
- No source edits.

- [ ] **Step 1: Run full check**

Run:

```bash
just check
```

Expected: host and client builds/tests pass.

- [ ] **Step 2: Commit and push the green implementation**

Run:

```bash
git status --short
git add host/AgentDeskHost/SharedTypes.swift host/AgentDeskHost/Config.swift host/AgentDeskHost/OwnedMediaFrameScaler.swift host/AgentDeskHost/OwnedMediaTransport.swift host/AgentDeskHost.xcodeproj/project.pbxproj host/AgentDeskHostTests/ScrollQualityTests.swift tools/owned-media-diagnostics-summary.sh .env.example SPEC.md TASKS.md
git commit -m "feat: downscale owned media motion frames"
git push origin main
```

If `TASKS.md` was not changed, omit it from `git add`.

- [ ] **Step 3: Run attached-console physical iPhone verification**

Run:

```bash
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN=1.25 \
just fresh-consoled-run
```

Ask the user to scroll for 20 to 30 seconds. Stop the console run with Ctrl-C after the user says done. Exit `130` is expected after manual stop.

- [ ] **Step 4: Summarize diagnostics**

Run:

```bash
tools/owned-media-diagnostics-summary.sh /tmp/agentdesk-client-console.log
```

Expected acceptance signals:

- `host scale ... scaled` is nonzero during motion.
- Scaled motion max packets are below the prior `315` packet spike.
- Scaled motion max bytes are below the prior `329850` byte spike.
- Client `maxFirstToCompleteMs` stays below the prior `142.3ms` spike.
- Client repair remains quiet: no resend storm, expired keyframes, stale skips, or malformed/auth drops.
- Rest returns to native source/encode size after the quiet hold.

If motion readability is too soft, rerun once with:

```bash
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN=1.15 \
just fresh-consoled-run
```

If frame spikes remain above `200 KB` at `1.25`, rerun once with:

```bash
AGENTDESK_OWNED_MEDIA_CODEC=hevc \
AGENTDESK_OWNED_MEDIA_CHROMA=420 \
AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN=1.5 \
just fresh-consoled-run
```

Do not tune more than these two comparison points in this slice.

## Self-Review

Spec coverage:
- Motion-only pre-encode downscale is implemented by budget scale fields, `OwnedMediaFrameScaler`, encode-pump wiring, diagnostics, docs, and device verification.
- Rest crispness is preserved because rest budget uses existing native capture scale.
- No VT session recreation is introduced. Session rebuilds only when VideoToolbox sees a changed pixel size.
- Input mapping is untouched.

Placeholder scan:
- No task uses placeholder language or generic test instructions.
- Every code-changing task has concrete file paths and code snippets.

Type consistency:
- `OwnedMediaEncodeBudget.scaleDown`, `OwnedMediaMotionBudgetPolicy.restScaleDown`, and `motionScaleDown` are used consistently.
- `OwnedMediaFrameScaler.scaledFrame(_:scaleDown:)` returns `CapturedVideoFrame`, preserving existing encoder contract.
