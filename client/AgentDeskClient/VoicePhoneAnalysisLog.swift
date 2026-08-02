import Foundation
import OSLog

enum VoicePhoneAnalysisStage: String, Codable, Equatable {
    case analysisStarted
    case audioReadStarted
    case audioReadCompleted
    case audioPreparationStarted
    case audioPrepared
    case assetsLoadStarted
    case assetsCacheHit
    case manifestLoaded
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
    static let diagnosticsEventType = "voicePhoneAnalysisStage"

    private let url: URL
    private let encoder: JSONEncoder
    private let diagnostics: ClientDiagnosticsStore
    private var log: VoicePhoneAnalysisLog

    init(
        attemptID: UUID,
        audioURL: URL,
        modelWeightSHA256: String,
        startedAt: Date = Date(),
        residentMemoryBytes: UInt64? = nil,
        diagnostics: ClientDiagnosticsStore = ClientDiagnostics.shared
    ) throws {
        url = audioURL.deletingLastPathComponent()
            .appendingPathComponent(Self.fileName, isDirectory: false)
        self.diagnostics = diagnostics

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder

        let startedEvent = VoicePhoneAnalysisLogEvent(
            timestamp: startedAt,
            stage: .analysisStarted,
            residentMemoryBytes: residentMemoryBytes,
            details: [:]
        )
        log = VoicePhoneAnalysisLog(
            schemaVersion: VoicePhoneAnalysisLog.currentSchemaVersion,
            attemptID: attemptID,
            modelWeightSHA256: modelWeightSHA256,
            startedAt: startedAt,
            events: [startedEvent]
        )
        recordInDiagnostics(startedEvent)
        try persist()
    }

    mutating func record(
        _ stage: VoicePhoneAnalysisStage,
        residentMemoryBytes: UInt64? = nil,
        details: [String: String] = [:],
        timestamp: Date = Date()
    ) throws {
        let event = VoicePhoneAnalysisLogEvent(
            timestamp: timestamp,
            stage: stage,
            residentMemoryBytes: residentMemoryBytes,
            details: details
        )
        recordInDiagnostics(event)
        log.events.append(event)
        try persist()
    }

    private func recordInDiagnostics(_ event: VoicePhoneAnalysisLogEvent) {
        diagnostics.record(
            type: Self.diagnosticsEventType,
            fields: Self.diagnosticsFields(
                event: event,
                attemptID: log.attemptID,
                modelWeightSHA256: log.modelWeightSHA256
            ),
            level: event.stage == .analysisFailed ? .error : .info
        )
    }

    static func diagnosticsFields(
        event: VoicePhoneAnalysisLogEvent,
        attemptID: UUID,
        modelWeightSHA256: String
    ) -> [String: String] {
        var fields = [
            "attemptID": attemptID.uuidString.lowercased(),
            "stage": event.stage.rawValue,
            "modelHash": modelWeightSHA256,
            "eventTimestamp": ISO8601DateFormatter().string(from: event.timestamp)
        ]
        if let residentMemoryBytes = event.residentMemoryBytes {
            fields["residentMemoryBytes"] = String(residentMemoryBytes)
        }
        for (key, value) in event.details {
            fields["detail.\(key)"] = value
        }
        return fields
    }

    private func persist() throws {
        try encoder.encode(log).write(to: url, options: .atomic)
    }
}
