import Foundation

enum VoicePhoneAnalysisStage: String, Codable, Equatable {
    case analysisStarted
    case audioReadStarted
    case audioReadCompleted
    case audioPreparationStarted
    case audioPrepared
    case assetsLoadStarted
    case assetsCacheHit
    case bundledManifestLoaded
    case vocabularyLoaded
    case modelLoadStarted
    case modelLoaded
    case inputAllocationStarted
    case inputPrepared
    case inferenceStarted
    case inferenceCompleted
    case logitsCopyStarted
    case logitsCopied
    case alignmentStarted
    case alignmentCompleted
    case analysisCompleted
    case analysisFailed
}

struct VoicePhoneAnalysisLogEvent: Codable, Equatable {
    let timestamp: Date
    let stage: VoicePhoneAnalysisStage
    let residentMemoryBytes: UInt64?
    let details: [String: String]
}

struct VoicePhoneAnalysisLog: Codable, Equatable {
    static let currentSchemaVersion = 1

    let schemaVersion: Int
    let attemptID: UUID
    let modelWeightSHA256: String
    let startedAt: Date
    var events: [VoicePhoneAnalysisLogEvent]
}

struct VoicePhoneAnalysisLogWriter {
    static let fileName = "phone-analysis-log.json"

    private let url: URL
    private let encoder: JSONEncoder
    private var log: VoicePhoneAnalysisLog

    init(
        attemptID: UUID,
        audioURL: URL,
        modelWeightSHA256: String,
        startedAt: Date = Date(),
        residentMemoryBytes: UInt64? = nil
    ) throws {
        url = audioURL.deletingLastPathComponent()
            .appendingPathComponent(Self.fileName, isDirectory: false)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder

        log = VoicePhoneAnalysisLog(
            schemaVersion: VoicePhoneAnalysisLog.currentSchemaVersion,
            attemptID: attemptID,
            modelWeightSHA256: modelWeightSHA256,
            startedAt: startedAt,
            events: [
                VoicePhoneAnalysisLogEvent(
                    timestamp: startedAt,
                    stage: .analysisStarted,
                    residentMemoryBytes: residentMemoryBytes,
                    details: [:]
                )
            ]
        )
        try persist()
    }

    mutating func record(
        _ stage: VoicePhoneAnalysisStage,
        residentMemoryBytes: UInt64? = nil,
        details: [String: String] = [:],
        timestamp: Date = Date()
    ) throws {
        log.events.append(
            VoicePhoneAnalysisLogEvent(
                timestamp: timestamp,
                stage: stage,
                residentMemoryBytes: residentMemoryBytes,
                details: details
            )
        )
        try persist()
    }

    private func persist() throws {
        try encoder.encode(log).write(to: url, options: .atomic)
    }
}
