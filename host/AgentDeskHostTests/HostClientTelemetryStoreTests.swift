import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct HostClientTelemetryStoreTests {
    @Test func storesSecurePayloadAndDetectsAdvancedOrMissingRuns() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = HostClientTelemetryStore(
            rootURL: root,
            maxRunsPerDevice: 3,
            maxBytesPerDevice: 1_024 * 1_024
        )
        let fingerprint = DeviceFingerprint("device:/unsafe")
        let initial = summary(runId: "run/one", byteCount: 10, eventCount: 1)
        let payload = Data(repeating: 0x2a, count: 10)

        #expect(store.needsIngest(initial, fingerprint: fingerprint))
        try store.store(
            CollectedClientDiagnostics(
                summary: initial,
                runPayloads: ["run/one": payload]
            ),
            fingerprint: fingerprint
        )
        #expect(!store.needsIngest(initial, fingerprint: fingerprint))
        #expect(store.needsIngest(
            summary(runId: "run/one", byteCount: 11, eventCount: 2),
            fingerprint: fingerprint
        ))

        let device = root.appendingPathComponent("device__unsafe", isDirectory: true)
        let run = device
            .appendingPathComponent("runs", isDirectory: true)
            .appendingPathComponent("run_one", isDirectory: true)
        #expect(permissions(device) == 0o700)
        #expect(permissions(run) == 0o700)
        #expect(permissions(run.appendingPathComponent("summary.json")) == 0o600)
        #expect(permissions(run.appendingPathComponent("client.ndjson.gz")) == 0o600)

        let missing = summary(runId: "missing-payload", byteCount: 5, eventCount: 1)
        try store.store(
            CollectedClientDiagnostics(summary: missing, runPayloads: [:]),
            fingerprint: fingerprint
        )
        #expect(store.needsIngest(missing, fingerprint: fingerprint))
    }

    @Test func rotatesOldestRunsByCountAndTotalBytes() throws {
        let root = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = HostClientTelemetryStore(
            rootURL: root,
            maxRunsPerDevice: 2,
            maxBytesPerDevice: 7_000
        )
        let fingerprint = DeviceFingerprint("device")

        for index in 0..<4 {
            let runId = "run-\(index)"
            let diagnostics = summary(runId: runId, byteCount: 4_000, eventCount: 1)
            try store.store(
                CollectedClientDiagnostics(
                    summary: diagnostics,
                    runPayloads: [runId: Data(repeating: UInt8(index), count: 4_000)]
                ),
                fingerprint: fingerprint
            )
        }

        let runs = root
            .appendingPathComponent("device", isDirectory: true)
            .appendingPathComponent("runs", isDirectory: true)
        let retained = try FileManager.default.contentsOfDirectory(
            at: runs,
            includingPropertiesForKeys: nil
        )
        #expect(retained.count <= 2)
    }

    private func summary(runId: String, byteCount: Int, eventCount: Int) -> DiagnosticsSummary {
        DiagnosticsSummary(
            requestId: "request",
            runs: [
                DiagnosticsRunSummary(
                    runId: runId,
                    startedAt: 1,
                    cleanShutdown: false,
                    byteCount: byteCount,
                    eventCount: eventCount
                )
            ],
            droppedEvents: 0,
            droppedBytes: 0,
            latestMetricKitPayloadAt: nil
        )
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("host-client-telemetry-\(UUID().uuidString)", isDirectory: true)
    }

    private func permissions(_ url: URL) -> Int? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes?[.posixPermissions] as? NSNumber)?.intValue
    }
}
