import CryptoKit
import Foundation

enum VoicePassagePhoneModel: String, Codable, CaseIterable, Equatable, Sendable {
    case zipa
    case wav2vec2

    static let defaultModel: Self = .zipa
    static let userDefaultsKey = "voice.passage.phone-model"

    var displayName: String {
        switch self {
        case .zipa:
            return "ZIPA"
        case .wav2vec2:
            return "wav2vec2"
        }
    }

    var modelIdentifier: String {
        switch self {
        case .zipa:
            return VoiceZIPAModelManifest.selectedIdentifier
        case .wav2vec2:
            return VoicePhoneModelManifest.selectedIdentifier
        }
    }

    static func selected(in defaults: UserDefaults) -> Self {
        guard let rawValue = defaults.string(forKey: userDefaultsKey),
              let model = Self(rawValue: rawValue)
        else {
            return defaultModel
        }
        return model
    }

    func select(in defaults: UserDefaults) {
        defaults.set(rawValue, forKey: Self.userDefaultsKey)
    }

    static func displayName(forModelIdentifier identifier: String?) -> String? {
        allCases.first { $0.modelIdentifier == identifier }?.displayName
    }
}

struct VoiceZIPAModelManifest: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 2
    static let selectedIdentifier = "zipa-small-crctc-ns-700k-int8-onnx"
    static let selectedModelSHA256 =
        "c0a74847edb1224f90a5a1d20c501f81d841439e0692f8e32d1fe6bd94beaa77"
    static let selectedTokensSHA256 =
        "f8e042a0c9130532b22d03ec7cae2f75a23fbec70c450c31a8efb51787b2b8fe"

    let schemaVersion: Int
    let identifier: String
    let upstreamModel: String
    let upstreamRevision: String
    let upstreamLicense: String
    let licenseRepository: String
    let licenseRevision: String
    let modelSHA256: String
    let tokensSHA256: String
    let licenseSHA256: String
    let modelBytes: Int
    let sampleRate: Int
    let filterbankBins: Int
    let vocabularySize: Int
    let blankTokenID: Int
}

enum VoiceZIPAModelError: LocalizedError {
    case missingAsset(String)
    case invalidManifest(String)
    case invalidTokens(String)
    case invalidAudio(String)
    case invalidOutput(String)

    var errorDescription: String? {
        switch self {
        case .missingAsset(let name):
            return "Voice model file \(name) has not been downloaded from your Mac yet."
        case .invalidManifest(let detail):
            return "The ZIPA model manifest is invalid: \(detail)"
        case .invalidTokens(let detail):
            return "The ZIPA token inventory is invalid: \(detail)"
        case .invalidAudio(let detail):
            return "ZIPA could not prepare the saved audio: \(detail)"
        case .invalidOutput(let detail):
            return "ZIPA returned an unexpected tensor: \(detail)"
        }
    }
}

struct VoiceZIPAModelAssets {
    let manifest: VoiceZIPAModelManifest
    let modelURL: URL
    let tokensByID: [String]

    static func load(assets: VoiceAssetCache = .shared) throws -> Self {
        let manifestURL = try resourceURL(
            named: "VoiceZIPAModelManifest",
            extension: "json",
            assets: assets
        )
        let manifest = try JSONDecoder().decode(
            VoiceZIPAModelManifest.self,
            from: Data(contentsOf: manifestURL)
        )
        guard manifest.schemaVersion == VoiceZIPAModelManifest.currentSchemaVersion,
              manifest.identifier == VoiceZIPAModelManifest.selectedIdentifier,
              manifest.modelSHA256 == VoiceZIPAModelManifest.selectedModelSHA256,
              manifest.tokensSHA256 == VoiceZIPAModelManifest.selectedTokensSHA256,
              manifest.sampleRate == 16_000,
              manifest.filterbankBins == 80,
              manifest.vocabularySize == 127,
              manifest.blankTokenID == 0
        else {
            throw VoiceZIPAModelError.invalidManifest(
                "the selected model or tensor contract does not match R140"
            )
        }

        let tokenURL = try resourceURL(
            named: "VoiceZIPATokens",
            extension: "txt",
            assets: assets
        )
        let tokenData = try Data(contentsOf: tokenURL)
        guard SHA256.hash(data: tokenData).hexString == manifest.tokensSHA256 else {
            throw VoiceZIPAModelError.invalidTokens(
                "SHA-256 does not match the pinned manifest"
            )
        }
        let tokens = try parseTokens(
            String(decoding: tokenData, as: UTF8.self),
            expectedCount: manifest.vocabularySize
        )
        guard tokens[manifest.blankTokenID] == "<blk>" else {
            throw VoiceZIPAModelError.invalidTokens(
                "token zero is not the CTC blank"
            )
        }

        let modelURL = try resourceURL(
            named: "VoiceZIPAModel",
            extension: "onnx",
            assets: assets
        )
        let values = try modelURL.resourceValues(forKeys: [.fileSizeKey])
        guard values.fileSize == manifest.modelBytes else {
            throw VoiceZIPAModelError.invalidManifest(
                "the fetched graph byte count does not match the manifest"
            )
        }
        let modelData = try Data(
            contentsOf: modelURL,
            options: [.mappedIfSafe]
        )
        guard SHA256.hash(data: modelData).hexString == manifest.modelSHA256 else {
            throw VoiceZIPAModelError.invalidManifest(
                "the fetched graph SHA-256 does not match the manifest"
            )
        }
        return Self(
            manifest: manifest,
            modelURL: modelURL,
            tokensByID: tokens
        )
    }

    static func parseTokens(
        _ contents: String,
        expectedCount: Int
    ) throws -> [String] {
        var indexed: [Int: String] = [:]
        for (lineIndex, line) in contents.split(separator: "\n").enumerated() {
            let parts = line.split(whereSeparator: \.isWhitespace)
            guard parts.count == 2,
                  let identifier = Int(parts[1]),
                  indexed[identifier] == nil
            else {
                throw VoiceZIPAModelError.invalidTokens(
                    "row \(lineIndex + 1) is malformed or duplicated"
                )
            }
            indexed[identifier] = String(parts[0])
        }
        guard indexed.count == expectedCount,
              Set(indexed.keys) == Set(0..<expectedCount)
        else {
            throw VoiceZIPAModelError.invalidTokens(
                "expected contiguous IDs 0 through \(expectedCount - 1)"
            )
        }
        return (0..<expectedCount).map { indexed[$0]! }
    }

    private static func resourceURL(
        named name: String,
        extension fileExtension: String,
        assets: VoiceAssetCache
    ) throws -> URL {
        guard let url = assets.assetURL(
            named: name,
            extension: fileExtension
        ) else {
            throw VoiceZIPAModelError.missingAsset(
                "\(name).\(fileExtension)"
            )
        }
        return url
    }
}
