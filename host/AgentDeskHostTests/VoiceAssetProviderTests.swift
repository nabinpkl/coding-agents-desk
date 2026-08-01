import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct VoiceAssetProviderTests {
    private func makeRoot() throws -> URL {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voice-assets-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func write(_ bytes: Data, to path: String, under root: URL) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try bytes.write(to: url)
    }

    @Test func manifestPublishesEveryFileWithAStableOrder() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        // Mirrors the real shape: a compiled Core ML model is a directory of
        // files, and its nested paths have to survive into the manifest.
        try write(Data("mil".utf8), to: "VoicePhoneModel.mlmodelc/model.mil", under: root)
        try write(Data("weights".utf8), to: "VoicePhoneModel.mlmodelc/weights/weight.bin", under: root)
        try write(Data("onnx".utf8), to: "VoiceZIPAModel.onnx", under: root)

        let manifest = try VoiceAssetProvider(root: root).manifest()

        #expect(manifest.assets.map(\.path) == [
            "VoicePhoneModel.mlmodelc/model.mil",
            "VoicePhoneModel.mlmodelc/weights/weight.bin",
            "VoiceZIPAModel.onnx",
        ])
        #expect(manifest.assets.first?.byteCount == 3)
        // SHA-256 of "onnx", so the phone can tell a current file from a stale one.
        #expect(manifest.assets.last?.sha256.count == 64)
    }

    @Test func aHostThatNeverGeneratedTheModelsOffersNothingRatherThanFailing() throws {
        let missing = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voice-assets-absent-\(UUID().uuidString)")

        let manifest = try VoiceAssetProvider(root: missing).manifest()

        #expect(manifest.assets.isEmpty)
    }

    @Test func readsReturnBoundedSlicesAndMarkTheFinalOne() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try write(Data(repeating: 0xab, count: 10), to: "VoiceZIPAModel.onnx", under: root)
        let provider = VoiceAssetProvider(root: root)

        let first = try provider.read(path: "VoiceZIPAModel.onnx", offset: 0, length: 4)
        #expect(first.bytes.count == 4)
        #expect(!first.isLast)

        // Resume from an offset is the point: a 152MB transfer that drops must
        // not start over.
        let resumed = try provider.read(path: "VoiceZIPAModel.onnx", offset: 4, length: 100)
        #expect(resumed.bytes.count == 6)
        #expect(resumed.isLast)
    }

    // The membership check is the security boundary. A path is answerable only
    // because walking the root produced it, so an escape cannot be spelled.
    @Test func refusesToServeAnythingOutsideItsRoot() throws {
        let root = try makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try write(Data("public".utf8), to: "VoiceZIPAModel.onnx", under: root)
        let secret = root.deletingLastPathComponent()
            .appendingPathComponent("voice-secret-\(UUID().uuidString).txt")
        try Data("private".utf8).write(to: secret)
        defer { try? FileManager.default.removeItem(at: secret) }
        let provider = VoiceAssetProvider(root: root)

        for escape in ["../\(secret.lastPathComponent)", "../../etc/passwd", secret.path] {
            #expect(throws: VoiceAssetProvider.ProviderError.self) {
                try provider.read(path: escape, offset: 0, length: 16)
            }
        }
        #expect(throws: VoiceAssetProvider.ProviderError.self) {
            try provider.read(path: "VoiceNotPublished.onnx", offset: 0, length: 16)
        }
    }
}
