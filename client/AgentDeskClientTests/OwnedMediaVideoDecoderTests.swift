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
        func enqueue(_ sampleBuffer: CMSampleBuffer) { enqueued.append(sampleBuffer) }
        func flush() { flushCount += 1 }
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
        frameId: UInt64, keyframe: Bool, hasParameterSets: Bool, payload: Data = Data([1, 2, 3, 4])
    ) -> OwnedMediaFrameEnvelope {
        let parameterSets = hasParameterSets
            ? OwnedMediaParameterSets(vps: Data([1]), sps: Data([2]), pps: Data([3]))
            : nil
        let header = OwnedMediaFrameHeader(
            surfaceGeneration: 1, frameId: frameId, codec: .hevc, width: 256, height: 256,
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

    func testRealFactoryRejectsEmptyParameterSets() {
        let parameterSets = OwnedMediaParameterSets(vps: Data(), sps: Data(), pps: Data())
        XCTAssertNil(
            OwnedMediaVideoDecoder.formatDescription(parameterSets, codec: .hevc),
            "empty parameter sets cannot form a valid HEVC format description"
        )
    }
}
