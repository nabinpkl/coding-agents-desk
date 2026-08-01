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

    // A 152MB file cannot be held in memory to hash at the end, so chunks append
    // to a staging file and the resumed offset is however much already landed.
    @Test func aPartialTransferResumesFromWhatAlreadyLanded() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }
        let bytes = Data("first-half second-half".utf8)
        let asset = descriptor(path: "VoicePhoneModel.mlmodelc/weights/weight.bin", bytes: bytes)

        #expect(cache.stagedByteCount(for: asset) == 0)
        try cache.appendToStaging(Data("first-half ".utf8), for: asset)
        #expect(cache.stagedByteCount(for: asset) == 11)
        // Still not cached: only a promoted file counts.
        #expect(!cache.isPresent(asset))

        try cache.appendToStaging(Data("second-half".utf8), for: asset)
        try cache.promoteStaging(for: asset)

        #expect(cache.isPresent(asset))
        #expect(cache.stagedByteCount(for: asset) == 0)
        let url = try #require(cache.url(for: asset.path))
        #expect(try Data(contentsOf: url) == bytes)
    }

    @Test func aStagedFileThatFailsItsHashIsDiscardedNotPromoted() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }
        let asset = descriptor(path: "VoiceZIPAModel.onnx", bytes: Data("real".utf8))
        try cache.appendToStaging(Data("corrupt".utf8), for: asset)

        #expect(throws: VoiceAssetCache.CacheError.hashMismatch(path: "VoiceZIPAModel.onnx")) {
            try cache.promoteStaging(for: asset)
        }
        #expect(!cache.isPresent(asset))
        // Discarded rather than left to poison the next resume.
        #expect(cache.stagedByteCount(for: asset) == 0)
    }

    // An empty manifest means the Mac has no models, which is not the same as
    // the phone having them all.
    @Test func anEmptyManifestIsNotCompleteness() throws {
        let cache = try makeCache()
        defer { try? FileManager.default.removeItem(at: cache.root) }

        #expect(!cache.isComplete(for: VoiceAssetManifest(assets: [])))
    }
}
