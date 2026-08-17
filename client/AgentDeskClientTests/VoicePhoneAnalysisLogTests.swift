import Foundation
import Testing

struct VoicePhoneAnalysisLogTests {
    @Test
    func persistsOrderedAnalyzerStagesAfterEachRecord() throws {
        let root = temporaryRoot(name: "ordered-stages")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        let attemptID = UUID()
        let audioURL = root.appendingPathComponent("audio.caf")
        var writer = try VoicePhoneAnalysisLogWriter(
            attemptID: attemptID,
            audioURL: audioURL,
            modelWeightSHA256: "model-hash",
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            residentMemoryBytes: 1_000
        )

        try writer.record(
            .modelLoadStarted,
            residentMemoryBytes: 2_000,
            details: ["computeUnits": "all"],
            timestamp: Date(timeIntervalSince1970: 1_700_000_001)
        )
        let afterModelLoadStart = try decodeLog(at: root)
        #expect(afterModelLoadStart.events.map(\.stage) == [
            .analysisStarted,
            .modelLoadStarted
        ])

        try writer.record(
            .modelLoaded,
            residentMemoryBytes: 3_000,
            timestamp: Date(timeIntervalSince1970: 1_700_000_002)
        )
        let completed = try decodeLog(at: root)

        #expect(completed.schemaVersion == VoicePhoneAnalysisLog.currentSchemaVersion)
        #expect(completed.attemptID == attemptID)
        #expect(completed.modelWeightSHA256 == "model-hash")
        #expect(completed.events.map(\.stage) == [
            .analysisStarted,
            .modelLoadStarted,
            .modelLoaded
        ])
        #expect(completed.events[1].residentMemoryBytes == 2_000)
        #expect(completed.events[1].details == ["computeUnits": "all"])
    }

    @Test
    func lastPreCrashStageRemainsReadableWithoutFinalEvidence() throws {
        let root = temporaryRoot(name: "pre-crash")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        var writer = try VoicePhoneAnalysisLogWriter(
            attemptID: UUID(),
            audioURL: root.appendingPathComponent("audio.caf"),
            modelWeightSHA256: "model-hash"
        )

        try writer.record(
            .inferenceStarted,
            residentMemoryBytes: 42_000
        )

        let recovered = try decodeLog(at: root)
        #expect(recovered.events.last?.stage == .inferenceStarted)
        #expect(recovered.events.last?.residentMemoryBytes == 42_000)
        #expect(
            !FileManager.default.fileExists(
                atPath: root.appendingPathComponent("phone-evidence.json").path
            )
        )
    }

    @Test
    func analyzerStagesRemainInRemoteDiagnosticsAfterAnUncleanRelaunch() throws {
        let root = temporaryRoot(name: "remote-diagnostics")
        defer { try? FileManager.default.removeItem(at: root) }
        let diagnosticsDirectory = root.appendingPathComponent(
            "Diagnostics",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: diagnosticsDirectory,
            withIntermediateDirectories: true
        )
        let configuration = diagnosticsConfiguration(
            directory: diagnosticsDirectory
        )
        let diagnostics = ClientDiagnosticsStore(configuration: configuration)
        diagnostics.bootstrap()

        let attemptID = UUID()
        var writer = try VoicePhoneAnalysisLogWriter(
            attemptID: attemptID,
            audioURL: root.appendingPathComponent("audio.caf"),
            modelWeightSHA256: "model-hash",
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            residentMemoryBytes: 1_000,
            diagnostics: diagnostics
        )
        try writer.record(
            .vocabularyLoaded,
            residentMemoryBytes: 2_000,
            details: ["vocabularyEntryCount": "392"],
            timestamp: Date(timeIntervalSince1970: 1_700_000_001)
        )

        // Recording is fire-and-forget, so settle the store before the relaunch rotates its
        // file out from under the pending writes.
        diagnostics.flush()

        let relaunchedDiagnostics = ClientDiagnosticsStore(
            configuration: configuration
        )
        relaunchedDiagnostics.bootstrap()
        let archivedRun = try #require(
            FileManager.default.contentsOfDirectory(
                at: diagnosticsDirectory,
                includingPropertiesForKeys: nil
            ).first {
                $0.lastPathComponent.hasPrefix("run-")
                    && $0.pathExtension == "ndjson"
            }
        )
        let events = try diagnosticEvents(at: archivedRun).filter {
            $0.type == VoicePhoneAnalysisLogWriter.diagnosticsEventType
        }

        #expect(events.count == 2)
        #expect(events.map { $0.fields["stage"] } == [
            VoicePhoneAnalysisStage.analysisStarted.rawValue,
            VoicePhoneAnalysisStage.vocabularyLoaded.rawValue
        ])
        #expect(events[1].fields["attemptID"] == attemptID.uuidString.lowercased())
        #expect(events[1].fields["modelHash"] == "model-hash")
        #expect(events[1].fields["residentMemoryBytes"] == "2000")
        #expect(events[1].fields["detail.vocabularyEntryCount"] == "392")
    }

    @Test
    func newRunReplacesThePreviousAttemptLog() throws {
        let root = temporaryRoot(name: "replacement")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        let audioURL = root.appendingPathComponent("audio.caf")
        var first = try VoicePhoneAnalysisLogWriter(
            attemptID: UUID(),
            audioURL: audioURL,
            modelWeightSHA256: "old-model"
        )
        try first.record(.analysisFailed)

        let replacementID = UUID()
        _ = try VoicePhoneAnalysisLogWriter(
            attemptID: replacementID,
            audioURL: audioURL,
            modelWeightSHA256: "new-model"
        )
        let replacement = try decodeLog(at: root)

        #expect(replacement.attemptID == replacementID)
        #expect(replacement.modelWeightSHA256 == "new-model")
        #expect(replacement.events.map(\.stage) == [.analysisStarted])
    }

    private func decodeLog(at root: URL) throws -> VoicePhoneAnalysisLog {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(
            VoicePhoneAnalysisLog.self,
            from: Data(
                contentsOf: root.appendingPathComponent(
                    VoicePhoneAnalysisLogWriter.fileName
                )
            )
        )
    }

    private func temporaryRoot(name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(
            "voice-phone-analysis-log-\(name)-\(UUID().uuidString)",
            isDirectory: true
        )
    }

    private func diagnosticsConfiguration(
        directory: URL
    ) -> ClientDiagnosticsStoreConfiguration {
        ClientDiagnosticsStoreConfiguration(
            diagnosticsDirectory: directory,
            manifestURL: directory.appendingPathComponent(
                "manifest.json",
                isDirectory: false
            ),
            currentRunURL: directory.appendingPathComponent(
                "current.ndjson",
                isDirectory: false
            ),
            maxEventBytes: 8 * 1024,
            maxRunBytes: 2 * 1024 * 1024,
            maxTotalBytes: 6 * 1024 * 1024,
            maxRuns: 3,
            maxResponseBytes: 768 * 1024,
            maxChunkEncodedBytes: 48 * 1024,
            authMaxSkewSeconds: 60,
            manifestSaveCoalesceMs: 0
        )
    }

    private func diagnosticEvents(at url: URL) throws -> [DiagnosticEvent] {
        let decoder = JSONDecoder()
        return try Data(contentsOf: url)
            .split(separator: 0x0A)
            .map { try decoder.decode(DiagnosticEvent.self, from: $0) }
    }

    private struct DiagnosticEvent: Decodable {
        let type: String
        let fields: [String: String]
    }
}
