import CoreMedia
import XCTest
@testable import AgentDeskClient

// Phase 3 of the mixed-mode renderer (ADR-0025): the decode-by-display state
// machine. A real HEVC format description needs real parameter sets, so these
// inject a stub description to exercise the enqueue and drop paths, and test the
// real parameter-set factory's failure mode directly.
final class OwnedMediaVideoDecoderTests: XCTestCase {
    private final class SpyEnqueuer: OwnedMediaVideoEnqueuing {
        var enqueued: [CMSampleBuffer] = []
        var flushCount = 0
        var flushAndRemoveImageCount = 0
        var displayStatus = "rendering"
        var requiresFlushToResumeDecoding = false
        func enqueue(_ sampleBuffer: CMSampleBuffer) { enqueued.append(sampleBuffer) }
        func flush() { flushCount += 1 }
        func flushAndRemoveImage() { flushAndRemoveImageCount += 1 }
    }

    private func stubFormatDescription() -> CMVideoFormatDescription {
        var description: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreate(
            allocator: kCFAllocatorDefault,
            codecType: kCMVideoCodecType_HEVC,
            width: 256, height: 256,
            extensions: nil,
            formatDescriptionOut: &description
        )
        return description!
    }

    private func envelope(
        frameId: UInt64,
        keyframe: Bool,
        hasParameterSets: Bool,
        width: Int = 256,
        height: Int = 256,
        payload: Data = Data([1, 2, 3, 4])
    ) -> OwnedMediaFrameEnvelope {
        let parameterSets = hasParameterSets
            ? OwnedMediaParameterSets(vps: Data([1]), sps: Data([2]), pps: Data([3]))
            : nil
        let header = OwnedMediaFrameHeader(
            surfaceGeneration: 1, frameId: frameId, codec: .hevc, width: width, height: height,
            capturedAtUptimeNs: 0, presentationTimeNs: frameId * 1_000,
            isKeyframe: keyframe, parameterSets: parameterSets,
            refreshReason: keyframe ? .initial : .rest
        )
        return OwnedMediaFrameEnvelope(header: header, payload: payload)
    }

    private func makeDecoder(_ spy: SpyEnqueuer) -> OwnedMediaVideoDecoder {
        OwnedMediaVideoDecoder(layer: spy, makeFormatDescription: { _, _ in self.stubFormatDescription() })
    }

    func testDeltaBeforeKeyframeIsDropped() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        let result = decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: false, hasParameterSets: false))
        XCTAssertEqual(result, .droppedPendingKeyframe)
        XCTAssertTrue(spy.enqueued.isEmpty)
    }

    func testKeyframeThenDeltaBothEnqueue() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: true)), .enqueued)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 2, keyframe: false, hasParameterSets: false)), .enqueued)
        XCTAssertEqual(spy.enqueued.count, 2)
        XCTAssertEqual(spy.flushCount, 1, "the keyframe flushes the queue before enqueuing the fresh sync point")
    }

    func testKeyframeAtNewDimensionsResyncsDecoder() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: true)), .enqueued)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 2, keyframe: true, hasParameterSets: true, width: 128, height: 128)), .enqueued)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 3, keyframe: false, hasParameterSets: false, width: 128, height: 128)), .enqueued)
        XCTAssertEqual(spy.enqueued.count, 3)
        XCTAssertEqual(spy.flushCount, 2, "each keyframe sync point flushes pending queued frames")
    }

    func testDeltaAtUnexpectedDimensionsRequestsKeyframe() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: true)), .enqueued)
        let result = decoder.decodeAndEnqueue(envelope(frameId: 2, keyframe: false, hasParameterSets: false, width: 128, height: 128))
        XCTAssertEqual(result, .droppedMismatchedDimensionsRequestKeyframe)
        XCTAssertEqual(spy.enqueued.count, 1)
        XCTAssertEqual(spy.flushCount, 2, "mismatched delta flushes pending buffers and waits for a keyframe")
    }

    func testKeyframeWithoutParameterSetsIsUnavailable() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        let result = decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: false))
        XCTAssertEqual(result, .formatDescriptionUnavailable)
        XCTAssertTrue(spy.enqueued.isEmpty)
    }

    func testResetForcesNextFrameToBeAKeyframe() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: true)), .enqueued)
        decoder.reset()
        let result = decoder.decodeAndEnqueue(envelope(frameId: 2, keyframe: false, hasParameterSets: false))
        XCTAssertEqual(result, .droppedPendingKeyframe, "after reset a delta has no format description")
    }

    // ADR-0027 R84: a wedged layer (failed status) on a delta is reset and the caller
    // is told to request a keyframe. flushAndRemoveImage clears the failed state;
    // flush() (which keeps the failed image) is not used here.
    func testWedgedLayerOnDeltaRecoversAndRequestsKeyframe() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: true)), .enqueued)
        spy.displayStatus = "failed"
        let recovered = decoder.decodeAndEnqueue(envelope(frameId: 2, keyframe: false, hasParameterSets: false))
        XCTAssertEqual(recovered, .recoveredRequestKeyframe)
        XCTAssertEqual(spy.flushAndRemoveImageCount, 1, "the failed layer is blanked, not flush()-kept")
        XCTAssertEqual(spy.enqueued.count, 1, "the delta is not enqueued onto a wedged layer")
        // After recovery the format description is gone, so a delta keeps dropping
        // until a keyframe resyncs.
        spy.displayStatus = "rendering"
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 3, keyframe: false, hasParameterSets: false)), .droppedPendingKeyframe)
        XCTAssertEqual(decoder.decodeAndEnqueue(envelope(frameId: 4, keyframe: true, hasParameterSets: true)), .enqueued)
    }

    // A wedged layer when the incoming frame is itself a keyframe resyncs in place:
    // blank once, then enqueue the keyframe. The keyframe-path flush() is skipped
    // because the recovery already blanked the layer.
    func testWedgedLayerOnKeyframeResyncsInPlace() {
        let spy = SpyEnqueuer()
        let decoder = makeDecoder(spy)
        spy.requiresFlushToResumeDecoding = true
        let result = decoder.decodeAndEnqueue(envelope(frameId: 1, keyframe: true, hasParameterSets: true))
        XCTAssertEqual(result, .enqueued)
        XCTAssertEqual(spy.flushAndRemoveImageCount, 1)
        XCTAssertEqual(spy.flushCount, 0, "no flush() on top of the recovery blank")
        XCTAssertEqual(spy.enqueued.count, 1)
    }

    // ADR-0027 R85: the render-stall watchdog, against an injected clock.
    private func watchdog() -> OwnedMediaRenderStallWatchdog {
        OwnedMediaRenderStallWatchdog(
            activeWindowNs: 1_000_000_000,
            stallThresholdNs: 1_000_000_000,
            minRequestIntervalNs: 1_000_000_000
        )
    }

    func testWatchdogFiresWhenArrivingButNotEnqueuing() {
        let now: UInt64 = 10_000_000_000
        XCTAssertTrue(watchdog().shouldRequestKeyframe(
            lastArrivalNs: now - 100_000_000,   // 0.1s ago: host is sending
            lastEnqueueNs: now - 2_000_000_000, // 2s ago: nothing presented
            lastRequestNs: nil,
            nowNs: now
        ))
    }

    func testWatchdogQuietHostDoesNotFire() {
        let now: UInt64 = 10_000_000_000
        XCTAssertFalse(watchdog().shouldRequestKeyframe(
            lastArrivalNs: now - 2_000_000_000, // 2s ago: no recent arrival
            lastEnqueueNs: now - 5_000_000_000,
            lastRequestNs: nil,
            nowNs: now
        ), "a quiet host (rest or dead link) must not trigger a keyframe storm")
    }

    func testWatchdogRespectsRateLimit() {
        let now: UInt64 = 10_000_000_000
        XCTAssertFalse(watchdog().shouldRequestKeyframe(
            lastArrivalNs: now - 100_000_000,
            lastEnqueueNs: now - 2_000_000_000,
            lastRequestNs: now - 500_000_000,   // 0.5s ago: within the 1s interval
            nowNs: now
        ))
    }

    func testWatchdogRequiresAPriorEnqueue() {
        let now: UInt64 = 10_000_000_000
        XCTAssertFalse(watchdog().shouldRequestKeyframe(
            lastArrivalNs: now - 100_000_000,
            lastEnqueueNs: nil,                 // never presented: startup, covered elsewhere
            lastRequestNs: nil,
            nowNs: now
        ))
    }

    func testRealFactoryRejectsEmptyParameterSets() {
        let parameterSets = OwnedMediaParameterSets(vps: Data(), sps: Data(), pps: Data())
        XCTAssertNil(
            OwnedMediaVideoDecoder.formatDescription(parameterSets, codec: .hevc),
            "empty parameter sets cannot form a valid HEVC format description"
        )
    }
}
