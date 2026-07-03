import CryptoKit
import Foundation
import OSLog
#if canImport(MetricKit)
import MetricKit
#endif
import zlib
import AgentDeskWire

struct ClientDiagnosticsStoreConfiguration {
    let diagnosticsDirectory: URL
    let manifestURL: URL
    let currentRunURL: URL
    let maxEventBytes: Int
    let maxRunBytes: Int
    let maxTotalBytes: Int
    let maxRuns: Int
    let maxResponseBytes: Int
    let maxChunkEncodedBytes: Int
    let authMaxSkewSeconds: Int

    static let live = ClientDiagnosticsStoreConfiguration(
        diagnosticsDirectory: Config.diagnosticsDirectory,
        manifestURL: Config.diagnosticsManifestURL,
        currentRunURL: Config.diagnosticsCurrentRunURL,
        maxEventBytes: Config.diagnosticsMaxEventBytes,
        maxRunBytes: Config.diagnosticsMaxRunBytes,
        maxTotalBytes: Config.diagnosticsMaxTotalBytes,
        maxRuns: Config.diagnosticsMaxRuns,
        maxResponseBytes: Config.diagnosticsMaxResponseBytes,
        maxChunkEncodedBytes: Config.diagnosticsMaxChunkEncodedBytes,
        authMaxSkewSeconds: Config.diagnosticsAuthMaxSkewSeconds
    )
}

struct ClientDiagnosticsPreparedResponse {
    let summary: DiagnosticsSummary
    let chunks: [DiagnosticsChunk]
    let deliveredRunIds: [String]
}

enum ClientDiagnosticsSendResult {
    case delivered(ClientDiagnosticsPreparedResponse)
    case failed
}

final class ClientDiagnosticsStore: @unchecked Sendable {
    static let shared = ClientDiagnosticsStore()

    private struct Manifest: Codable {
        var current: RunRecord?
        var archives: [RunRecord]
        var droppedEvents: Int
        var droppedBytes: Int
        var latestMetricKitPayloadAt: Int?
    }

    private struct RunRecord: Codable, Equatable {
        var runId: String
        var fileName: String
        var startedAt: Int
        var endedAt: Int?
        var cleanShutdown: Bool
        var retrievedAt: Int?
        var byteCount: Int
        var eventCount: Int
    }

    private struct StoredEvent: Encodable {
        let ts: Int
        let runId: String
        let type: String
        let fields: [String: String]
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "client-diagnostics")
    private let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskClient.diagnostics")
    private let configuration: ClientDiagnosticsStoreConfiguration
    private let fileManager: FileManager
    private let nowProvider: @Sendable () -> Int
    #if canImport(MetricKit)
    private var metricKitSubscriber: ClientDiagnosticsMetricKitSubscriber?
    #endif
    private var manifest = Manifest(
        current: nil,
        archives: [],
        droppedEvents: 0,
        droppedBytes: 0,
        latestMetricKitPayloadAt: nil
    )
    private var bootstrapped = false
    private var seenFallbackNonces: Set<String> = []

    init(
        configuration: ClientDiagnosticsStoreConfiguration = .live,
        fileManager: FileManager = .default,
        nowProvider: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970) }
    ) {
        self.configuration = configuration
        self.fileManager = fileManager
        self.nowProvider = nowProvider
    }

    func bootstrap() {
        queue.sync {
            guard !bootstrapped else { return }
            bootstrapped = true
            ensureDiagnosticsDirectory()
            loadManifest()
            let priorUncleanRunId = rotatePriorCurrentRunIfPresent()
            startNewCurrentRun()
            recordLocked(type: "runStarted", fields: Self.buildIdentityFields(), level: .default)
            if let priorUncleanRunId {
                recordLocked(type: "previousRunUncleanExit", fields: ["priorRunId": priorUncleanRunId], level: .error)
            }
            saveManifest()
        }
        #if canImport(MetricKit)
        registerMetricKitSubscriber()
        #endif
    }

    func record(type: String, fields: [String: String], level: OSLogType = .default) {
        queue.sync {
            guard bootstrapped else { return }
            recordLocked(type: type, fields: fields, level: level)
            saveManifest()
        }
    }

    private static func buildIdentityFields() -> [String: String] {
        let info = Bundle.main.infoDictionary
        return [
            "bundleId": Bundle.main.bundleIdentifier ?? "?",
            "version": info?["CFBundleShortVersionString"] as? String ?? "?",
            "build": info?["CFBundleVersion"] as? String ?? "?",
            "gitSha": (info?["AgentDeskGitSHA"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "dev"
        ]
    }

    func markCleanShutdown(reason: String) {
        queue.sync {
            guard bootstrapped, manifest.current != nil else { return }
            recordLocked(type: "runCleanShutdown", fields: ["reason": reason], level: .default)
            manifest.current?.cleanShutdown = true
            manifest.current?.endedAt = now()
            saveManifest()
        }
    }

    func validateFallbackRequest(_ request: SignedDiagnosticsRequest, record: StoredPairingRecord?) -> Bool {
        queue.sync {
            guard bootstrapped,
                  let record,
                  record.token.hostFingerprint == request.hostFingerprint else {
                return false
            }
            let skew = abs(now() - request.issuedAt)
            guard skew <= configuration.authMaxSkewSeconds else {
                return false
            }
            let nonceKey = request.nonce.base64URLEncodedString()
            guard !seenFallbackNonces.contains(nonceKey) else {
                return false
            }
            let publicKey: P256.Signing.PublicKey
            let signature: P256.Signing.ECDSASignature
            do {
                publicKey = try P256.Signing.PublicKey(x963Representation: record.hostPublicKey)
                signature = try P256.Signing.ECDSASignature(rawRepresentation: request.hostSignature)
            } catch {
                return false
            }
            guard let signingData = try? DiagnosticsRequestSignature.signingData(
                request: request.request,
                hostFingerprint: request.hostFingerprint,
                issuedAt: request.issuedAt,
                nonce: request.nonce
            ),
            publicKey.isValidSignature(signature, for: signingData) else {
                return false
            }
            seenFallbackNonces.insert(nonceKey)
            return true
        }
    }

    func reconnectAnnouncementSummary() -> DiagnosticsSummary? {
        queue.sync {
            guard bootstrapped,
                  let currentRun = manifest.current else {
                return nil
            }
            let pending = manifest.archives
                .filter { !$0.cleanShutdown && $0.retrievedAt == nil }
                .sorted { $0.startedAt < $1.startedAt }
            guard !pending.isEmpty else { return nil }
            return DiagnosticsSummary(
                requestId: "announce-\(currentRun.runId)",
                runs: pending.map(makeRunSummary),
                droppedEvents: manifest.droppedEvents,
                droppedBytes: manifest.droppedBytes,
                latestMetricKitPayloadAt: manifest.latestMetricKitPayloadAt
            )
        }
    }

    func prepareResponse(for request: DiagnosticsRequest) -> Result<ClientDiagnosticsPreparedResponse, DiagnosticsError> {
        queue.sync {
            guard bootstrapped else {
                return .failure(DiagnosticsError(requestId: request.requestId, reason: "diagnostics-unavailable"))
            }
            let cap = min(request.maxBytes ?? configuration.maxResponseBytes, configuration.maxResponseBytes)
            guard cap > 0 else {
                return .failure(DiagnosticsError(requestId: request.requestId, reason: "invalid-max-bytes"))
            }
            let runs = selectedRuns(for: request)
            let summary = DiagnosticsSummary(
                requestId: request.requestId,
                runs: runs.map(makeRunSummary),
                droppedEvents: manifest.droppedEvents,
                droppedBytes: manifest.droppedBytes,
                latestMetricKitPayloadAt: manifest.latestMetricKitPayloadAt
            )
            var chunks: [DiagnosticsChunk] = []
            var deliveredRunIds: [String] = []
            var totalCompressedBytes = 0
            var sequence = 0
            for run in runs {
                let sourceData: Data
                do {
                    sourceData = try Data(contentsOf: url(for: run))
                } catch {
                    return .failure(DiagnosticsError(requestId: request.requestId, reason: "diagnostics-read-failed"))
                }
                let remaining = cap - totalCompressedBytes
                guard remaining > 0 else {
                    return .failure(DiagnosticsError(requestId: request.requestId, reason: "diagnostics-cap-too-small"))
                }
                guard let bounded = boundedCompressedTail(sourceData: sourceData, remainingBytes: remaining) else {
                    return .failure(DiagnosticsError(requestId: request.requestId, reason: "diagnostics-cap-too-small"))
                }
                let chunkPayloadLimit = max(1, (configuration.maxChunkEncodedBytes * 3) / 4)
                var offset = 0
                if bounded.compressed.isEmpty {
                    chunks.append(DiagnosticsChunk(
                        requestId: request.requestId,
                        sequence: sequence,
                        isFinal: false,
                        runId: run.runId,
                        uncompressedBytes: bounded.uncompressedBytes,
                        payloadBase64: ""
                    ))
                    sequence += 1
                }
                while offset < bounded.compressed.count {
                    let next = min(offset + chunkPayloadLimit, bounded.compressed.count)
                    let payload = bounded.compressed.subdata(in: offset..<next).base64EncodedString()
                    chunks.append(DiagnosticsChunk(
                        requestId: request.requestId,
                        sequence: sequence,
                        isFinal: false,
                        runId: run.runId,
                        uncompressedBytes: bounded.uncompressedBytes,
                        payloadBase64: payload
                    ))
                    sequence += 1
                    offset = next
                }
                totalCompressedBytes += bounded.compressed.count
                if request.includePreviousRuns, run.fileName != manifest.current?.fileName {
                    deliveredRunIds.append(run.runId)
                }
            }
            if let last = chunks.indices.last {
                chunks[last] = DiagnosticsChunk(
                    requestId: chunks[last].requestId,
                    sequence: chunks[last].sequence,
                    isFinal: true,
                    runId: chunks[last].runId,
                    uncompressedBytes: chunks[last].uncompressedBytes,
                    payloadBase64: chunks[last].payloadBase64
                )
            }
            return .success(ClientDiagnosticsPreparedResponse(
                summary: summary,
                chunks: chunks,
                deliveredRunIds: deliveredRunIds
            ))
        }
    }

    func completeResponse(_ response: ClientDiagnosticsPreparedResponse) {
        queue.sync {
            guard bootstrapped, !response.deliveredRunIds.isEmpty else { return }
            let delivered = Set(response.deliveredRunIds)
            let retrievedAt = now()
            for index in manifest.archives.indices where delivered.contains(manifest.archives[index].runId) {
                manifest.archives[index].retrievedAt = retrievedAt
            }
            saveManifest()
        }
    }

    #if canImport(MetricKit)
    func recordMetricKitPayloads(_ payloads: [MXDiagnosticPayload]) {
        queue.sync {
            guard bootstrapped else { return }
            for payload in payloads {
                let latest = Int(payload.timeStampEnd.timeIntervalSince1970)
                manifest.latestMetricKitPayloadAt = max(manifest.latestMetricKitPayloadAt ?? 0, latest)
                let fields: [String: String] = [
                    "timeStampBegin": iso8601(payload.timeStampBegin),
                    "timeStampEnd": iso8601(payload.timeStampEnd),
                    "crashCount": String(payload.crashDiagnostics?.count ?? 0),
                    "hangCount": String(payload.hangDiagnostics?.count ?? 0),
                    "cpuExceptionCount": String(payload.cpuExceptionDiagnostics?.count ?? 0),
                    "diskWriteExceptionCount": String(payload.diskWriteExceptionDiagnostics?.count ?? 0),
                    "appLaunchCount": String(payload.appLaunchDiagnostics?.count ?? 0)
                ]
                recordLocked(type: "metricKitDiagnostics", fields: fields, level: .default)
            }
            saveManifest()
        }
    }
    #endif

    private func registerMetricKitSubscriber() {
        #if canImport(MetricKit)
        guard metricKitSubscriber == nil else { return }
        let subscriber = ClientDiagnosticsMetricKitSubscriber(store: self)
        metricKitSubscriber = subscriber
        MXMetricManager.shared.add(subscriber)
        if !MXMetricManager.shared.pastDiagnosticPayloads.isEmpty {
            recordMetricKitPayloads(MXMetricManager.shared.pastDiagnosticPayloads)
        }
        #endif
    }

    private func ensureDiagnosticsDirectory() {
        do {
            try fileManager.createDirectory(
                at: configuration.diagnosticsDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            logger.error("diagnostics directory create failed: \(String(describing: error), privacy: .public)")
            return
        }
        applyFileProtectionBestEffort(to: configuration.diagnosticsDirectory)
    }

    private func applyFileProtectionBestEffort(to url: URL) {
        do {
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path
            )
        } catch {
            logger.notice("diagnostics file protection unavailable path=\(url.path, privacy: .public) error=\(String(describing: error), privacy: .public)")
        }
    }

    private func loadManifest() {
        guard let data = try? Data(contentsOf: configuration.manifestURL),
              let decoded = try? JSONDecoder().decode(Manifest.self, from: data) else {
            manifest = Manifest(current: nil, archives: [], droppedEvents: 0, droppedBytes: 0, latestMetricKitPayloadAt: nil)
            return
        }
        manifest = decoded
    }

    @discardableResult
    private func rotatePriorCurrentRunIfPresent() -> String? {
        guard var prior = manifest.current else { return nil }
        let hadUncleanExit = !prior.cleanShutdown
        let currentURL = configuration.currentRunURL
        if fileManager.fileExists(atPath: currentURL.path) {
            let archivedName = archivedFileName(for: prior.runId)
            let archivedURL = configuration.diagnosticsDirectory.appendingPathComponent(archivedName, isDirectory: false)
            try? fileManager.removeItem(at: archivedURL)
            do {
                try fileManager.moveItem(at: currentURL, to: archivedURL)
            } catch {
                logger.error("diagnostics rotate failed: \(String(describing: error), privacy: .public)")
            }
            prior.fileName = archivedName
        }
        prior.endedAt = prior.endedAt ?? now()
        manifest.archives.append(prior)
        manifest.current = nil
        enforceArchiveRetention()
        return hadUncleanExit ? prior.runId : nil
    }

    private func startNewCurrentRun() {
        let runId = UUID().uuidString.lowercased()
        createEmptyCurrentFile()
        manifest.current = RunRecord(
            runId: runId,
            fileName: configuration.currentRunURL.lastPathComponent,
            startedAt: now(),
            endedAt: nil,
            cleanShutdown: false,
            retrievedAt: nil,
            byteCount: 0,
            eventCount: 0
        )
    }

    private func createEmptyCurrentFile() {
        _ = fileManager.createFile(atPath: configuration.currentRunURL.path, contents: Data())
        applyFileProtectionBestEffort(to: configuration.currentRunURL)
    }

    private func recordLocked(type: String, fields: [String: String], level: OSLogType) {
        guard var current = manifest.current else { return }
        let sanitizedFields = sanitize(fields: fields)
        let line = encodeLine(type: type, runId: current.runId, fields: sanitizedFields)
        appendLine(line, to: configuration.currentRunURL)
        current.byteCount += line.count
        current.eventCount += 1
        manifest.current = current
        trimCurrentRunIfNeeded()
        enforceArchiveRetention()
        mirrorToLogger(type: type, fields: sanitizedFields, level: level)
    }

    private func trimCurrentRunIfNeeded() {
        guard var current = manifest.current,
              current.byteCount > configuration.maxRunBytes,
              let data = try? Data(contentsOf: configuration.currentRunURL) else {
            return
        }
        let lines = splitNDJSON(data)
        let trimmed = trimLinesToLimit(lines, limit: configuration.maxRunBytes)
        guard trimmed.droppedCount > 0 else { return }
        writeLines(trimmed.keptLines, to: configuration.currentRunURL)
        current.byteCount = trimmed.totalBytes
        current.eventCount = trimmed.keptLines.count
        manifest.current = current
        manifest.droppedEvents += trimmed.droppedCount
        manifest.droppedBytes += trimmed.droppedBytes
    }

    private func enforceArchiveRetention() {
        manifest.archives.sort { $0.startedAt < $1.startedAt }
        while manifest.archives.count >= configuration.maxRuns {
            dropOldestArchive()
        }
        while totalStoredBytes() > configuration.maxTotalBytes, !manifest.archives.isEmpty {
            dropOldestArchive()
        }
    }

    private func dropOldestArchive() {
        guard !manifest.archives.isEmpty else { return }
        let removed = manifest.archives.removeFirst()
        let url = url(for: removed)
        if let attributes = try? fileManager.attributesOfItem(atPath: url.path),
           let size = attributes[.size] as? NSNumber {
            manifest.droppedBytes += size.intValue
        }
        manifest.droppedEvents += removed.eventCount
        try? fileManager.removeItem(at: url)
    }

    private func totalStoredBytes() -> Int {
        let archiveBytes = manifest.archives.reduce(0) { partial, record in
            partial + fileSize(url(for: record))
        }
        let currentBytes = manifest.current.map { fileSize(url(for: $0)) } ?? 0
        return archiveBytes + currentBytes
    }

    private func fileSize(_ url: URL) -> Int {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else {
            return 0
        }
        return size.intValue
    }

    private func saveManifest() {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(manifest)
            try data.write(to: configuration.manifestURL, options: .atomic)
            applyFileProtectionBestEffort(to: configuration.manifestURL)
        } catch {
            logger.error("diagnostics manifest save failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func appendLine(_ line: Data, to url: URL) {
        guard let handle = try? FileHandle(forWritingTo: url) else {
            createEmptyCurrentFile()
            guard let retry = try? FileHandle(forWritingTo: url) else { return }
            _ = try? retry.seekToEnd()
            try? retry.write(contentsOf: line)
            try? retry.close()
            return
        }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: line)
        try? handle.close()
    }

    private func encodeLine(type: String, runId: String, fields: [String: String]) -> Data {
        let event = StoredEvent(ts: now(), runId: runId, type: type, fields: fields)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if let data = try? encoder.encode(event), data.count + 1 <= configuration.maxEventBytes {
            return data + Data([0x0A])
        }
        let truncatedFields = [
            "truncated": "true",
            "originalType": type,
            "originalBytes": String((try? encoder.encode(event).count) ?? 0)
        ]
        let truncatedEvent = StoredEvent(ts: now(), runId: runId, type: type, fields: truncatedFields)
        let data = (try? encoder.encode(truncatedEvent)) ?? Data("{}".utf8)
        return data + Data([0x0A])
    }

    private func sanitize(fields: [String: String]) -> [String: String] {
        var sanitized: [String: String] = [:]
        sanitized.reserveCapacity(fields.count)
        for (key, value) in fields {
            let lowered = key.lowercased()
            if lowered.contains("token") ||
                lowered.contains("secret") ||
                lowered.contains("signature") ||
                lowered.contains("pairing") ||
                lowered.contains("nonce") ||
                lowered.contains("payload") ||
                lowered.contains("url") {
                sanitized[key] = "[redacted]"
                continue
            }
            sanitized[key] = value
                .replacingOccurrences(of: #"agentdesk://\S+"#, with: "[redacted-pairing-url]", options: .regularExpression)
                .replacingOccurrences(of: #"https?://\S*pair\S*"#, with: "[redacted-url]", options: .regularExpression)
        }
        return sanitized
    }

    private func mirrorToLogger(type: String, fields: [String: String], level: OSLogType) {
        let details = fields.keys.sorted().compactMap { key in
            fields[key].map { "\(key)=\($0)" }
        }.joined(separator: " ")
        let message = details.isEmpty ? type : "\(type) \(details)"
        switch level {
        case .debug:
            logger.debug("\(message, privacy: .public)")
        case .info:
            logger.info("\(message, privacy: .public)")
        case .error:
            logger.error("\(message, privacy: .public)")
        case .fault:
            logger.fault("\(message, privacy: .public)")
        default:
            logger.notice("\(message, privacy: .public)")
        }
    }

    private func selectedRuns(for request: DiagnosticsRequest) -> [RunRecord] {
        var runs: [RunRecord] = []
        if request.includePreviousRuns {
            runs.append(contentsOf: manifest.archives.sorted { $0.startedAt < $1.startedAt })
        }
        if let current = manifest.current {
            runs.append(current)
        }
        if let sinceRunId = request.sinceRunId,
           let index = runs.firstIndex(where: { $0.runId == sinceRunId }) {
            return Array(runs.suffix(from: runs.index(after: index)))
        }
        if request.includePreviousRuns {
            return runs
        }
        return manifest.current.map { [$0] } ?? []
    }

    private func makeRunSummary(_ run: RunRecord) -> DiagnosticsRunSummary {
        DiagnosticsRunSummary(
            runId: run.runId,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            cleanShutdown: run.cleanShutdown,
            byteCount: fileSize(url(for: run)),
            eventCount: run.eventCount
        )
    }

    private func boundedCompressedTail(sourceData: Data, remainingBytes: Int) -> (compressed: Data, uncompressedBytes: Int)? {
        guard let fullCompressed = try? DiagnosticsGzip.compress(sourceData) else {
            return nil
        }
        if fullCompressed.count <= remainingBytes {
            return (fullCompressed, sourceData.count)
        }
        let lines = splitNDJSON(sourceData)
        guard !lines.isEmpty else { return nil }
        var low = 0
        var high = lines.count - 1
        var best: (compressed: Data, uncompressedBytes: Int)?
        while low <= high {
            let mid = (low + high) / 2
            let candidate = joinedLines(Array(lines[mid...]))
            guard let compressed = try? DiagnosticsGzip.compress(candidate) else { return nil }
            if compressed.count <= remainingBytes {
                best = (compressed, candidate.count)
                if mid == 0 { break }
                high = mid - 1
            } else {
                low = mid + 1
            }
        }
        return best
    }

    private func url(for run: RunRecord) -> URL {
        configuration.diagnosticsDirectory.appendingPathComponent(run.fileName, isDirectory: false)
    }

    private func archivedFileName(for runId: String) -> String {
        "run-\(runId).ndjson"
    }

    private func now() -> Int {
        nowProvider()
    }

    private func iso8601(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    private func splitNDJSON(_ data: Data) -> [Data] {
        data.split(separator: 0x0A, omittingEmptySubsequences: true).map { Data($0) }
    }

    private func joinedLines(_ lines: [Data]) -> Data {
        var joined = Data()
        for line in lines {
            joined.append(line)
            joined.append(0x0A)
        }
        return joined
    }

    private func trimLinesToLimit(_ lines: [Data], limit: Int) -> (keptLines: [Data], totalBytes: Int, droppedCount: Int, droppedBytes: Int) {
        guard !lines.isEmpty else { return ([], 0, 0, 0) }
        var kept = lines
        var total = joinedLines(kept).count
        var droppedCount = 0
        var droppedBytes = 0
        while total > limit, !kept.isEmpty {
            let removed = kept.removeFirst()
            droppedCount += 1
            droppedBytes += removed.count + 1
            total -= removed.count + 1
        }
        return (kept, max(total, 0), droppedCount, droppedBytes)
    }

    private func writeLines(_ lines: [Data], to url: URL) {
        let data = joinedLines(lines)
        try? data.write(to: url, options: .atomic)
        applyFileProtectionBestEffort(to: url)
    }
}

enum ClientDiagnostics {
    static let shared = ClientDiagnosticsStore.shared
}

private enum DiagnosticsGzip {
    enum Error: Swift.Error {
        case initFailed(Int32)
        case processFailed(Int32)
        case finishFailed(Int32)
    }

    static func compress(_ data: Data) throws -> Data {
        if data.isEmpty {
            return Data([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0])
        }
        var stream = z_stream()
        let initResult = deflateInit2_(
            &stream,
            Z_DEFAULT_COMPRESSION,
            Z_DEFLATED,
            MAX_WBITS + 16,
            MAX_MEM_LEVEL,
            Z_DEFAULT_STRATEGY,
            ZLIB_VERSION,
            Int32(MemoryLayout<z_stream>.size)
        )
        guard initResult == Z_OK else {
            throw Error.initFailed(initResult)
        }
        defer { deflateEnd(&stream) }
        var compressed = Data()
        let chunkSize = 16_384
        var outputBuffer = [UInt8](repeating: 0, count: chunkSize)
        let status = data.withUnsafeBytes { inputBuffer -> Int32 in
            guard let inputBase = inputBuffer.bindMemory(to: Bytef.self).baseAddress else {
                return Z_STREAM_END
            }
            stream.next_in = UnsafeMutablePointer<Bytef>(mutating: inputBase)
            stream.avail_in = uInt(data.count)
            var status: Int32 = Z_OK
            repeat {
                stream.next_out = outputBuffer.withUnsafeMutableBufferPointer { $0.baseAddress }
                stream.avail_out = uInt(chunkSize)
                status = deflate(&stream, Z_FINISH)
                let produced = chunkSize - Int(stream.avail_out)
                if produced > 0 {
                    compressed.append(outputBuffer, count: produced)
                }
            } while status == Z_OK
            return status
        }
        guard status == Z_STREAM_END else {
            throw Error.finishFailed(status)
        }
        return compressed
    }
}

#if canImport(MetricKit)
private final class ClientDiagnosticsMetricKitSubscriber: NSObject, MXMetricManagerSubscriber {
    private weak var store: ClientDiagnosticsStore?

    init(store: ClientDiagnosticsStore) {
        self.store = store
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        store?.recordMetricKitPayloads(payloads)
    }
}
#endif
