import CryptoKit
import Foundation
import Testing
import AgentDeskWire
@testable import AgentDeskHost

struct ClientScreenshotRequesterTests {
    @Test func assemblerAcceptsStrictOrderedVerifiedScreenshot() throws {
        let jpeg = Data([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
        let hash = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        let manifest = ClientScreenshotManifest(
            requestId: "capture",
            capturedAt: 1,
            clientBuildSHA: "abc1234",
            surfaceName: "terminal",
            pixelWidth: 390,
            pixelHeight: 844,
            scale: 1,
            orientation: "portrait",
            mimeType: "image/jpeg",
            totalBytes: jpeg.count,
            sha256: hash,
            omittedLayers: ["system-keyboard"]
        )
        var assembler = ClientScreenshotAssembler(
            requestId: "capture",
            maxBytes: 100,
            maxPixelDimension: 1_000
        )
        try assembler.accept(manifest: manifest)
        let collected = try assembler.accept(chunk: ClientScreenshotChunk(
            requestId: "capture",
            sequence: 0,
            isFinal: true,
            payloadBase64: jpeg.base64EncodedString()
        ))
        #expect(collected == CollectedClientScreenshot(manifest: manifest, jpegData: jpeg))
    }

    @Test func assemblerRejectsSkippedChunkAndDigestMismatch() throws {
        let bytes = Data([1, 2, 3])
        let manifest = ClientScreenshotManifest(
            requestId: "capture",
            capturedAt: 1,
            clientBuildSHA: "abc1234",
            surfaceName: "control",
            pixelWidth: 10,
            pixelHeight: 10,
            scale: 1,
            orientation: "portrait",
            mimeType: "image/jpeg",
            totalBytes: bytes.count,
            sha256: String(repeating: "0", count: 64),
            omittedLayers: []
        )
        var skipped = ClientScreenshotAssembler(requestId: "capture", maxBytes: 100, maxPixelDimension: 100)
        try skipped.accept(manifest: manifest)
        #expect(throws: ClientScreenshotRequesterError.self) {
            try skipped.accept(chunk: ClientScreenshotChunk(
                requestId: "capture",
                sequence: 1,
                isFinal: true,
                payloadBase64: bytes.base64EncodedString()
            ))
        }

        var mismatched = ClientScreenshotAssembler(requestId: "capture", maxBytes: 100, maxPixelDimension: 100)
        try mismatched.accept(manifest: manifest)
        #expect(throws: ClientScreenshotRequesterError.self) {
            try mismatched.accept(chunk: ClientScreenshotChunk(
                requestId: "capture",
                sequence: 0,
                isFinal: true,
                payloadBase64: bytes.base64EncodedString()
            ))
        }
    }

    @Test func assemblerRejectsOversizedChunkAndInvalidManifestMetadata() throws {
        var oversized = ClientScreenshotAssembler(
            requestId: "capture",
            maxBytes: Config.screenshotMaxBytes,
            maxPixelDimension: Config.screenshotMaxPixelDimension
        )
        let bytes = Data(repeating: 1, count: Config.screenshotChunkBytes + 1)
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let manifest = ClientScreenshotManifest(
            requestId: "capture",
            capturedAt: 1,
            clientBuildSHA: "abc1234",
            surfaceName: "terminal",
            pixelWidth: 10,
            pixelHeight: 10,
            scale: 1,
            orientation: "portrait",
            mimeType: "image/jpeg",
            totalBytes: bytes.count,
            sha256: digest,
            omittedLayers: []
        )
        try oversized.accept(manifest: manifest)
        #expect(throws: ClientScreenshotRequesterError.self) {
            try oversized.accept(chunk: ClientScreenshotChunk(
                requestId: "capture",
                sequence: 0,
                isFinal: true,
                payloadBase64: bytes.base64EncodedString()
            ))
        }

        var invalid = ClientScreenshotAssembler(requestId: "capture", maxBytes: 100, maxPixelDimension: 100)
        #expect(throws: ClientScreenshotRequesterError.self) {
            try invalid.accept(manifest: ClientScreenshotManifest(
                requestId: "capture",
                capturedAt: 1,
                clientBuildSHA: "abc",
                surfaceName: "terminal",
                pixelWidth: 10,
                pixelHeight: 10,
                scale: 1,
                orientation: "sideways",
                mimeType: "image/jpeg",
                totalBytes: 1,
                sha256: String(repeating: "z", count: 64),
                omittedLayers: []
            ))
        }
    }
}
