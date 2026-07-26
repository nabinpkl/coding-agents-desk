import AVFoundation
import CryptoKit
import Foundation

struct VoiceAnalyzerFormatMetadata: Codable, Equatable {
    let sampleRate: Double
    let channelCount: UInt32
    let commonFormat: String
    let isInterleaved: Bool
    let container: String
    let codec: String

    init(
        sampleRate: Double,
        channelCount: UInt32,
        commonFormat: String,
        isInterleaved: Bool,
        container: String,
        codec: String
    ) {
        self.sampleRate = sampleRate
        self.channelCount = channelCount
        self.commonFormat = commonFormat
        self.isInterleaved = isInterleaved
        self.container = container
        self.codec = codec
    }

    init(format: AVAudioFormat) {
        sampleRate = format.sampleRate
        channelCount = format.channelCount
        commonFormat = switch format.commonFormat {
        case .pcmFormatFloat32: "pcmFloat32"
        case .pcmFormatFloat64: "pcmFloat64"
        case .pcmFormatInt16: "pcmInt16"
        case .pcmFormatInt32: "pcmInt32"
        case .otherFormat: "other"
        @unknown default: "unknown-\(format.commonFormat.rawValue)"
        }
        isInterleaved = format.isInterleaved
        container = "caf"
        codec = "linearPCM"
    }
}

struct VoiceBuildIdentity: Codable, Equatable {
    let bundleIdentifier: String
    let marketingVersion: String
    let buildNumber: String
    let gitSHA: String

    static func current(bundle: Bundle = .main) -> VoiceBuildIdentity {
        let info = bundle.infoDictionary
        return VoiceBuildIdentity(
            bundleIdentifier: bundle.bundleIdentifier ?? "?",
            marketingVersion: info?["CFBundleShortVersionString"] as? String ?? "?",
            buildNumber: info?["CFBundleVersion"] as? String ?? "?",
            gitSHA: (info?["AgentDeskGitSHA"] as? String)
                .flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
        )
    }
}

struct VoiceAttemptAnalysis: Codable, Equatable {
    let withoutContext: VoiceReading
    let withContext: VoiceReading
    let withoutContextTargetMatch: VoiceTargetMatch
    let withContextTargetMatch: VoiceTargetMatch
    let verdict: VoiceGapVerdict
}

struct VoiceSavedAttempt: Codable, Equatable, Identifiable {
    static let currentSchemaVersion = 1
    static let audioFileName = "audio.caf"

    let schemaVersion: Int
    let id: UUID
    let createdAt: Date
    let targetPhrase: String
    let localeIdentifier: String
    let durationSeconds: TimeInterval
    let frameCount: Int64
    let audioFileName: String
    let analyzerFormat: VoiceAnalyzerFormatMetadata
    let build: VoiceBuildIdentity
    var analysis: VoiceAttemptAnalysis?
    var analysisFailure: String?
}

final class VoiceAttemptStore {
    enum StoreError: LocalizedError {
        case unsupportedAudioFormat(String)
        case unsupportedSchema(Int)
        case unsupportedPhoneAnalysisSchema(Int)
        case unsupportedPhoneAssessmentSchema(Int)
        case missingAttempt(UUID)
        case invalidAttempt(UUID)
        case invalidPhoneAnalysis(UUID)
        case invalidPhoneAssessment(UUID)

        var errorDescription: String? {
            switch self {
            case .unsupportedAudioFormat(let format):
                return "Cannot retain analyzer audio in unsupported format \(format)."
            case .unsupportedSchema(let version):
                return "Saved voice attempt schema \(version) is unsupported."
            case .unsupportedPhoneAnalysisSchema(let version):
                return "Saved phone analysis schema \(version) is unsupported."
            case .unsupportedPhoneAssessmentSchema(let version):
                return "Saved phone assessment schema \(version) is unsupported."
            case .missingAttempt(let id):
                return "Saved voice attempt \(id.uuidString) no longer exists."
            case .invalidAttempt(let id):
                return "Saved voice attempt \(id.uuidString) is incomplete."
            case .invalidPhoneAnalysis(let id):
                return "Saved phone analysis for \(id.uuidString) is incomplete."
            case .invalidPhoneAssessment(let id):
                return "Saved phone assessment for \(id.uuidString) is incomplete."
            }
        }
    }

    private static let metadataFileName = "metadata.json"
    private static let phoneAnalysisFileName = "phone-evidence.json"
    private static let phoneAssessmentFileName = "phone-assessment.json"

    private let rootDirectory: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(
        rootDirectory: URL = Config.voiceAttemptsDirectory,
        fileManager: FileManager = .default
    ) {
        self.rootDirectory = rootDirectory
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
        targetPhrase: String,
        locale: Locale,
        build: VoiceBuildIdentity = .current()
    ) throws -> VoiceSavedAttempt {
        guard capture.format.commonFormat != .otherFormat else {
            throw StoreError.unsupportedAudioFormat(capture.format.description)
        }
        let formatID = (capture.format.settings[AVFormatIDKey] as? NSNumber)?.uint32Value
        guard formatID == kAudioFormatLinearPCM else {
            throw StoreError.unsupportedAudioFormat(capture.format.description)
        }

        try fileManager.createDirectory(
            at: rootDirectory,
            withIntermediateDirectories: true
        )

        let id = UUID()
        let directory = attemptDirectory(for: id)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: false)

        do {
            let audioURL = directory.appendingPathComponent(
                VoiceSavedAttempt.audioFileName,
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
                    throw StoreError.unsupportedAudioFormat(buffer.format.description)
                }
                try audioFile.write(from: buffer)
            }
            audioFile.close()

            let attempt = VoiceSavedAttempt(
                schemaVersion: VoiceSavedAttempt.currentSchemaVersion,
                id: id,
                createdAt: capture.startedAt,
                targetPhrase: targetPhrase,
                localeIdentifier: locale.identifier,
                durationSeconds: capture.durationSeconds,
                frameCount: Int64(capture.frameCount),
                audioFileName: VoiceSavedAttempt.audioFileName,
                analyzerFormat: VoiceAnalyzerFormatMetadata(format: capture.format),
                build: build,
                analysis: nil,
                analysisFailure: nil
            )
            try write(attempt)
            return attempt
        } catch {
            try? fileManager.removeItem(at: directory)
            throw error
        }
    }

    func finishAnalysis(
        attemptID: UUID,
        withoutContext: VoiceReading,
        withContext: VoiceReading
    ) throws -> VoiceSavedAttempt {
        var attempt = try load(attemptID: attemptID)
        let withoutMatch = VoiceContextComparison.matchLocation(
            in: withoutContext,
            target: attempt.targetPhrase
        )
        let withMatch = VoiceContextComparison.matchLocation(
            in: withContext,
            target: attempt.targetPhrase
        )
        attempt.analysis = VoiceAttemptAnalysis(
            withoutContext: withoutContext,
            withContext: withContext,
            withoutContextTargetMatch: withoutMatch,
            withContextTargetMatch: withMatch,
            verdict: VoiceContextComparison.verdict(
                target: attempt.targetPhrase,
                withoutContext: withoutContext,
                withContext: withContext
            )
        )
        attempt.analysisFailure = nil
        try write(attempt)
        return attempt
    }

    func recordAnalysisFailure(
        attemptID: UUID,
        message: String
    ) throws -> VoiceSavedAttempt {
        var attempt = try load(attemptID: attemptID)
        attempt.analysis = nil
        attempt.analysisFailure = message
        try write(attempt)
        return attempt
    }

    func attempts() throws -> [VoiceSavedAttempt] {
        guard fileManager.fileExists(atPath: rootDirectory.path) else { return [] }
        let directories = try fileManager.contentsOfDirectory(
            at: rootDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        return try directories.compactMap { directory in
            let values = try directory.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else { return nil }
            guard let id = UUID(uuidString: directory.lastPathComponent) else { return nil }
            return try load(attemptID: id)
        }
        .sorted { $0.createdAt > $1.createdAt }
    }

    func audioURL(for attempt: VoiceSavedAttempt) throws -> URL {
        let url = attemptDirectory(for: attempt.id)
            .appendingPathComponent(attempt.audioFileName, isDirectory: false)
        guard fileManager.fileExists(atPath: url.path) else {
            throw StoreError.invalidAttempt(attempt.id)
        }
        return url
    }

    func audioSHA256(for attempt: VoiceSavedAttempt) throws -> String {
        let data = try Data(contentsOf: audioURL(for: attempt), options: .mappedIfSafe)
        return SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }

    func phoneAnalysis(
        for attempt: VoiceSavedAttempt
    ) throws -> VoiceStoredPhoneAnalysis? {
        let url = phoneAnalysisURL(for: attempt.id)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let analysis = try decoder.decode(
            VoiceStoredPhoneAnalysis.self,
            from: Data(contentsOf: url)
        )
        guard analysis.schemaVersion == VoiceStoredPhoneAnalysis.currentSchemaVersion else {
            throw StoreError.unsupportedPhoneAnalysisSchema(analysis.schemaVersion)
        }
        guard analysis.attemptID == attempt.id, analysis.isWellFormed else {
            throw StoreError.invalidPhoneAnalysis(attempt.id)
        }
        return analysis
    }

    func savePhoneEvidence(
        _ evidence: VoicePhoneEvidence
    ) throws -> VoiceStoredPhoneAnalysis {
        let attempt = try load(attemptID: evidence.attemptID)
        let currentAudioSHA256 = try audioSHA256(for: attempt)
        guard evidence.schemaVersion == VoicePhoneEvidence.currentSchemaVersion,
              evidence.audioSHA256 == currentAudioSHA256
        else {
            throw StoreError.invalidPhoneAnalysis(evidence.attemptID)
        }
        let analysis = VoiceStoredPhoneAnalysis.completed(evidence)
        try writePhoneAnalysis(analysis)
        return analysis
    }

    func phoneAssessment(
        for attempt: VoiceSavedAttempt
    ) throws -> VoicePhoneAssessment? {
        let url = phoneAssessmentURL(for: attempt.id)
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        let assessment = try decoder.decode(
            VoicePhoneAssessment.self,
            from: Data(contentsOf: url)
        )
        guard assessment.schemaVersion == VoicePhoneAssessment.currentSchemaVersion else {
            throw StoreError.unsupportedPhoneAssessmentSchema(
                assessment.schemaVersion
            )
        }
        guard assessment.attemptID == attempt.id, assessment.isWellFormed else {
            throw StoreError.invalidPhoneAssessment(attempt.id)
        }
        return assessment
    }

    func savePhoneAssessment(
        _ assessment: VoicePhoneAssessment,
        evidence: VoicePhoneEvidence,
        calibration: VoicePhoneCalibrationManifest
    ) throws {
        let attempt = try load(attemptID: assessment.attemptID)
        guard try audioSHA256(for: attempt) == evidence.audioSHA256,
              assessment.isCurrent(
                  for: evidence,
                  calibration: calibration
              )
        else {
            throw StoreError.invalidPhoneAssessment(assessment.attemptID)
        }
        let data = try encoder.encode(assessment)
        try data.write(
            to: phoneAssessmentURL(for: assessment.attemptID),
            options: .atomic
        )
    }

    func recordPhoneAnalysisFailure(
        attemptID: UUID,
        message: String,
        modelWeightSHA256: String?
    ) throws -> VoiceStoredPhoneAnalysis {
        let attempt = try load(attemptID: attemptID)
        let analysis = VoiceStoredPhoneAnalysis.failed(
            attemptID: attemptID,
            audioSHA256: try audioSHA256(for: attempt),
            modelWeightSHA256: modelWeightSHA256,
            message: message
        )
        try writePhoneAnalysis(analysis)
        return analysis
    }

    func delete(attemptID: UUID) throws {
        let directory = attemptDirectory(for: attemptID)
        guard fileManager.fileExists(atPath: directory.path) else {
            throw StoreError.missingAttempt(attemptID)
        }
        try fileManager.removeItem(at: directory)
    }

    func deleteAll() throws {
        guard fileManager.fileExists(atPath: rootDirectory.path) else { return }
        try fileManager.removeItem(at: rootDirectory)
    }

    private func load(attemptID: UUID) throws -> VoiceSavedAttempt {
        let url = metadataURL(for: attemptID)
        guard fileManager.fileExists(atPath: url.path) else {
            throw StoreError.missingAttempt(attemptID)
        }
        let attempt = try decoder.decode(
            VoiceSavedAttempt.self,
            from: Data(contentsOf: url)
        )
        guard attempt.schemaVersion == VoiceSavedAttempt.currentSchemaVersion else {
            throw StoreError.unsupportedSchema(attempt.schemaVersion)
        }
        guard attempt.id == attemptID else {
            throw StoreError.invalidAttempt(attemptID)
        }
        return attempt
    }

    private func write(_ attempt: VoiceSavedAttempt) throws {
        let data = try encoder.encode(attempt)
        try data.write(to: metadataURL(for: attempt.id), options: .atomic)
    }

    private func writePhoneAnalysis(_ analysis: VoiceStoredPhoneAnalysis) throws {
        guard analysis.isWellFormed else {
            throw StoreError.invalidPhoneAnalysis(analysis.attemptID)
        }
        let data = try encoder.encode(analysis)
        try data.write(
            to: phoneAnalysisURL(for: analysis.attemptID),
            options: .atomic
        )
    }

    private func metadataURL(for attemptID: UUID) -> URL {
        attemptDirectory(for: attemptID)
            .appendingPathComponent(Self.metadataFileName, isDirectory: false)
    }

    private func phoneAnalysisURL(for attemptID: UUID) -> URL {
        attemptDirectory(for: attemptID)
            .appendingPathComponent(Self.phoneAnalysisFileName, isDirectory: false)
    }

    private func phoneAssessmentURL(for attemptID: UUID) -> URL {
        attemptDirectory(for: attemptID)
            .appendingPathComponent(Self.phoneAssessmentFileName, isDirectory: false)
    }

    private func attemptDirectory(for attemptID: UUID) -> URL {
        rootDirectory.appendingPathComponent(attemptID.uuidString, isDirectory: true)
    }
}
