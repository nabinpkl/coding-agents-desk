import Foundation
import Testing

@testable import AgentDeskClient

/// End-to-end over the store, not the policy: these assert the WIRING -- that the class is
/// written into each line and that the trim reads it back -- which a policy test cannot see.
@Suite struct ClientDiagnosticsRetentionTests {
    private func makeStore(
        maxRunBytes: Int,
        directory: URL
    ) throws -> ClientDiagnosticsStore {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let configuration = ClientDiagnosticsStoreConfiguration(
            diagnosticsDirectory: directory,
            manifestURL: directory.appendingPathComponent("manifest.json"),
            currentRunURL: directory.appendingPathComponent("current.ndjson"),
            maxEventBytes: 8 * 1024,
            maxRunBytes: maxRunBytes,
            trimLowWaterPercent: 90,
            maxTotalBytes: maxRunBytes * 4,
            maxRuns: 3,
            maxResponseBytes: 768 * 1024,
            maxChunkEncodedBytes: 48 * 1024,
            authMaxSkewSeconds: 60,
            manifestSaveCoalesceMs: 1
        )
        let store = ClientDiagnosticsStore(configuration: configuration)
        store.bootstrap()
        return store
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("diagnostics-retention-\(UUID().uuidString)", isDirectory: true)
    }

    private func storedTypes(in directory: URL) throws -> [String] {
        let data = try Data(contentsOf: directory.appendingPathComponent("current.ndjson"))
        return data.split(separator: 0x0A, omittingEmptySubsequences: true).compactMap { line in
            (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any]
        }.compactMap { $0["type"] as? String }
    }

    // The whole point. One archived run was 69% `mediaLtrAcknowledged` and held exactly two
    // lifecycle events; oldest-first eviction destroyed the two and kept the flood.
    @Test func aStreamFloodCannotEvictTheLifecycleEventsItBuried() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try makeStore(maxRunBytes: 2_000, directory: directory)

        store.record(type: "sessionConnected", fields: ["host": "mac"], level: .default)
        for index in 0..<400 {
            store.record(
                type: "mediaLtrAcknowledged",
                fields: ["token": String(index)],
                level: .default,
                retention: .stream
            )
        }
        store.flush()

        let types = try storedTypes(in: directory)
        #expect(types.contains("sessionConnected"))
        #expect(types.contains("runStarted"))
        // It did have to sacrifice something, or the budget never bit and this proves nothing.
        #expect(types.filter { $0 == "mediaLtrAcknowledged" }.count < 400)
    }

    @Test func everyStoredLineCarriesItsRetentionClassAndAMillisecondTimestamp() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try makeStore(maxRunBytes: 1_000_000, directory: directory)

        store.record(type: "sessionConnected", fields: [:], level: .default)
        store.record(type: "mediaLtrAcknowledged", fields: [:], level: .default, retention: .stream)
        store.flush()

        let data = try Data(contentsOf: directory.appendingPathComponent("current.ndjson"))
        let objects = data.split(separator: 0x0A, omittingEmptySubsequences: true).compactMap {
            (try? JSONSerialization.jsonObject(with: Data($0))) as? [String: Any]
        }
        let classes = Dictionary(
            objects.compactMap { object -> (String, String)? in
                guard let type = object["type"] as? String, let rc = object["rc"] as? String else {
                    return nil
                }
                return (type, rc)
            },
            uniquingKeysWith: { first, _ in first }
        )

        #expect(classes["sessionConnected"] == "l")
        #expect(classes["mediaLtrAcknowledged"] == "s")
        // Seconds could not decompose a nine-second dial. A value this large is only a
        // millisecond epoch; a seconds epoch is three orders of magnitude smaller.
        let timestamps = objects.compactMap { $0["tsMs"] as? Int }
        #expect(timestamps.count == objects.count)
        #expect(timestamps.allSatisfy { $0 > 1_700_000_000_000 })
    }
}
