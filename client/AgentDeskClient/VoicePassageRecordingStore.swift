import AVFoundation
import CryptoKit
import Foundation

enum VoicePassageRecordingSource: String, Codable, Equatable, Sendable {
    case microphone
    case bundledSample
}

struct VoicePassageRecording: Codable, Equatable, Identifiable, Sendable {
    static let currentSchemaVersion = 1
    static let audioFileName = "audio.caf"

    let schemaVersion: Int
    let id: UUID
    let createdAt: Date
    let source: VoicePassageRecordingSource
    let title: String
    let localeIdentifier: String
    let durationSeconds: TimeInterval
    let frameCount: Int64
    let audioFileName: String
    let analyzerFormat: VoiceAnalyzerFormatMetadata
    let build: VoiceBuildIdentity
    var transcript: String
    var recognizedTranscript: String?
    var transcriptEditedAt: Date?
    var observedPhones: [String]
    var referencePhones: [String]
    var wordPhoneGroups: [VoicePassageWordPhoneGroup]?
    var unknownReferenceWords: [String]
    var modelWeightSHA256: String?
    var transcriptionFailure: String?
    var phoneAnalysisFailure: String?
    var lastAnalyzedAt: Date?

    mutating func applyRecognizedTranscript(_ text: String) {
        recognizedTranscript = text
        if transcriptEditedAt == nil {
            transcript = text
        }
    }

    mutating func applyTranscriptEdit(
        _ text: String,
        at date: Date = Date()
    ) {
        transcript = text
        transcriptEditedAt = date
    }
}

enum VoicePassageBundledSample {
    static let id = UUID(
        uuidString: "F8A67D47-7396-4E7C-88DE-05CA98725D45"
    )!
    static let resourceName = "VoicePassageSample"
    static let transcript =
        "I thought about walking through the quiet garden."
    static let title = "Thought about the quiet garden"
}

final class VoicePassageRecordingStore {
    enum StoreError: LocalizedError {
        case unsupportedAudioFormat(String)
        case unsupportedSchema(Int)
        case missingRecording(UUID)
        case invalidRecording(UUID)
        case missingBundledSample
        case cannotDeleteBundledSample

        var errorDescription: String? {
            switch self {
            case .unsupportedAudioFormat(let format):
                return "Cannot save passage audio in unsupported format \(format)."
            case .unsupportedSchema(let version):
                return "Saved passage schema \(version) is unsupported."
            case .missingRecording(let id):
                return "Saved passage \(id.uuidString) no longer exists."
            case .invalidRecording(let id):
                return "Saved passage \(id.uuidString) is incomplete."
            case .missingBundledSample:
                return "The bundled passage sample is missing."
            case .cannotDeleteBundledSample:
                return "The bundled passage sample cannot be deleted."
            }
        }
    }

    private static let metadataFileName = "metadata.json"

    private let rootDirectory: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        rootDirectory: URL = Config.voicePassageRecordingsDirectory,
        fileManager: FileManager = .default
    ) {
        self.rootDirectory = rootDirectory
        self.fileManager = fileManager

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [
            .prettyPrinted,
            .sortedKeys,
            .withoutEscapingSlashes
        ]
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
    ) throws -> VoicePassageRecording {
        try validatePCMFormat(capture.format)
        try ensureRootDirectory()

        let id = UUID()
        let directory = recordingDirectory(for: id)
        let stagingDirectory = stagingDirectory(for: id)
        try fileManager.createDirectory(
            at: stagingDirectory,
            withIntermediateDirectories: false
        )

        do {
            let audioURL = stagingDirectory.appendingPathComponent(
                VoicePassageRecording.audioFileName,
                isDirectory: false
            )
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

            let recording = VoicePassageRecording(
                schemaVersion:
                    VoicePassageRecording.currentSchemaVersion,
                id: id,
                createdAt: capture.startedAt,
                source: .microphone,
                title: "Recorded passage",
                localeIdentifier: locale.identifier,
                durationSeconds: capture.durationSeconds,
                frameCount: Int64(capture.frameCount),
                audioFileName: VoicePassageRecording.audioFileName,
                analyzerFormat:
                    VoiceAnalyzerFormatMetadata(format: capture.format),
                build: build,
                transcript: "",
                recognizedTranscript: nil,
                transcriptEditedAt: nil,
                observedPhones: [],
                referencePhones: [],
                wordPhoneGroups: nil,
                unknownReferenceWords: [],
                modelWeightSHA256: nil,
                transcriptionFailure: nil,
                phoneAnalysisFailure: nil,
                lastAnalyzedAt: nil
            )
            try write(recording, in: stagingDirectory)
            try fileManager.moveItem(
                at: stagingDirectory,
                to: directory
            )
            return recording
        } catch {
            try? fileManager.removeItem(at: stagingDirectory)
            throw error
        }
    }

    @discardableResult
    func seedBundledSample(
        bundle: Bundle = .main,
        build: VoiceBuildIdentity = .current()
    ) throws -> VoicePassageRecording {
        if fileManager.fileExists(
            atPath: recordingDirectory(
                for: VoicePassageBundledSample.id
            ).path
        ) {
            return try recording(id: VoicePassageBundledSample.id)
        }
        guard let sourceURL = bundle.url(
            forResource: VoicePassageBundledSample.resourceName,
            withExtension: "caf"
        ) else {
            throw StoreError.missingBundledSample
        }

        try ensureRootDirectory()
        let id = VoicePassageBundledSample.id
        let directory = recordingDirectory(for: id)
        let stagingDirectory = stagingDirectory(for: id)
        try fileManager.createDirectory(
            at: stagingDirectory,
            withIntermediateDirectories: false
        )
        do {
            let destinationURL = stagingDirectory.appendingPathComponent(
                VoicePassageRecording.audioFileName,
                isDirectory: false
            )
            try fileManager.copyItem(
                at: sourceURL,
                to: destinationURL
            )
            let audioFile = try AVAudioFile(forReading: destinationURL)
            try validatePCMFormat(audioFile.processingFormat)
            let recording = VoicePassageRecording(
                schemaVersion:
                    VoicePassageRecording.currentSchemaVersion,
                id: id,
                createdAt: Date(timeIntervalSince1970: 0),
                source: .bundledSample,
                title: VoicePassageBundledSample.title,
                localeIdentifier: "en-US",
                durationSeconds:
                    Double(audioFile.length)
                        / audioFile.processingFormat.sampleRate,
                frameCount: audioFile.length,
                audioFileName: VoicePassageRecording.audioFileName,
                analyzerFormat: VoiceAnalyzerFormatMetadata(
                    format: audioFile.processingFormat
                ),
                build: build,
                transcript: VoicePassageBundledSample.transcript,
                recognizedTranscript:
                    VoicePassageBundledSample.transcript,
                transcriptEditedAt: nil,
                observedPhones: [],
                referencePhones: [],
                wordPhoneGroups: nil,
                unknownReferenceWords: [],
                modelWeightSHA256: nil,
                transcriptionFailure: nil,
                phoneAnalysisFailure: nil,
                lastAnalyzedAt: nil
            )
            try write(recording, in: stagingDirectory)
            try fileManager.moveItem(
                at: stagingDirectory,
                to: directory
            )
            return recording
        } catch {
            try? fileManager.removeItem(at: stagingDirectory)
            throw error
        }
    }

    func recordings() throws -> [VoicePassageRecording] {
        guard fileManager.fileExists(atPath: rootDirectory.path) else {
            return []
        }
        let directories = try fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        return try directories.compactMap { directory in
            let values = try directory.resourceValues(
                forKeys: [.isDirectoryKey]
            )
            guard values.isDirectory == true,
                  let id = UUID(
                      uuidString: directory.lastPathComponent
                  )
            else {
                return nil
            }
            return try recording(id: id)
        }
        .sorted {
            if $0.source != $1.source {
                return $0.source == .bundledSample
            }
            return $0.createdAt > $1.createdAt
        }
    }

    func recording(id: UUID) throws -> VoicePassageRecording {
        let url = metadataURL(for: id)
        guard fileManager.fileExists(atPath: url.path) else {
            throw StoreError.missingRecording(id)
        }
        let recording = try decoder.decode(
            VoicePassageRecording.self,
            from: Data(contentsOf: url)
        )
        guard recording.schemaVersion
                == VoicePassageRecording.currentSchemaVersion
        else {
            throw StoreError.unsupportedSchema(recording.schemaVersion)
        }
        guard recording.id == id,
              fileManager.fileExists(
                  atPath: audioURL(for: recording).path
              )
        else {
            throw StoreError.invalidRecording(id)
        }
        return recording
    }

    func save(_ recording: VoicePassageRecording) throws {
        guard recording.schemaVersion
                == VoicePassageRecording.currentSchemaVersion,
              fileManager.fileExists(
                  atPath: audioURL(for: recording).path
              )
        else {
            throw StoreError.invalidRecording(recording.id)
        }
        try write(recording)
    }

    func delete(recordingID: UUID) throws {
        let recording = try recording(id: recordingID)
        guard recording.source != .bundledSample else {
            throw StoreError.cannotDeleteBundledSample
        }
        try fileManager.removeItem(
            at: recordingDirectory(for: recordingID)
        )
    }

    func audioURL(for recording: VoicePassageRecording) -> URL {
        recordingDirectory(for: recording.id)
            .appendingPathComponent(
                recording.audioFileName,
                isDirectory: false
            )
    }

    func audioSHA256(
        for recording: VoicePassageRecording
    ) throws -> String {
        let data = try Data(
            contentsOf: audioURL(for: recording),
            options: .mappedIfSafe
        )
        return SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func validatePCMFormat(
        _ format: AVAudioFormat
    ) throws {
        guard format.commonFormat != .otherFormat else {
            throw StoreError.unsupportedAudioFormat(
                format.description
            )
        }
        let formatID = (
            format.settings[AVFormatIDKey] as? NSNumber
        )?.uint32Value
        guard formatID == kAudioFormatLinearPCM else {
            throw StoreError.unsupportedAudioFormat(
                format.description
            )
        }
    }

    private func ensureRootDirectory() throws {
        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true
        )
    }

    private func write(
        _ recording: VoicePassageRecording
    ) throws {
        try write(
            recording,
            in: recordingDirectory(for: recording.id)
        )
    }

    private func write(
        _ recording: VoicePassageRecording,
        in directory: URL
    ) throws {
        try encoder.encode(recording).write(
            to: directory.appendingPathComponent(
                Self.metadataFileName,
                isDirectory: false
            ),
            options: .atomic
        )
    }

    private func metadataURL(for recordingID: UUID) -> URL {
        recordingDirectory(for: recordingID)
            .appendingPathComponent(
                Self.metadataFileName,
                isDirectory: false
            )
    }

    private func recordingDirectory(for recordingID: UUID) -> URL {
        rootDirectory.appendingPathComponent(
            recordingID.uuidString,
            isDirectory: true
        )
    }

    private func stagingDirectory(for recordingID: UUID) -> URL {
        rootDirectory.appendingPathComponent(
            ".\(recordingID.uuidString)-\(UUID().uuidString).staging",
            isDirectory: true
        )
    }
}
