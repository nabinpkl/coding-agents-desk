import CoreVideo
import XCTest
@testable import AgentDeskHost

// Phase 1 of the mixed-mode renderer (ADR-0025): the host HEVC encoder produces a
// keyframe-then-delta envelope sequence, force-keyframes on demand, and stamps the
// wire refresh reason. The bytes are dropped here; the datagram carrier (Phase 2)
// is what sends them. These tests run hardware HEVC on the Mac test host.
final class VideoToolboxOwnedMediaEncoderTests: XCTestCase {
    private func makeFrame(frameIndex: UInt64, width: Int = 256, height: Int = 256) -> CapturedVideoFrame {
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
            presentationTimeNs: Int64(frameIndex) * 33_333_333,
            capturedAtUptimeNs: DispatchTime.now().uptimeNanoseconds,
            rotation: ._0
        )
    }

    private func config(keyframeInterval: Int) -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(targetBitrateKbps: 2000, expectedFrameRate: 30, keyframeIntervalFrames: keyframeInterval)
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
        requestedKeyframeReason: OwnedMediaKeyframeReason? = nil
    ) async throws -> OwnedMediaFrameEnvelope {
        let envelope = await encoder.encode(
            makeFrame(frameIndex: frameIndex),
            updateId: updateId(frameId),
            forceKeyframe: forceKeyframe,
            requestedKeyframeReason: requestedKeyframeReason
        )
        return try XCTUnwrap(envelope, "encoder produced no frame for frameId \(frameId)")
    }

    func testFirstFrameIsKeyframeWithParameterSets() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
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
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        let envelope = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let decoded = try OwnedMediaFrameEnvelope.decode(envelope.encode())
        XCTAssertEqual(decoded.header, envelope.header)
        XCTAssertEqual(decoded.payload, envelope.payload)
    }

    func testSecondFrameIsDelta() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
        defer { encoder.invalidate() }
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        let second = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        XCTAssertFalse(second.header.isKeyframe, "second frame should be inter-predicted")
        XCTAssertNil(second.header.parameterSets, "delta frames carry no parameter sets")
        XCTAssertEqual(second.header.refreshReason, .rest)
    }

    func testPeriodicKeyframeFiresAtInterval() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 2))
        defer { encoder.invalidate() }
        // Frame 1 forced (first), frame 2 periodic (multiple of 2), frame 3 delta,
        // frame 4 periodic. Assert the cadence on frames 3 and 4.
        _ = try await encodeFrame(encoder, frameIndex: 0, frameId: 1)
        _ = try await encodeFrame(encoder, frameIndex: 1, frameId: 2)
        let third = try await encodeFrame(encoder, frameIndex: 2, frameId: 3)
        let fourth = try await encodeFrame(encoder, frameIndex: 3, frameId: 4)
        XCTAssertFalse(third.header.isKeyframe, "frame 3 is not on the keyframe interval")
        XCTAssertTrue(fourth.header.isKeyframe, "frame 4 is a periodic keyframe")
    }

    func testRequestKeyframeForcesTheNextFrame() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
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
            keyframeIntervalFrames: 30,
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

    func testClientRequestKeyframeMarksReset() async throws {
        let encoder = VideoToolboxOwnedMediaEncoder(codec: .hevc, configuration: config(keyframeInterval: 120))
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
}
