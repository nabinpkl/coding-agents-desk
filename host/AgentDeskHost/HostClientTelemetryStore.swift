import Foundation
import OSLog
import AgentDeskWire

struct HostClientTelemetryTimelineEvent: Codable, Equatable {
    enum Kind: String, Codable {
        case sessionReady
        case inputLaneReady
        case inputLaneClosed
        case firstFrameSent
        case firstFrameAcknowledged
        case clientCheckpoint
        case automaticIngestStarted
        case automaticIngestCompleted
        case automaticIngestFailed
    }

    let hostReceivedAt: Int
    let deviceFingerprint: String
    let kind: Kind
    let sessionId: String?
    let frameId: UInt64?
    let checkpoint: ClientRuntimeCheckpoint?
    let clientRunId: String?
    let errorCode: String?
}

/// Host-retained cache of client-authored diagnostics and low-rate checkpoints.
/// Client files stay authoritative; cached copies are immutable incident evidence.
final class HostClientTelemetryStore: @unchecked Sendable {
    private let rootURL: URL
    private let fileManager: FileManager
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).client-telemetry")
    private let now: @Sendable () -> Int
    private let maxRunsPerDevice: Int
    private let maxBytesPerDevice: Int
    private let logger = Logger(subsystem: Config.logSubsystem, category: "client-telemetry")

    init(
        rootURL: URL = Config.clientTelemetryDirectory,
        fileManager: FileManager = .default,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) },
        maxRunsPerDevice: Int = Config.clientTelemetryMaxRunsPerDevice,
        maxBytesPerDevice: Int = Config.clientTelemetryMaxBytesPerDevice
    ) {
        self.rootURL = rootURL
        self.fileManager = fileManager
        self.now = now
        self.maxRunsPerDevice = max(1, maxRunsPerDevice)
        self.maxBytesPerDevice = max(1, maxBytesPerDevice)
    }

    func needsIngest(_ summary: DiagnosticsSummary, fingerprint: DeviceFingerprint) -> Bool {
        queue.sync {
            summary.runs.contains { incoming in
                guard let cached = cachedSummary(
                    runId: incoming.runId,
                    fingerprint: fingerprint
                ) else {
                    return true
                }
                let payloadURL = runDirectory(runId: incoming.runId, fingerprint: fingerprint)
                    .appendingPathComponent("client.ndjson.gz")
                return !fileManager.fileExists(atPath: payloadURL.path)
                    || cached.byteCount != incoming.byteCount
                    || cached.eventCount != incoming.eventCount
                    || cached.cleanShutdown != incoming.cleanShutdown
                    || cached.endedAt != incoming.endedAt
            }
        }
    }

    func store(_ collected: CollectedClientDiagnostics, fingerprint: DeviceFingerprint) throws {
        try queue.sync {
            let deviceRoot = try securedDirectory(deviceDirectory(fingerprint))
            let runsRoot = try securedDirectory(
                deviceRoot.appendingPathComponent("runs", isDirectory: true)
            )
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            for run in collected.summary.runs {
                let runDirectory = try securedDirectory(
                    runsRoot.appendingPathComponent(safeComponent(run.runId), isDirectory: true)
                )
                let summaryURL = runDirectory.appendingPathComponent("summary.json")
                try securedWrite(encoder.encode(run), to: summaryURL)
                if let payload = collected.runPayloads[run.runId] {
                    try securedWrite(
                        payload,
                        to: runDirectory.appendingPathComponent("client.ndjson.gz")
                    )
                }
            }
            try rotateRuns(in: runsRoot)
        }
    }

    func recordCheckpoint(_ checkpoint: ClientRuntimeCheckpoint, fingerprint: DeviceFingerprint) {
        append(HostClientTelemetryTimelineEvent(
            hostReceivedAt: now(),
            deviceFingerprint: fingerprint.rawValue,
            kind: .clientCheckpoint,
            sessionId: nil,
            frameId: nil,
            checkpoint: checkpoint,
            clientRunId: checkpoint.clientRunId,
            errorCode: nil
        ), fingerprint: fingerprint)
    }

    func record(
        _ kind: HostClientTelemetryTimelineEvent.Kind,
        fingerprint: DeviceFingerprint,
        sessionId: String? = nil,
        frameId: UInt64? = nil,
        clientRunId: String? = nil,
        errorCode: String? = nil
    ) {
        append(HostClientTelemetryTimelineEvent(
            hostReceivedAt: now(),
            deviceFingerprint: fingerprint.rawValue,
            kind: kind,
            sessionId: sessionId,
            frameId: frameId,
            checkpoint: nil,
            clientRunId: clientRunId,
            errorCode: errorCode.map { String($0.prefix(120)) }
        ), fingerprint: fingerprint)
    }

    private func append(
        _ event: HostClientTelemetryTimelineEvent,
        fingerprint: DeviceFingerprint
    ) {
        queue.sync {
            do {
                let directory = try self.securedDirectory(self.deviceDirectory(fingerprint))
                let url = directory.appendingPathComponent("timeline.ndjson")
                var line = try JSONEncoder().encode(event)
                line.append(0x0A)
                if !self.fileManager.fileExists(atPath: url.path) {
                    self.fileManager.createFile(atPath: url.path, contents: Data())
                }
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: line)
                try self.fileManager.setAttributes(
                    [.posixPermissions: 0o600],
                    ofItemAtPath: url.path
                )
            } catch {
                self.logger.error(
                    "client telemetry timeline append failed error=\(String(describing: error), privacy: .public)"
                )
            }
        }
    }

    private func cachedSummary(
        runId: String,
        fingerprint: DeviceFingerprint
    ) -> DiagnosticsRunSummary? {
        let url = runDirectory(runId: runId, fingerprint: fingerprint)
            .appendingPathComponent("summary.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(DiagnosticsRunSummary.self, from: data)
    }

    private func rotateRuns(in runsRoot: URL) throws {
        let directories = try fileManager.contentsOfDirectory(
            at: runsRoot,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ).sorted {
            let lhs = (try? $0.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? .distantPast
            let rhs = (try? $1.resourceValues(forKeys: [.contentModificationDateKey])
                .contentModificationDate) ?? .distantPast
            return lhs < rhs
        }
        var retained = directories
        while true {
            let exceedsCount = retained.count > maxRunsPerDevice
            let exceedsBytes = try totalAllocatedBytes(in: retained) > maxBytesPerDevice
            guard exceedsCount || exceedsBytes else { break }
            guard let oldest = retained.first else { break }
            try fileManager.removeItem(at: oldest)
            retained.removeFirst()
        }
    }

    private func totalAllocatedBytes(in directories: [URL]) throws -> Int {
        try directories.reduce(into: 0) { total, directory in
            guard let enumerator = fileManager.enumerator(
                at: directory,
                includingPropertiesForKeys: [.fileAllocatedSizeKey, .isRegularFileKey]
            ) else { return }
            for case let url as URL in enumerator {
                let values = try url.resourceValues(forKeys: [.fileAllocatedSizeKey, .isRegularFileKey])
                if values.isRegularFile == true {
                    total += values.fileAllocatedSize ?? 0
                }
            }
        }
    }

    private func deviceDirectory(_ fingerprint: DeviceFingerprint) -> URL {
        rootURL.appendingPathComponent(safeComponent(fingerprint.rawValue), isDirectory: true)
    }

    private func runDirectory(runId: String, fingerprint: DeviceFingerprint) -> URL {
        deviceDirectory(fingerprint)
            .appendingPathComponent("runs", isDirectory: true)
            .appendingPathComponent(safeComponent(runId), isDirectory: true)
    }

    private func safeComponent(_ raw: String) -> String {
        let accepted = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        return String(raw.unicodeScalars.map { accepted.contains($0) ? Character(String($0)) : "_" })
    }

    @discardableResult
    private func securedDirectory(_ url: URL) throws -> URL {
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }

    private func securedWrite(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
