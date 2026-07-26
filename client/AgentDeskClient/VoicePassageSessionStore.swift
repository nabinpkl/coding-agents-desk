import AVFoundation
import Foundation

struct VoicePassageSession: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let id: UUID
    let createdAt: Date
    let localeIdentifier: String
    let audioFileName: String
    let build: VoiceBuildIdentity
    var transcript: String
    var observedPhones: [String]
    var referencePhones: [String]
    var unknownReferenceWords: [String]
    var modelWeightSHA256: String?
}

final class VoicePassageSessionStore {
    enum StoreError: LocalizedError {
        case unsupportedAudioFormat(String)
        case unsupportedSchema(Int)
        case invalidSession

        var errorDescription: String? {
            switch self {
            case .unsupportedAudioFormat(let format):
                return "Cannot save passage audio in unsupported format \(format)."
            case .unsupportedSchema(let version):
                return "Saved passage schema \(version) is unsupported."
            case .invalidSession:
                return "The saved passage recording is incomplete."
            }
        }
    }

    private static let metadataFileName = "metadata.json"

    private let directory: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        directory: URL = Config.voicePassageSessionDirectory,
        fileManager: FileManager = .default
    ) {
        self.directory = directory
        self.fileManager = fileManager

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    @available(iOS 26.0, *)
    func save(
        capture: VoiceCapturedTake,
        locale: Locale,
        build: VoiceBuildIdentity = .current()
    ) throws -> VoicePassageSession {
        guard capture.format.commonFormat != .otherFormat else {
            throw StoreError.unsupportedAudioFormat(capture.format.description)
        }
        let formatID = (capture.format.settings[AVFormatIDKey] as? NSNumber)?
            .uint32Value
        guard formatID == kAudioFormatLinearPCM else {
            throw StoreError.unsupportedAudioFormat(capture.format.description)
        }

        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        let id = UUID()
        let audioFileName = "\(id.uuidString.lowercased()).caf"
        let audioURL = directory.appendingPathComponent(
            audioFileName,
            isDirectory: false
        )
        do {
            let audioFile = try AVAudioFile(
                forWriting: audioURL,
                settings: capture.format.settings,
                commonFormat: capture.format.commonFormat,
                interleaved: capture.format.isInterleaved
            )
            for buffer in capture.buffers {
                guard buffer.format == capture.format else {
                    throw StoreError.unsupportedAudioFormat(
                        buffer.format.description
                    )
                }
                try audioFile.write(from: buffer)
            }
            audioFile.close()

            let priorAudioURL = try? load().map(audioURL(for:))
            let session = VoicePassageSession(
                schemaVersion: VoicePassageSession.currentSchemaVersion,
                id: id,
                createdAt: capture.startedAt,
                localeIdentifier: locale.identifier,
                audioFileName: audioFileName,
                build: build,
                transcript: "",
                observedPhones: [],
                referencePhones: [],
                unknownReferenceWords: [],
                modelWeightSHA256: nil
            )
            try write(session)
            if let priorAudioURL, priorAudioURL != audioURL {
                try? fileManager.removeItem(at: priorAudioURL)
            }
            return session
        } catch {
            try? fileManager.removeItem(at: audioURL)
            throw error
        }
    }

    func load() throws -> VoicePassageSession? {
        let url = metadataURL
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let session = try decoder.decode(
            VoicePassageSession.self,
            from: Data(contentsOf: url)
        )
        guard session.schemaVersion == VoicePassageSession.currentSchemaVersion else {
            throw StoreError.unsupportedSchema(session.schemaVersion)
        }
        guard fileManager.fileExists(atPath: audioURL(for: session).path) else {
            throw StoreError.invalidSession
        }
        return session
    }

    func save(_ session: VoicePassageSession) throws {
        guard session.schemaVersion == VoicePassageSession.currentSchemaVersion,
              fileManager.fileExists(atPath: audioURL(for: session).path)
        else {
            throw StoreError.invalidSession
        }
        try write(session)
    }

    func audioURL(for session: VoicePassageSession) -> URL {
        directory.appendingPathComponent(
            session.audioFileName,
            isDirectory: false
        )
    }

    private var metadataURL: URL {
        directory.appendingPathComponent(
            Self.metadataFileName,
            isDirectory: false
        )
    }

    private func write(_ session: VoicePassageSession) throws {
        try encoder.encode(session).write(to: metadataURL, options: .atomic)
    }
}
