import CoreVideo
import Compression
import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollQualityTests {
    @Test func ownedMediaCeilingConfigParsesStrictChroma() {
        #expect(Config.OwnedMediaChroma(rawEnvironmentValue: "444") == .yuv444)
        #expect(Config.OwnedMediaChroma(rawEnvironmentValue: "bgra") == .bgra)
        #expect(Config.OwnedMediaChroma(rawEnvironmentValue: "unknown") == .yuv420)
    }

    @Test func hybridGraphicsConfigDefaults() {
        #expect(Config.hybridResetStripeMaxDecodedBytes == 2 * 1_024 * 1_024)
        #expect(Config.hybridResetStripeMaxWireBytes == 196_608)
        #expect(Config.hybridResetStripeAckTimeoutMs == 1_000)
        #expect(Config.hybridGraphicsFallbackMinIntervalMs == 1_500)
    }

    @Test func ownedMediaDiagnosticsFpsWindowCountsOneSecondSamples() {
        var window = OwnedMediaDiagnosticsFpsWindow(windowStartedAtUptimeNs: 1_000_000_000)
        window.incrementCaptured()
        window.incrementCaptured()
        window.incrementAdmitted()
        window.incrementEncoded()
        window.incrementSent()
        window.incrementAcked()

        let early = window.flushIfDue(nowUptimeNs: 1_999_000_000)
        let sample = window.flushIfDue(nowUptimeNs: 2_000_000_000)

        #expect(early == nil)
        #expect(sample?.captured == 2)
        #expect(sample?.admitted == 1)
        #expect(sample?.encoded == 1)
        #expect(sample?.sent == 1)
        #expect(sample?.acked == 1)
        #expect(sample?.fps(2) == 2)
    }

    @Test func ownedCaptureSizingSupportsConfiguredScaleDown() {
        let size = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: 2.0
        )

        #expect(size.width == 1800)
        #expect(size.height == 1168)
        #expect(size.width.isMultiple(of: 2))
        #expect(size.height.isMultiple(of: 2))
    }

    @Test func ownedCaptureSizingSupportsQualityResolutionScales() {
        let native = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: CaptureSizing.scaleDownBy(baseScaleDownBy: 1.0, resolutionScale: 1.0)
        )
        let capacity1 = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: CaptureSizing.scaleDownBy(baseScaleDownBy: 1.0, resolutionScale: 0.75)
        )
        let capacity2 = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: CaptureSizing.scaleDownBy(baseScaleDownBy: 1.0, resolutionScale: 0.5)
        )
        let emergency = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: CaptureSizing.scaleDownBy(baseScaleDownBy: 1.0, resolutionScale: 0.33)
        )

        #expect(native.width == 3600)
        #expect(native.height == 2338)
        #expect(capacity1.width == 2700)
        #expect(capacity1.height == 1752)
        #expect(capacity2.width == 1800)
        #expect(capacity2.height == 1168)
        #expect(emergency.width == 1188)
        #expect(emergency.height == 770)
        #expect([native, capacity1, capacity2, emergency].allSatisfy { $0.width.isMultiple(of: 2) && $0.height.isMultiple(of: 2) })
    }

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

    @Test func ownedGraphicsAckWaiterCompletesWhenAckCoversUpdate() async {
        let waiter = OwnedGraphicsAckWaiter()
        let task = Task {
            await waiter.wait(
                for: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
                timeoutMs: 1_000
            )
        }

        waiter.noteAck(OwnedGraphicsFrameAck(
            surfaceGeneration: 1,
            frameId: 11,
            compositorMs: 1,
            totalGraphicsFramesApplied: 11,
            staleDiscardCount: 0
        ))

        #expect(await task.value)
    }

    @Test func ownedGraphicsAckWaiterCompletesWhenNewerGenerationCoversUpdate() async {
        let waiter = OwnedGraphicsAckWaiter()
        let task = Task {
            await waiter.wait(
                for: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 200),
                timeoutMs: 1_000
            )
        }

        waiter.noteAck(OwnedGraphicsFrameAck(
            surfaceGeneration: 2,
            frameId: 1,
            compositorMs: 1,
            totalGraphicsFramesApplied: 12,
            staleDiscardCount: 0
        ))

        #expect(await task.value)
    }

    @Test func ownedGraphicsAckWaiterDoesNotCompleteForOlderAck() async {
        let waiter = OwnedGraphicsAckWaiter()
        let task = Task {
            await waiter.wait(
                for: OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 1),
                timeoutMs: 5
            )
        }

        waiter.noteAck(OwnedGraphicsFrameAck(
            surfaceGeneration: 1,
            frameId: 999,
            compositorMs: 1,
            totalGraphicsFramesApplied: 11,
            staleDiscardCount: 0
        ))

        #expect(!(await task.value))
    }

    @Test func ownedGraphicsAckWaiterTimesOutWithoutMutatingAuthState() async {
        let waiter = OwnedGraphicsAckWaiter()

        let acked = await waiter.wait(
            for: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
            timeoutMs: 1
        )

        #expect(!acked)
    }

    @Test func graphicsStreamParserWaitsForPartialFrameAndParsesMultipleFrames() throws {
        let first = try Self.makeGraphicsEnvelope(frameId: 1).encode()
        let secondEnvelope = Self.makeGraphicsEnvelope(frameId: 2)
        let second = try secondEnvelope.encode()
        var parser = OwnedGraphicsStreamFrameParser()

        #expect(try parser.append(Data(first.prefix(5))).isEmpty)
        let completed = try parser.append(Data(first.dropFirst(5)))
        #expect(completed.map(\.header.frameId) == [1])

        let combined = try parser.append(second + second)
        #expect(combined == [secondEnvelope, secondEnvelope])
    }

    @Test func graphicsStreamParserAcceptsNearLimitFrameWithCoalescedNextFrame() throws {
        let secondEnvelope = Self.makeGraphicsEnvelope(frameId: 2)
        let second = try secondEnvelope.encode()
        let first = try Self.makeNearMaximumGraphicsFrame(frameId: 1, followingFrameByteCount: second.count)
        #expect(first.count <= OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        #expect(first.count + second.count > OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        var parser = OwnedGraphicsStreamFrameParser()

        let frames = try parser.append(first + second)

        #expect(frames.map(\.header.frameId) == [1, 2])
    }

    @Test func graphicsStreamParserRejectsMalformedMagic() throws {
        var parser = OwnedGraphicsStreamFrameParser()

        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try parser.append(Data([0x42, 0x41, 0x44, 0x21, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
        }
    }

    @Test func scrollDeltaEngineFullResetEmitsGenerationFrameAndDecodedCappedStripeFrames() throws {
        let decodedStripeCap = 64 * 16 * 4
        var engine = ScrollDeltaEngine(maxDecodedResetStripePayloadBytes: decodedStripeCap)
        let frame = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }

        let result = engine.evaluate(frame)

        #expect(result.kind == ScrollDeltaKind.reset)
        let frames = result.envelopes
        #expect(frames.count == 4)
        let firstStripe = try #require(frames.first)
        #expect(result.envelope == firstStripe)
        #expect(firstStripe.header.surfaceGeneration == 1)
        #expect(firstStripe.header.frameId == 1)
        #expect(firstStripe.header.commandCount == 2)
        #expect(firstStripe.header.payloadLength == firstStripe.payload.count)
        #expect(firstStripe.commands.count == 2)
        #expect(firstStripe.commands[0] ==
            OwnedGraphicsCommand.resetSurface(
                surfaceGeneration: 1,
                width: 64,
                height: 64,
                pixelFormat: .bgra
            )
        )

        for (stripeIndex, stripe) in frames.enumerated() {
            let y = stripeIndex * 16
            #expect(stripe.header.surfaceGeneration == 1)
            #expect(stripe.header.frameId == UInt64(stripeIndex + 1))
            #expect(stripe.header.payloadLength == stripe.payload.count)
            let tileCommandIndex = stripeIndex == 0 ? 1 : 0
            guard case let .bitmapTile(x, tileY, width, height, compression, byteRange) = stripe.commands[tileCommandIndex] else {
                Issue.record("expected reset stripe bitmapTile, got \(stripe.commands[tileCommandIndex])")
                continue
            }
            #expect(x == 0)
            #expect(tileY == y)
            #expect(width == 64)
            #expect(height == 16)
            #expect(compression == .lzfse)
            #expect(byteRange.offset == 0)
            #expect(byteRange.length == stripe.payload.count)
            let decoded = try Self.decompressLZFSE(stripe.payload, expectedCount: 64 * 16 * 4)
            #expect(decoded.count <= decodedStripeCap)
            #expect(decoded == Self.tileBytes(width: 64, height: 16) { x, row in
                Self.pixel(x: x, y: y + row)
            })
        }
    }

    @Test func scrollDeltaEngineResetStripesRespectDecodedAndWireCaps() throws {
        let decodedStripeCap = 512 * 32 * 4
        let wireStripeCap = 16_384
        var engine = ScrollDeltaEngine(
            maxDecodedResetStripePayloadBytes: decodedStripeCap,
            maxWireResetStripeBytes: wireStripeCap
        )
        let frame = try Self.makeBGRAFrame(width: 512, height: 128) { x, y in
            [
                UInt8((x * 31 + y * 17) & 0xff),
                UInt8((x * 19 + y * 47 + x / 3) & 0xff),
                UInt8((x * 53 + y * 29 + y / 5) & 0xff),
                0xff
            ]
        }

        let result = engine.evaluate(frame)

        #expect(result.kind == ScrollDeltaKind.reset)
        #expect(result.envelopes.count > 4)
        for stripe in result.envelopes {
            #expect(stripe.wireByteCount <= wireStripeCap)
            guard let tile = stripe.commands.compactMap(Self.bitmapTileCommand).first else {
                Issue.record("expected reset stripe bitmapTile")
                continue
            }
            #expect(tile.width == 512)
            #expect(tile.height * tile.width * 4 <= decodedStripeCap)
        }
    }

    // Non-linear per-row hash so a vertical shift is unambiguously detectable.
    private static func damageRowHash(_ y: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: y &+ 1)
        h = h &* 2_654_435_761
        h ^= (h >> 15)
        h = h &* 2_246_822_519
        h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    @Test func damageDrivenScrollEmitsTilesNotCopyRect() throws {
        // ADR-0022: a declared scroll no longer reconstructs an offset or emits a
        // copyRect. The damage band routes through the tile ladder (here a
        // full-surface band, so the fullFrame coverage path tiles it).
        var engine = ScrollDeltaEngine()
        let width = 240
        let height = 200
        let dy = 24
        let previous = try Self.makeBGRAFrame(width: width, height: height) { _, y in
            let v = Self.damageRowHash(y); return [v, v, v, 0xff]
        }
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        let current = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [band],
            contentRectPixels: band
        ) { _, y in
            let v = Self.damageRowHash(y - dy); return [v, v, v, 0xff]
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, motion: MotionSignal(axis: .vertical, sign: 1))

        #expect(result.kind == ScrollDeltaKind.accepted)
        let envelope = try #require(result.envelope)
        let hasTile = envelope.commands.contains {
            switch $0 { case .bitmapTile, .cacheTile, .drawCachedTile: return true; default: return false }
        }
        #expect(hasTile)
    }

    @Test func damageDrivenSmallDamageEmitsTileWithoutCopyRect() throws {
        var engine = ScrollDeltaEngine()
        let width = 240
        let height = 200
        let frame0 = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            Self.scrollProbePixel(x: x, y: y)
        }
        #expect(engine.evaluate(frame0).kind == .reset)
        engine.commitPendingSurface()
        // frame1 carries the same damage rect but with different pixels in the
        // damaged region so the retained-baseline compare does not absorb the change.
        let damage = PixelRect(x: 10, y: 10, width: 40, height: 40)
        let frame1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage],
            contentRectPixels: PixelRect(x: 0, y: 0, width: width, height: height)
        ) { x, y in
            if x >= 10 && x < 50 && y >= 10 && y < 50 {
                // Invert the probe value so the damaged cell is detectably different.
                let base = Self.scrollProbePixel(x: x, y: y)
                return [~base[0], ~base[1], ~base[2], 0xff]
            }
            return Self.scrollProbePixel(x: x, y: y)
        }
        let result = engine.evaluate(frame1)

        #expect(result.kind == ScrollDeltaKind.accepted)
        let envelope = try #require(result.envelope)
        // A tile that carries pixels is bitmapTile (cache disabled) or cacheTile
        // (cache enabled, first appearance). Either satisfies the contract: pixels
        // reach the client as tiles (ADR-0022 has no copyRect).
        let hasTile = envelope.commands.contains {
            switch $0 { case .bitmapTile, .cacheTile: return true; default: return false }
        }
        #expect(hasTile)
    }

    @Test func damageDrivenLargeDamageWithoutHintEmitsTiles() throws {
        // H1: large unstructured change no longer falls back to HEVC. The
        // classifier returns .fullFrame and the engine routes it to a tile
        // envelope over the reliable graphics channel.
        var engine = ScrollDeltaEngine()
        let width = 240
        let height = 200
        let frame0 = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            Self.scrollProbePixel(x: x, y: y)
        }
        #expect(engine.evaluate(frame0).kind == .reset)
        engine.commitPendingSurface()
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let frame1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            Self.pixel(x: x, y: y)
        }
        let result = engine.evaluate(frame1)

        #expect(result.kind == ScrollDeltaKind.accepted)
        let envelope = try #require(result.envelope)
        // Task 2: a fullframe-classified change now tiles the whole surface through
        // the cache ladder, so it emits cache tiles (cacheTile / drawCachedTile),
        // not a single whole-frame bitmapTile.
        let hasTile = envelope.commands.contains {
            switch $0 {
            case .bitmapTile, .cacheTile, .drawCachedTile: return true
            default: return false
            }
        }
        #expect(hasTile)
    }

    @Test func scrollDeltaEngineResetsOnResizeAndReservesHevcIdsInSameGeneration() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let resized = try Self.makeBGRAFrame(width: 32, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }

        let first = engine.evaluate(previous)
        engine.commitPendingSurface()
        let refreshId = engine.reserveRefreshUpdateId()
        let reset = engine.evaluate(resized)

        #expect(first.kind == ScrollDeltaKind.reset)
        #expect(refreshId.surfaceGeneration == 1)
        #expect(reset.kind == ScrollDeltaKind.reset)
        #expect(reset.envelope?.header.surfaceGeneration == 2)
        #expect(engine.reserveRefreshUpdateId().surfaceGeneration == 2)
    }

    private static func makeGraphicsEnvelope(frameId: UInt64) -> OwnedGraphicsFrameEnvelope {
        let payload = Data([0x10, 0x20, 0x30])
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: payload.count
            ),
            commands: [
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )
    }

    private static func makeNearMaximumGraphicsFrame(frameId: UInt64, followingFrameByteCount: Int) throws -> Data {
        var payloadCount = OwnedGraphicsStreamFrameParser.maxFrameByteCount
            - OwnedGraphicsFrameEnvelope.fixedHeaderByteCount
        while payloadCount > 0 {
            let payload = Data(repeating: 0x5a, count: payloadCount)
            let envelope = OwnedGraphicsFrameEnvelope(
                header: OwnedGraphicsFrameHeader(
                    surfaceGeneration: 1,
                    frameId: frameId,
                    capturedAtUptimeNs: frameId * 100,
                    commandCount: 1,
                    payloadLength: payload.count
                ),
                commands: [
                    .bitmapTile(
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        compression: .lzfse,
                        byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                    )
                ],
                payload: payload
            )
            let encoded = try envelope.encode()
            if encoded.count <= OwnedGraphicsStreamFrameParser.maxFrameByteCount {
                guard encoded.count + followingFrameByteCount > OwnedGraphicsStreamFrameParser.maxFrameByteCount else {
                    throw SessionRejected(reason: .malformed)
                }
                return encoded
            }
            payloadCount -= max(1, encoded.count - OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        }
        throw SessionRejected(reason: .malformed)
    }

    private static func makeBGRAFrame(
        width: Int,
        height: Int,
        damageRects: [PixelRect] = [],
        contentRectPixels: PixelRect? = nil,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
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
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            for x in 0..<width {
                let bytes = pixel(x, y)
                let offset = y * bytesPerRow + x * 4
                baseAddress.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0,
            damageRects: damageRects,
            contentRectPixels: contentRectPixels
        )
    }

    private static func make420Frame(
        width: Int,
        height: Int,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
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
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
              let uvBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else {
            throw SessionRejected(reason: .malformed)
        }
        let yBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let uvBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        let uvHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)
        let uvWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 1)
        for y in 0..<height {
            for x in 0..<width {
                yBase.storeBytes(
                    of: luma(pixel(x, y)),
                    toByteOffset: y * yBytesPerRow + x,
                    as: UInt8.self
                )
            }
        }
        for y in 0..<uvHeight {
            for x in 0..<uvWidth {
                let offset = y * uvBytesPerRow + x * 2
                uvBase.storeBytes(of: UInt8(128), toByteOffset: offset, as: UInt8.self)
                uvBase.storeBytes(of: UInt8(128), toByteOffset: offset + 1, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0
        )
    }

    private static func pixel(x: Int, y: Int) -> [UInt8] {
        [
            UInt8((x * 3 + y * 5) & 0xff),
            UInt8((x * 7 + y * 11) & 0xff),
            UInt8((x * 13 + y * 17) & 0xff),
            0xff
        ]
    }

    private static func scrollProbePixel(x: Int, y: Int) -> [UInt8] {
        let value = UInt8((x * 37 + y * 101 + (x / 23) * 19 + (y / 17) * 53) & 0xff)
        return [value, value, value, 0xff]
    }

    private static func xOnlyPixel(x: Int) -> [UInt8] {
        let value = UInt8((x * 37 + (x / 7) * 23) & 0xff)
        return [value, value, value, 0xff]
    }

    private static func luma(_ bgra: [UInt8]) -> UInt8 {
        let blue = 29 * Int(bgra[0])
        let green = 150 * Int(bgra[1])
        let red = 77 * Int(bgra[2])
        return UInt8((blue + green + red) >> 8)
    }

    private static func exposedPixel(x: Int, y: Int) -> [UInt8] {
        [
            UInt8((200 + x) & 0xff),
            UInt8((100 + y) & 0xff),
            UInt8((50 + x + y) & 0xff),
            0xff
        ]
    }

    private static func tileBytes(width: Int, height: Int, pixel: (Int, Int) -> [UInt8]) -> Data {
        var data = Data(count: width * height * 4)
        data.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let bytes = pixel(x, y)
                    let offset = (y * width + x) * 4
                    base.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                    base.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                    base.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                    base.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
                }
            }
        }
        return data
    }

    private static func bitmapTileCommand(_ command: OwnedGraphicsCommand) -> (
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        compression: OwnedGraphicsTileCompression,
        byteRange: OwnedGraphicsByteRange
    )? {
        guard case let .bitmapTile(x, y, width, height, compression, byteRange) = command else {
            return nil
        }
        return (x, y, width, height, compression, byteRange)
    }

    private static func decompressLZFSE(_ data: Data, expectedCount: Int) throws -> Data {
        var output = Data(count: expectedCount)
        let decodedCount = output.withUnsafeMutableBytes { outputBytes in
            data.withUnsafeBytes { inputBytes in
                compression_decode_buffer(
                    outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    expectedCount,
                    inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    data.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }
        guard decodedCount == expectedCount else {
            throw SessionRejected(reason: .malformed)
        }
        return output
    }

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
}
