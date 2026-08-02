import CryptoKit
import Foundation
import Testing
import AgentDeskWire

struct VoiceAssetCacheTests {
    private func makeCache() throws -> VoiceAssetCache {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("voice-cache-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return VoiceAssetCache(root: root)
    }

    private func descriptor(path: String, bytes: Data) -> VoiceAssetDescriptor {
        VoiceAssetDescriptor(
            path: path,
            byteCount: UInt64(bytes.count),
            sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        )
    }

    @Test func storesAFileAndReportsItPresent() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }
        let bytes = Data("model weights".utf8)
        // A nested path, because the compiled Core ML model is a directory and
        // its inner files have to land in the right place.
        let asset = descriptor(path: "VoicePhoneModel.mlmodelc/weights/weight.bin", bytes: bytes)

        #expect(!cache.isPresent(asset))
        try cache.store(bytes, for: asset)

        #expect(cache.isPresent(asset))
        let url = try #require(cache.url(for: asset.path))
        #expect(try Data(contentsOf: url) == bytes)
    }

    @Test func refusesBytesThatDoNotMatchTheDescriptor() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }
        let asset = descriptor(path: "VoiceZIPAModel.onnx", bytes: Data("real".utf8))

        #expect(throws: VoiceAssetCache.CacheError.hashMismatch(path: "VoiceZIPAModel.onnx")) {
            try cache.store(Data("truncated".utf8), for: asset)
        }
        // Nothing half-written is left behind to be mistaken for a cached file.
        #expect(!cache.isPresent(asset))
    }

    // The manifest arrives from the Mac and its paths decide where this writes,
    // so an escaping path must not resolve even though the peer is authenticated.
    @Test func refusesToResolveAPathOutsideTheCache() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }

        #expect(cache.url(for: "../escaped.bin") == nil)
        #expect(cache.url(for: "../../Library/Preferences/hijack.plist") == nil)
        #expect(cache.url(for: "") == nil)
        #expect(cache.url(for: "VoiceZIPAModel.onnx") != nil)
    }

    @Test func onlyMissingOrResizedAssetsAreRefetched() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }
        let present = descriptor(path: "VoiceZIPAModel.onnx", bytes: Data("onnx".utf8))
        let absent = descriptor(path: "VoiceCMUDictionary.txt", bytes: Data("dict".utf8))
        try cache.store(Data("onnx".utf8), for: present)
        let manifest = VoiceAssetManifest(assets: [present, absent])

        #expect(cache.missingAssets(from: manifest).map(\.path) == ["VoiceCMUDictionary.txt"])
        #expect(!cache.isComplete(for: manifest))

        try cache.store(Data("dict".utf8), for: absent)
        #expect(cache.isComplete(for: manifest))
    }

    @Test func aFileThatChangedSizeOnTheMacIsFetchedAgain() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }
        let old = descriptor(path: "VoiceZIPAModel.onnx", bytes: Data("v1".utf8))
        try cache.store(Data("v1".utf8), for: old)
        let regenerated = descriptor(path: "VoiceZIPAModel.onnx", bytes: Data("v2-longer".utf8))

        #expect(!cache.isPresent(regenerated))
        #expect(cache.missingAssets(from: VoiceAssetManifest(assets: [regenerated])).count == 1)
    }

    // An empty manifest means the Mac has no models, which is not the same as
    // the phone having them all.
    @Test func anEmptyManifestIsNotCompleteness() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }

        #expect(!cache.isComplete(for: VoiceAssetManifest(assets: [])))
    }
}
