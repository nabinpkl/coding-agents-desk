import CoreVideo
import VideoToolbox
import XCTest
import AgentDeskWire
@testable import AgentDeskHost

// Phase 1 of the mixed-mode renderer (ADR-0025): the host HEVC encoder produces a
// keyframe-then-delta envelope sequence, force-keyframes on demand, and stamps the
// wire refresh reason. The bytes are dropped here; the datagram carrier (Phase 2)
// is what sends them. These tests run hardware HEVC on the Mac test host.
final class VideoToolboxOwnedMediaEncoderTests: XCTestCase {
    private func makeFrame(
        frameIndex: UInt64,
        width: Int = 256,
        height: Int = 256,
        presentationTimeNs: Int64? = nil
    ) -> CapturedVideoFrame {
        var buffer: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:],
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &buffer
        )
        precondition(status == kCVReturnSuccess, "pixel buffer create failed")
        let pixelBuffer = buffer!
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        let base = CVPixelBufferGetBaseAddress(pixelBuffer)!
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let band = Int(frameIndex % 256)
        for y in 0..<height {
            let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let offset = x * 4
                row[offset + 0] = UInt8((x + band) % 256)
                row[offset + 1] = UInt8((y + band) % 256)
                row[offset + 2] = UInt8((x + y + band) % 256)
                row[offset + 3] = 255
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: presentationTimeNs ?? Int64(frameIndex) * 33_333_333,
            capturedAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
            rotation: ._0
        )
    }

    private func config() -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(targetBitrateKbps: 2000, expectedFrameRate: 30)
    }

    private func updateId(_ frameId: UInt64) -> OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: frameId)
    }

    // Awaiting inside XCTUnwrap's autoclosure is rejected, so the await is split out.
    private func encodeFrame(
        _ encoder: VideoToolboxOwnedMediaEncoder,
        frameIndex: UInt64,
        frameId: UInt64,
        forceKeyframe: Bool = false,
        requestedKeyframeReason: OwnedMediaKeyframeReason? = nil,
        presentationTimeNs: Int64? = nil
    ) async throws -> OwnedMediaFrameEnvelope {
        let envelope = await encoder.encode(
            makeFrame(frameIndex: frameIndex, presentationTimeNs: presentationTimeNs),
            updateId: updateId(frameId),
            forceKeyframe: forceKeyframe,
            requestedKeyframeReason: requestedKeyframeReason
        )
        return try XCTUnwrap(envelope, "encoder produced no frame for frameId \(frameId)")
    }

    func testFirstFrameIsKeyframeWithParameterSets() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config())
        defer { encoder.invalidate() }
        let frame = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        XCTAssertTrue(frame.header.isKeyframe)
        XCTAssertEqual(frame.header.codec, .hevc)
        XCTAssertEqual(frame.header.refreshReason, .initial)
        let parameterSets = try XCTUnwrap(frame.header.parameterSets, "keyframe carries no parameter sets")
        XCTAssertFalse(parameterSets.sps.isEmpty)
        XCTAssertFalse(parameterSets.pps.isEmpty)
        XCTAssertNotNil(parameterSets.vps, "HEVC parameter sets include a VPS")
        XCTAssertFalse(frame.payload.isEmpty)
    }

    func testEnvelopeRoundTripsThroughTheWire() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config())
        defer { encoder.invalidate() }
        let envelope = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let decoded = try OwnedMediaFrameEnvelope.decode(envelope.encode())
        XCTAssertEqual(decoded.header, envelope.header)
        XCTAssertEqual(decoded.payload, envelope.payload)
    }

    func testSecondFrameIsDelta() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config())
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let second = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        XCTAssertFalse(second.header.isKeyframe, "second frame should be inter-predicted")
        XCTAssertNil(second.header.parameterSets, "delta frames carry no parameter sets")
        XCTAssertEqual(second.header.refreshReason, .rest)
    }

    // ADR-0087: splitting the forced-keyframe reasons apart must not move any wire value.
    // Before the split every forced keyframe reported itself as `clientRequest` and so
    // classified as `.reset`; each distinct reason has to keep doing that, or a stall
    // recovery would newly tell the client "rest" for a frame that is a fresh start.
    func testEveryForcedKeyframeReasonStillClassifiesAsReset() {
        for reason: OwnedMediaKeyframeReason in [
            .clientRequest, .resolutionChange, .stallRecovery, .resumeWatching, .captureRequested
        ] {
            XCTAssertEqual(
                OwnedMediaRefreshReason.fromEncodedFrame(
                    encodedFrameId: 42,
                    isKeyframe: true,
                    requestedKeyframeReason: reason,
                    expectedKeyframeReason: reason
                ),
                .reset,
                "forced keyframe reason \(reason.rawValue) no longer classifies as reset"
            )
        }
    }

    // A keyframe the encoder placed on its own interval carries no reason, and is a rest
    // refresh rather than a reset: nothing about the stream was reset, it is simply the
    // periodic sync point.
    func testEncoderPlacedKeyframeClassifiesAsRest() {
        let noReason: OwnedMediaKeyframeReason? = nil
        let classified = OwnedMediaRefreshReason.fromEncodedFrame(
            encodedFrameId: 42,
            isKeyframe: true,
            requestedKeyframeReason: noReason,
            expectedKeyframeReason: noReason
        )
        XCTAssertEqual(classified, .rest)
    }

    func testRequestKeyframeForcesTheNextFrame() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config())
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let second = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        XCTAssertFalse(second.header.isKeyframe)
        encoder.requestKeyframe()
        let third = try await encodeFrame(encoder, frameIndex: 2, frameId: 3)
        XCTAssertTrue(third.header.isKeyframe, "requestKeyframe must force the next frame to be a keyframe")
    }

    // ADR-0027 R83: the windowed ceiling is exactly `ratio` times the average
    // byte-rate (kbps * 1000 / 8) over a one-second window. This is the value set on
    // the session as kVTCompressionPropertyKey_DataRateLimits, so testing it tests
    // what the encoder caps to.
    func testDataRateLimitsCeilingTracksBitrateAndRatio() {
        let low = VideoToolboxOwnedMediaEncoder.dataRateLimits(targetBitrateKbps: 2000, ratio: 2.0)
        XCTAssertEqual(low.bytesPerWindow, 500_000, "2000 kbps = 250000 B/s, x2.0 over 1 s")
        XCTAssertEqual(low.windowSeconds, 1.0)
        let high = VideoToolboxOwnedMediaEncoder.dataRateLimits(targetBitrateKbps: 8000, ratio: 1.5)
        XCTAssertEqual(high.bytesPerWindow, 1_500_000, "8000 kbps = 1000000 B/s, x1.5 over 1 s")
    }

    // A forced keyframe is the burst the cap exists to bound. One full keyframe
    // interval of encoded bytes must fit the one-second window budget. (That the cap
    // *binds* on full-screen Retina content is device-validated in R91; the unit
    // guarantee is that the encoder accepts the property and never exceeds it.)
    func testForcedKeyframeStaysWithinDataRateCap() async throws {
        let ratio = 1.5
        let configuration = OwnedMediaEncodingConfiguration(
            targetBitrateKbps: 2000,
            expectedFrameRate: 30,
            dataRateLimitRatio: ratio
        )
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: configuration)
        defer { encoder.invalidate() }
        let cap = VideoToolboxOwnedMediaEncoder.dataRateLimits(targetBitrateKbps: 2000, ratio: ratio).bytesPerWindow
        let first = try await encodeFrame(encoder, frameIndex: 0, frameId: 1, forceKeyframe: true)
        XCTAssertTrue(first.header.isKeyframe, "forced first frame is a keyframe")
        var total = first.payload.count
        for index in 1..<30 {
            let delta = try await encodeFrame(encoder, frameIndex: UInt64(index), frameId: UInt64(index + 1))
            total += delta.payload.count
        }
        XCTAssertLessThanOrEqual(Double(total), cap, "keyframe-interval bytes exceeded the DataRateLimits window cap")
    }

    // ADR-0101: the continuous media-quality controller, pure-logic against fixed inputs.
    //
    // The derived-cadence arithmetic these tests rely on: no input carries an EWMA, so the
    // frame budget is seedFrameBytes * frameBytesHeadroom = 13,000B, and
    // fps(kbps) = kbps * 125 / 13_000. The blind descent is *0.7 per confirmed step:
    // 2500 -> 1750 (16fps) -> 1225 (11) -> 858 (8) -> ... -> floor 60 (1fps).
    private func mediaQualityConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: 2500, floorKbps: 60,
            downStep: 0.7, upStep: 1.15,
            lossDownPermille: 50, raiseCleanWindows: 4, cadenceDownWindows: 2,
            fpsCeiling: 30,
            ackHoldP95Ms: 180, ackDownP95Ms: 350,
            cadenceGapMs: 500, freezeGapMs: 1_000, freezeFpsCeiling: 3,
            resolutionScale: 0.5,
            seedFrameBytes: 10_000, frameBytesHeadroom: 1.3, deliverySnapRatio: 0.85
        )
    }

    private func lossySample(ackP95Ms: Double? = nil) -> MediaQualitySample {
        MediaQualitySample(completedFrames: 80, expiredFrames: 20, ackAgeP95Ms: ackP95Ms)
    }

    private func cleanSample(ackP95Ms: Double? = nil) -> MediaQualitySample {
        MediaQualitySample(completedFrames: 100, expiredFrames: 0, ackAgeP50Ms: ackP95Ms, ackAgeP95Ms: ackP95Ms)
    }

    // Acks slowing past the hold threshold (180ms) but below the down threshold
    // (350ms): the link is genuinely stressed without tripping queuePressure. This
    // is the real "freeze/cadence downshift" condition now that a calm-but-clean
    // sparse window (fast acks, no loss) no longer reads as a freeze.
    private func stressedSample(ackP95Ms: Double = 200) -> MediaQualitySample {
        MediaQualitySample(completedFrames: 100, expiredFrames: 0, ackAgeP50Ms: ackP95Ms, ackAgeP95Ms: ackP95Ms)
    }

    private func production(
        actualFps: Int = 30,
        targetFps: Int = 30,
        maxGapMs: Int = 33,
        sentKbps: Int = 2_000
    ) -> MediaProductionSummary {
        MediaProductionSummary(
            actualFps: actualFps,
            targetFps: targetFps,
            fpsDeficit: max(0, targetFps - actualFps),
            frames: max(1, actualFps),
            keyframes: 1,
            sentKbps: sentKbps,
            targetKbps: 2_500,
            maxGapMs: maxGapMs,
            resolutionScale: 1.0,
            windowMs: 1_000
        )
    }

    private func input(
        _ sample: MediaQualitySample,
        productionSummary: MediaProductionSummary? = nil,
        ackCount: Int = 1,
        staleRecoveryCount: Int = 0
    ) -> MediaQualityControllerInput {
        MediaQualityControllerInput(
            delivery: MediaDeliveryObservation(
                sample: sample,
                ackCount: ackCount,
                ackAgeMaxMs: sample.ackAgeP95Ms,
                staleRecoveryCount: staleRecoveryCount
            ),
            production: productionSummary
        )
    }

    private func cleanInput(ackP95Ms: Double? = 50) -> MediaQualityControllerInput {
        input(cleanSample(ackP95Ms: ackP95Ms), productionSummary: production(), ackCount: ackP95Ms == nil ? 0 : 1)
    }

    private func lossInput(ackP95Ms: Double? = nil) -> MediaQualityControllerInput {
        input(lossySample(ackP95Ms: ackP95Ms), productionSummary: production(), ackCount: ackP95Ms == nil ? 0 : 1)
    }


    func testHostMediaStateDisablingAdaptiveQualityPinsManualTarget() {
        var state = QuicSessionHostMediaState(
            qualityControllerConfig: mediaQualityConfig()
        )
        // Drive the adaptive controller well below its ceiling before pinning, so the pin and
        // the later handoff are exercised against a genuinely moved target.
        for _ in 0..<16 {
            _ = state.observeLinkHealth(
                completedFrames: 80,
                expiredFrames: 20,
                productionSummary: production()
            )
        }
        XCTAssertLessThan(state.targetKbps, 2_500, "setup should drive the adaptive target below the ceiling")

        let disabled = state.applyClientMediaQuality(ClientMediaQualityConfig(
            adaptiveEnabled: false,
            fixedTarget: ClientMediaQualityTarget(
                bitrateKbps: 180,
                fps: 1,
                resolutionScale: 0.5
            )
        ))
        XCTAssertEqual(disabled?.target.bitrateKbps, 180)
        XCTAssertEqual(disabled?.target.fps, 1)
        XCTAssertEqual(disabled?.target.resolutionScale, 0.5)
        XCTAssertEqual(disabled?.reason, "manual-quality-fixed")

        let stressedWhileDisabled = state.observeLinkHealth(
            completedFrames: 50,
            expiredFrames: 50,
            productionSummary: production(actualFps: 1, maxGapMs: 1_500)
        )
        XCTAssertFalse(stressedWhileDisabled.outcome.changed)
        XCTAssertEqual(stressedWhileDisabled.outcome.reason, "manual-quality-fixed")
        XCTAssertEqual(state.targetKbps, 180)
        XCTAssertEqual(state.targetFps, 1)
        XCTAssertEqual(state.targetResolutionScale, Config.ownedMediaResolutionScale)

        // ADR-0098 changed what this hands back. It used to be the ceiling -- 2500/30/1.0 -- and
        // that jump is what the measured 223KB of keyframe in 364ms was: the encoder recreated
        // its session at the full 3600x2338 before any measurement arrived, then the
        // link-quality prior spent a second keyframe going back down one window later.
        //
        // ADR-0100: every rung now carries the same scale, so the handoff can no longer be
        // identified by "the rung that owns 0.5" -- there is no such rung. What still matters,
        // and is what this asserts, is that the scale does not MOVE across the handoff, because
        // that is the part that would have cost an IDR.
        let reenabled = state.applyClientMediaQuality(ClientMediaQualityConfig(adaptiveEnabled: true))
        XCTAssertEqual(reenabled?.target.resolutionScale, 0.5, "the running scale is kept, so no IDR is spent")
        XCTAssertEqual(reenabled?.target.resolutionScale, Config.ownedMediaResolutionScale)
        XCTAssertEqual(reenabled?.reason, "adaptive-quality-enabled")
    }

    func testMediaQualityControllerRaisesOnlyAfterCleanStreak() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let down = controller.observe(input(MediaQualitySample(completedFrames: 50, expiredFrames: 50), productionSummary: production())).outcome
        XCTAssertEqual(down.reason, "loss-down")
        let afterDown = controller.targetKbps
        XCTAssertLessThan(afterDown, 2500)
        XCTAssertFalse(controller.observe(cleanInput()).outcome.changed)
        XCTAssertFalse(controller.observe(cleanInput()).outcome.changed)
        XCTAssertFalse(controller.observe(cleanInput()).outcome.changed)
        XCTAssertEqual(controller.targetKbps, afterDown, "three clean windows do not raise; hysteresis needs four")
        let up = controller.observe(cleanInput()).outcome
        XCTAssertEqual(up.reason, "quality-up")
        XCTAssertGreaterThan(controller.targetKbps, afterDown)
    }

    func testMediaQualityControllerCleanAckOnlyWindowCompletesRecoveryStreak() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let down = controller.observe(lossInput()).outcome
        XCTAssertEqual(down.reason, "loss-down")
        let afterDown = controller.targetKbps

        // Three clean production windows accrue recovery credit (1s each).
        for index in 1...3 {
            let hold = controller.observe(cleanInput())
            XCTAssertEqual(hold.outcome.reason, "clean-hold")
            XCTAssertEqual(hold.recoveryStatus.cleanMs, index * 1_000)
        }

        // A clean ack-only window (sparse screen, no production summary) is still
        // real link-clean time: it accrues a nominal window and completes the
        // streak, so recovery climbs instead of stalling between production windows.
        let linkOnly = controller.observe(input(cleanSample(ackP95Ms: 50), ackCount: 1))
        XCTAssertEqual(linkOnly.outcome.reason, "quality-up")
        XCTAssertGreaterThan(controller.targetKbps, afterDown)
    }

    func testMediaQualityControllerRecoversFromSustainedCleanAckOnlyWindows() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let down = controller.observe(lossInput()).outcome
        XCTAssertEqual(down.reason, "loss-down")
        let afterDown = controller.targetKbps

        // Sparse, clean ack-only windows (no production) are healthy link time, so
        // the ladder must climb back rather than stall. This is the rest-recovery
        // the device run needed: at rest the video is sparse and never reached the
        // old production-based recovery gates.
        var climbed = false
        for _ in 0..<8 {
            let decision = controller.observe(input(cleanSample(ackP95Ms: 50), ackCount: 1))
            if decision.outcome.reason == "quality-up" { climbed = true }
        }
        XCTAssertTrue(climbed, "clean ack-only windows must let the target recover")
        XCTAssertGreaterThan(controller.targetKbps, afterDown)
    }

    func testMediaQualityControllerNeverExceedsCeiling() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(cleanInput()) }
        XCTAssertEqual(controller.targetKbps, 2500, "clean windows cannot raise above the ceiling")
        XCTAssertEqual(controller.targetFps, 30)
        XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)
    }

    func testMediaQualityControllerIdleWindowHolds() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let outcome = controller.observe(input(MediaQualitySample(completedFrames: 0, expiredFrames: 0))).outcome
        XCTAssertFalse(outcome.changed)
        XCTAssertEqual(outcome.reason, "idle")
        XCTAssertEqual(controller.targetKbps, 2500)
        XCTAssertEqual(outcome.target.fps, 30, "fps holds at the ceiling on an idle window")
    }

    func testMediaQualityControllerIdleWindowBelowNativeAccruesRecovery() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.targetKbps, 60, "sustained loss walks the target to the floor")

        let idle = input(MediaQualitySample(completedFrames: 0, expiredFrames: 0))
        let first = controller.observe(idle)
        XCTAssertEqual(first.outcome.reason, "clean-hold", "a calm window below native accrues recovery, not idle")
        XCTAssertEqual(first.recoveryStatus.cleanMs, 1_000)
        XCTAssertFalse(first.outcome.changed)
    }

    func testMediaQualityControllerIdleRecoversToNativeAtRest() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.targetKbps, 60)
        XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)

        // The screen settles: zero-activity, link-clean windows. The target climbs
        // back to the ceiling with no production to measure, so the next motion is crisp.
        let idle = input(MediaQualitySample(completedFrames: 0, expiredFrames: 0))
        var windows = 0
        while controller.targetKbps < 2500 && windows < 400 {
            _ = controller.observe(idle)
            windows += 1
        }
        XCTAssertEqual(controller.targetKbps, 2500, "sustained rest climbs the target back to the ceiling")
        XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)
        // 24, not the 30 ceiling: with no measured frames the cadence is derived through the
        // 13,000B seed budget, and 2500kbps carries 24 such frames a second. Real content
        // cheaper than the seed raises this through the EWMA.
        XCTAssertEqual(controller.targetFps, 24)
    }

    func testMediaQualityControllerInflightStallDoesNotClimbAtRest() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        for _ in 0..<40 { _ = controller.observe(lossInput()) }
        XCTAssertEqual(controller.targetKbps, 60)

        // Zero completions this window, but frames are still inflight: a pre-timeout
        // stall, not an idle screen. Recovery must not climb.
        let stall = MediaQualityControllerInput(
            delivery: MediaDeliveryObservation(
                sample: MediaQualitySample(completedFrames: 0, expiredFrames: 0),
                ackCount: 0,
                ackAgeMaxMs: nil,
                inFlightFrames: 3,
                inFlightBytes: 90_000,
                oldestInflightMs: 1_200,
                staleRecoveryCount: 0
            )
        )
        for _ in 0..<20 {
            let decision = controller.observe(stall)
            XCTAssertNotEqual(decision.outcome.reason, "quality-up")
        }
        XCTAssertEqual(controller.targetKbps, 60, "a stall must not be mistaken for idle recovery")
    }

    // ADR-0101: sustained pressure walks the target down multiplicatively, cadence deriving
    // with it, and stops AT the floor rather than churning against it. This is the continuous
    // successor to the rung-walk test: no fixed stops, but every step must move both axes
    // coherently and the floor must be terminal.
    func testMediaQualityControllerSustainedLossWalksToTheFloorAndStays() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        var previousKbps = controller.targetKbps
        var reachedFloor = false
        for _ in 0..<20 {
            let outcome = controller.observe(lossInput()).outcome
            if controller.targetKbps == 60 {
                reachedFloor = true
                XCTAssertEqual(outcome.reason, controller.targetKbps == previousKbps ? "at-floor" : "loss-down")
            } else {
                XCTAssertEqual(outcome.reason, "loss-down")
                XCTAssertLessThan(controller.targetKbps, previousKbps, "every confirmed descent moves down")
            }
            // The cadence rides the bitrate: never more frames than the budget carries.
            let budgetFps = min(max(Int(Double(controller.targetKbps) * 125.0 / 13_000.0), 1), 30)
            XCTAssertEqual(controller.targetFps, budgetFps)
            XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)
            previousKbps = controller.targetKbps
        }
        XCTAssertTrue(reachedFloor, "twenty confirmed descents from 2500 must reach the 60kbps floor")
        XCTAssertEqual(controller.targetKbps, 60)
        XCTAssertEqual(controller.targetFps, 1, "the floor is a heartbeat: one frame a second")
    }

    func testMediaQualityControllerLatencyHoldsWithoutLossAndDownshiftsWithLoss() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let highLatencyOnly = controller.observe(cleanInput(ackP95Ms: 600)).outcome
        XCTAssertFalse(highLatencyOnly.changed)
        XCTAssertEqual(highLatencyOnly.reason, "latency-hold")

        let highLatencyWithLoss = controller.observe(lossInput(ackP95Ms: 600)).outcome
        XCTAssertTrue(highLatencyWithLoss.changed)
        XCTAssertEqual(highLatencyWithLoss.reason, "loss-down")
    }

    func testMediaQualityControllerCadencePressureDownshiftsAfterSustainedWindows() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let slow = input(
            stressedSample(),
            productionSummary: production(actualFps: 10, targetFps: 30, maxGapMs: 650)
        )

        let first = controller.observe(slow)
        XCTAssertFalse(first.outcome.changed)
        XCTAssertTrue(first.signals.cadencePressure)
        XCTAssertEqual(first.outcome.reason, "cadence-hold")

        let second = controller.observe(slow)
        XCTAssertEqual(second.outcome.target.bitrateKbps, 1750, "one blind multiplicative step from the ceiling")
        XCTAssertEqual(second.outcome.reason, "cadence-capacity-down")
        XCTAssertTrue(second.outcome.fpsChanged, "the free axes answer the pressure on this window")
        XCTAssertTrue(second.outcome.bitrateChanged)
        // ADR-0100: resolution never moves at all now, so this is no longer "two windows are not
        // yet enough evidence" -- it is that the axis is gone. The assertion is kept because it
        // is the invariant the whole change rests on: a quality move must not rescale.
        XCTAssertFalse(second.outcome.resolutionChanged)
        XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)
    }

    func testMediaQualityControllerQueueAndCadencePressureDownshiftsImmediately() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let slowQueued = input(
            cleanSample(ackP95Ms: 600),
            productionSummary: production(actualFps: 12, targetFps: 30, maxGapMs: 700)
        )

        let decision = controller.observe(slowQueued)

        XCTAssertTrue(decision.signals.queuePressure)
        XCTAssertTrue(decision.signals.cadencePressure)
        XCTAssertEqual(decision.outcome.target.bitrateKbps, 1750)
        XCTAssertEqual(decision.outcome.reason, "queue-cadence-down")
    }

    // R231b: renamed from ...DownshiftsImmediately. It no longer does, and that is the point:
    // 47 of 51 measured stale bursts lasted a single window, and collapsing the ladder on each
    // of them is what made it oscillate. The signal still fires on the first window; only the
    // downshift waits for a second.
    func testMediaQualityControllerStaleRecoveryDownshiftsAfterConsecutiveWindows() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let stale = input(
            cleanSample(ackP95Ms: 50),
            productionSummary: production(),
            staleRecoveryCount: 1
        )

        let held = controller.observe(stale)
        XCTAssertTrue(held.signals.stalePressure)
        XCTAssertEqual(held.outcome.target.bitrateKbps, 2500, "one window of stale pressure is not evidence")
        XCTAssertEqual(held.outcome.reason, "stale-hold")

        let decision = controller.observe(stale)

        XCTAssertTrue(decision.signals.stalePressure)
        XCTAssertEqual(decision.outcome.target.bitrateKbps, 1750)
        XCTAssertEqual(decision.outcome.reason, "stale-capacity-down")
    }

    func testMediaQualityControllerFreezeDescendsImmediately() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        let frozen = input(
            stressedSample(),
            productionSummary: production(actualFps: 1, targetFps: 30, maxGapMs: 1_250)
        )

        let decision = controller.observe(frozen)

        XCTAssertTrue(decision.signals.freezePressure)
        XCTAssertEqual(decision.outcome.target.bitrateKbps, 1750, "a freeze needs no streak: one window descends")
        XCTAssertEqual(decision.outcome.target.resolutionScale, Config.ownedMediaResolutionScale)
        XCTAssertEqual(decision.outcome.reason, "freeze-capacity-down")
    }

    func testMediaQualityControllerSustainedFreezeKeepsDescending() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        var previous = controller.targetKbps
        for _ in 0..<3 {
            let decision = controller.observe(input(
                stressedSample(),
                productionSummary: production(actualFps: 1, targetFps: controller.targetFps, maxGapMs: 1_250)
            ))
            XCTAssertEqual(decision.outcome.reason, "freeze-capacity-down")
            XCTAssertLessThan(controller.targetKbps, previous)
            previous = controller.targetKbps
        }
        // Three confirmed freeze windows from the ceiling: 2500 -> 1750 -> 1225 -> 858, with
        // the derived cadence following (16 -> 11 -> 8 through the 13,000B seed budget).
        XCTAssertEqual(controller.targetKbps, 858)
        XCTAssertEqual(controller.targetFps, 8)
        XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)
    }

    func testMediaQualityControllerDoesNotRecoverWhileCadenceIsBad() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        _ = controller.observe(input(
            stressedSample(),
            productionSummary: production(actualFps: 1, targetFps: 30, maxGapMs: 1_250)
        ))
        XCTAssertEqual(controller.targetResolutionScale, Config.ownedMediaResolutionScale)
        let badCadence = input(
            stressedSample(),
            productionSummary: production(actualFps: 12, targetFps: 24, maxGapMs: 700)
        )

        for _ in 0..<8 {
            let decision = controller.observe(badCadence)
            XCTAssertNotEqual(decision.outcome.reason, "quality-up")
        }

        XCTAssertLessThan(controller.targetResolutionScale, 1.0)
    }

    func testMediaQualityControllerBadCadenceResetsRecoveryCredit() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        _ = controller.observe(lossInput())

        for _ in 0..<3 { _ = controller.observe(cleanInput()) }
        let badCadence = controller.observe(input(
            stressedSample(),
            productionSummary: production(actualFps: 10, targetFps: 30, maxGapMs: 650)
        ))
        XCTAssertEqual(badCadence.recoveryStatus.cleanMs, 0)
        XCTAssertEqual(badCadence.recoveryStatus.blocker, "cadence-pressure")

        for _ in 0..<3 {
            let hold = controller.observe(cleanInput())
            XCTAssertEqual(hold.outcome.reason, "clean-hold")
        }
        XCTAssertLessThan(controller.targetKbps, 2500)
    }

    func testMediaQualityControllerConfigNormalizesKnobs() {
        let config = MediaQualityControllerConfig(
            ceilingKbps: 2500, floorKbps: 5000,
            downStep: 1.5, upStep: 0.5,
            lossDownPermille: 0, raiseCleanWindows: 0, cadenceDownWindows: 0,
            fpsCeiling: 30,
            ackHoldP95Ms: 0, ackDownP95Ms: 0,
            cadenceGapMs: 0, freezeGapMs: 0, freezeFpsCeiling: 0,
            resolutionScale: 2,
            seedFrameBytes: 10, frameBytesHeadroom: 0.5, deliverySnapRatio: 7
        )
        XCTAssertEqual(config.floorKbps, 2500, "the floor cannot exceed the ceiling")
        XCTAssertLessThan(config.downStep, 1.0, "down step must stay a down step")
        XCTAssertGreaterThan(config.upStep, 1.0, "up step must stay an up step")
        XCTAssertEqual(config.cadenceDownWindows, 1)
        XCTAssertEqual(config.freezeGapMs, config.cadenceGapMs)
        // A tiny frame-cost seed would read as "frames are free" and derive the ceiling fps
        // from any budget; the divisor floors well above zero.
        XCTAssertEqual(config.seedFrameBytes, 500)
        XCTAssertEqual(config.frameBytesHeadroom, 1.0, "headroom below 1 would size frames under their own cost")
        XCTAssertEqual(config.deliverySnapRatio, 1.0, "a snap above the measured rate is not a descent")
        // 2 is not a scale.
        XCTAssertEqual(config.resolutionScale, 1.0)
    }

    func testMediaStateReturnsCapacityRetryUntilIntervalElapses() {
        var controller = MediaQualityController(config: mediaQualityConfig())
        // One confirmed loss descent: 2500 -> 1750, whose derived cadence through the 13,000B
        // seed budget is 16fps -- a 62.5ms production interval for the capacity gate below.
        _ = controller.observe(lossInput())
        XCTAssertEqual(controller.targetFps, 16)

        var state = QuicSessionHostMediaState(
            expectedFrameRate: 30,
            qualityController: controller
        )

        let firstAdmission = state.reserveUpdateId(nowNs: 1_000_000_000)
        guard case .ready(let firstUpdateId, _) = firstAdmission else {
            return XCTFail("expected first frame admission to succeed")
        }
        XCTAssertEqual(firstUpdateId.frameId, 1)

        let secondAdmission = state.reserveUpdateId(nowNs: 1_030_000_000)
        guard case .retry(let afterNs, let reason) = secondAdmission else {
            return XCTFail("expected capacity retry while cadence gate is active")
        }
        XCTAssertEqual(reason, .capacity)
        XCTAssertGreaterThan(afterNs, 0)
        XCTAssertLessThanOrEqual(afterNs, 40_000_000)

        let thirdAdmission = state.reserveUpdateId(nowNs: 1_067_000_000)
        guard case .ready(let secondUpdateId, _) = thirdAdmission else {
            return XCTFail("expected admission after capacity interval elapsed")
        }
        XCTAssertEqual(secondUpdateId.frameId, 2)
    }

    func testMediaStateAbandonsInflightFrameImmediatelyWithoutForcedKeyframe() {
        var state = QuicSessionHostMediaState(
            maxInflightFrames: 1,
            maxInflightBytes: 10_000,
            expectedFrameRate: 30
        )

        let firstAdmission = state.reserveUpdateId(nowNs: 1_000_000_000)
        guard case .ready(let firstUpdateId, _) = firstAdmission else {
            return XCTFail("expected first frame admission to succeed")
        }
        state.noteSent(
            frameId: firstUpdateId.frameId,
            encodedBytes: 2_000,
            packets: [],
            sentAtUptimeNs: 1_000_000_000
        )

        let latestAdmission = state.reserveUpdateId(nowNs: 1_050_000_000)
        guard case .ready(let latestUpdateId, let abandoned) = latestAdmission else {
            return XCTFail("expected latest frame admission without ACK wait")
        }
        XCTAssertEqual(latestUpdateId.frameId, 2)
        XCTAssertEqual(abandoned.map(\.id), [firstUpdateId.frameId])
        XCTAssertFalse(state.takeClientKeyframeRequest())
    }

    func testMediaStateCoalescesClientKeyframeRequestsWhileKeyframeIsInflight() {
        var state = QuicSessionHostMediaState(
            maxInflightFrames: 2,
            maxInflightBytes: 200_000,
            expectedFrameRate: 30
        )

        XCTAssertEqual(state.noteKeyframeRequest(), .queued)
        XCTAssertTrue(state.takeClientKeyframeRequest())
        XCTAssertFalse(state.takeClientKeyframeRequest(), "client keyframe request is one-shot")

        state.noteSent(frameId: 1, encodedBytes: 60_000, packets: [], isKeyframe: true, sentAtUptimeNs: 1_000_000_000)
        XCTAssertEqual(state.noteKeyframeRequest(), .suppressedInFlight(frameId: 1))
        XCTAssertFalse(state.takeClientKeyframeRequest())

        _ = state.noteAck(frameId: 1, nowNs: 1_050_000_000)
        XCTAssertEqual(state.noteKeyframeRequest(), .queued)
        XCTAssertTrue(state.takeClientKeyframeRequest())
    }

    func testAbandoningInflightKeyframeReopensKeyframeRequestAdmission() {
        var state = QuicSessionHostMediaState(
            maxInflightFrames: 1,
            maxInflightBytes: 200_000,
            expectedFrameRate: 30
        )
        guard case .ready(let first, _) = state.reserveUpdateId(nowNs: 0) else {
            return XCTFail("expected first admission")
        }
        state.noteSent(
            frameId: first.frameId,
            encodedBytes: 60_000,
            packets: [],
            isKeyframe: true,
            sentAtUptimeNs: 0
        )
        XCTAssertEqual(
            state.noteKeyframeRequest(),
            .suppressedInFlight(frameId: first.frameId)
        )

        guard case .ready(_, let abandoned) = state.reserveUpdateId(nowNs: 1) else {
            return XCTFail("expected latest admission to abandon the old keyframe")
        }
        XCTAssertEqual(abandoned.map(\.id), [first.frameId])
        XCTAssertEqual(state.noteKeyframeRequest(), .queued)
        XCTAssertTrue(state.takeClientKeyframeRequest())
    }

    func testClientRequestKeyframeMarksReset() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config())
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        _ = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        let forced = try await encodeFrame(
            encoder, frameIndex: 2, frameId: 3,
            forceKeyframe: true, requestedKeyframeReason: .clientRequest
        )
        XCTAssertTrue(forced.header.isKeyframe)
        XCTAssertEqual(forced.header.refreshReason, .reset, "a client-requested keyframe is a reset refresh")
    }

    // R230. A client whose decoder iOS reclaimed sends `clientHasNoReferences` on the control
    // datagram, but the keyframe request it accompanies is only QUEUED, so an ordinary frame can
    // be encoded between the two. That frame must not spend the flag: if it does, the request
    // that follows is answered with a long-term-reference delta against references the client
    // has just said are gone, which is undecodable, so it asks again and gets the same answer.
    //
    // The acknowledged reference is what makes this test able to fail. With nothing
    // acknowledged VideoToolbox answers every ForceLTRRefresh with an IDR anyway, and the bug
    // and the fix produce byte-identical output.
    func testClientHasNoReferencesSurvivesAnInterveningFrame() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config())
        defer { encoder.invalidate() }
        var acknowledged = false
        for index in 0..<24 {
            let envelope = try await encodeFrame(
                encoder, frameIndex: UInt64(index), frameId: UInt64(index + 1)
            )
            if let token = envelope.header.ltrToken {
                encoder.acknowledgeLtrTokens([token])
                acknowledged = true
                break
            }
        }
        try XCTSkipUnless(
            acknowledged,
            "this machine's HEVC encoder offered no long-term reference to acknowledge"
        )
        // The queued acknowledgement reaches the session on the next encode, not on the call.
        _ = try await encodeFrame(encoder, frameIndex: 30, frameId: 31)
        encoder.noteClientHasNoReferences()
        let intervening = try await encodeFrame(encoder, frameIndex: 31, frameId: 32)
        XCTAssertFalse(
            intervening.header.isKeyframe,
            "the flag records what the next KEYFRAME must be, and must not force one of its own"
        )
        let answer = try await encodeFrame(
            encoder, frameIndex: 32, frameId: 33,
            forceKeyframe: true, requestedKeyframeReason: .clientRequest
        )
        XCTAssertTrue(
            answer.header.isKeyframe,
            "a client with no references must be answered with a true keyframe, not an LTR refresh"
        )
    }
}
