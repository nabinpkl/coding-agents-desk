import Foundation
import Testing
import AgentDeskWire
@testable import AgentDeskClient

@MainActor
struct ClientScreenshotCapturerTests {
    @Test func chunksAreBoundedOrderedAndExactlyReconstructPayload() throws {
        let source = Data((0..<255).map(UInt8.init)) + Data((0..<255).map(UInt8.init))
        let chunks = ClientScreenshotCapturer.makeChunks(
            data: source,
            requestId: "capture",
            chunkBytes: 128
        )

        #expect(chunks.count == 4)
        #expect(chunks.map(\.sequence) == [0, 1, 2, 3])
        #expect(chunks.dropLast().allSatisfy { !$0.isFinal })
        #expect(chunks.last?.isFinal == true)
        let reconstructed = chunks.reduce(into: Data()) { result, chunk in
            result.append(Data(base64Encoded: chunk.payloadBase64)!)
        }
        #expect(reconstructed == source)
    }

    @Test func renderScalePreservesNativeScaleUntilLongEdgeLimit() {
        let constrainedScale = ClientScreenshotCapturer.renderScale(
            bounds: CGRect(x: 0, y: 0, width: 390, height: 844),
            screenScale: 3,
            maxPixelDimension: 2_048
        )
        #expect(abs(constrainedScale - (2_048.0 / 844.0)) < 1e-12)
        #expect(ClientScreenshotCapturer.renderScale(
            bounds: CGRect(x: 0, y: 0, width: 390, height: 844),
            screenScale: 2,
            maxPixelDimension: 2_048
        ) == 2)
        #expect(ClientScreenshotCapturer.renderScale(
            bounds: .zero,
            screenScale: 3,
            maxPixelDimension: 2_048
        ) == 0)
    }

    @Test func fallbackChunksFitOfferPortFrameLimit() throws {
        let source = Data(repeating: 0xA5, count: 128 * 1_024)
        let chunks = ClientScreenshotCapturer.makeChunks(
            data: source,
            requestId: UUID().uuidString.lowercased(),
            chunkBytes: Config.screenshotOfferPortChunkBytes
        )

        #expect(chunks.count == 4)
        for chunk in chunks {
            let body = try JSONEncoder().encode(chunk)
            #expect(body.count <= OfferPortFrame.maxPayloadByteCount)
            let framed = try OfferPortFrame.encode(body)
            #expect(framed.count == body.count + OfferPortFrame.fixedHeaderByteCount)
        }
    }
}
