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
    let trimLowWaterPercent: Int
    let maxTotalBytes: Int
    let maxRuns: Int
    let maxResponseBytes: Int
    let maxChunkEncodedBytes: Int
    let authMaxSkewSeconds: Int
    let manifestSaveCoalesceMs: Int

    static let live = ClientDiagnosticsStoreConfiguration(
        diagnosticsDirectory: Config.diagnosticsDirectory,
        manifestURL: Config.diagnosticsManifestURL,
        currentRunURL: Config.diagnosticsCurrentRunURL,
        maxEventBytes: Config.diagnosticsMaxEventBytes,
        maxRunBytes: Config.diagnosticsMaxRunBytes,
        trimLowWaterPercent: Config.diagnosticsTrimLowWaterPercent,
        maxTotalBytes: Config.diagnosticsMaxTotalBytes,
        maxRuns: Config.diagnosticsMaxRuns,
        maxResponseBytes: Config.diagnosticsMaxResponseBytes,
        maxChunkEncodedBytes: Config.diagnosticsMaxChunkEncodedBytes,
        authMaxSkewSeconds: Config.diagnosticsAuthMaxSkewSeconds,
        manifestSaveCoalesceMs: Config.diagnosticsManifestSaveCoalesceMs
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
    typealias AnnouncementSender = @Sendable (DiagnosticsSummary) async throws -> Void

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
        /// Milliseconds, and named for it. Seconds could not decompose a nine-second dial, and
        /// a unit change under an unchanged `ts` would have been invisible to every reader.
        let tsMs: Int
        let runId: String
        let type: String
        let fields: [String: String]
        let rc: DiagnosticsRetention
    }

    /// Just enough of a stored line to decide whether the budget may sacrifice it.
    private struct StoredEventClass: Decodable {
        let rc: DiagnosticsRetention
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: Config.diagnosticsLogCategory)
    private let queue = DispatchQueue(label: "\(Config.bundleIdentifier).diagnostics")
    private let configuration: ClientDiagnosticsStoreConfiguration
    private let fileManager: FileManager
    private let nowMsProvider: @Sendable () -> Int
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
    private var seenFallbackNonces: [String: Int] = [:]
    private var announcementSender: AnnouncementSender?
    /// Manifest state changed in memory but has not reached disk yet. Guarded by `queue`.
    private var manifestDirty = false
    private var manifestSaveScheduled = false

    init(
        configuration: ClientDiagnosticsStoreConfiguration = .live,
        fileManager: FileManager = .default,
        nowMsProvider: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.configuration = configuration
        self.fileManager = fileManager
        self.nowMsProvider = nowMsProvider
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

    /// Fire-and-forget: recording must never block the caller.
    ///
    /// This was `queue.sync` with a `saveManifest()` per event, which put an NDJSON append,
    /// a stat of every stored file, and an ATOMIC manifest write (temp file plus rename) on
    /// the calling thread. Both hot callers are the main thread: the video sink records per
    /// frame (LTR acknowledgements, presentation skips, window summaries) and a settings
    /// slider records twice per `valueChanged` tick. Measured at 3.45ms of main-thread block
    /// per slider tick on a Mac SSD, which is ~41% of the thread while dragging at 120Hz,
    /// and iPhone flash is slower. The two paths also serialized against each other on this
    /// one queue, which is why settings felt worse while video was busy.
    ///
    /// Async is safe for ordering and for readers: the queue is serial, so events land in
    /// call order and every reader below (`queue.sync`) sees all prior writes. The cost is
    /// that an abrupt kill can lose the last few events, which a crash could already do.
    /// - Parameter atMs: when the event HAPPENED, for events that did not happen just now.
    ///   Only the unified-log drain passes it, and it has to: entries harvested seconds late
    ///   would otherwise all be stamped with the drain and lose their order against each other
    ///   and against everything the store recorded natively.
    func record(
        type: String,
        fields: [String: String],
        level: OSLogType = .default,
        retention: DiagnosticsRetention = .lifecycle,
        atMs: Int? = nil
    ) {
        // Strong self on purpose: a weak capture would silently drop the tail of the log if
        // the store went away with writes still queued, and losing exactly the last events
        // before a teardown is losing the ones worth reading.
        queue.async {
            guard self.bootstrapped else { return }
            self.recordLocked(
                type: type,
                fields: fields,
                level: level,
                retention: retention,
                atMs: atMs
            )
            self.scheduleManifestSave()
        }
    }

    /// Drain every pending record and put the manifest on disk.
    ///
    /// `record` is fire-and-forget, so anything that needs the store settled -- app
    /// backgrounding (iOS kills suspended apps without warning), or a test about to read the
    /// files directly -- asks here. The `queue.sync` is the drain: the queue is serial, so
    /// returning from it means every earlier `record` has been written.
    func flush() {
        queue.sync { saveManifestIfDirty() }
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
            validateFallbackEnvelope(
                hostFingerprint: request.hostFingerprint,
                issuedAt: request.issuedAt,
                nonce: request.nonce,
                signatureData: request.hostSignature,
                record: record
            ) {
                try DiagnosticsRequestSignature.signingData(
                    request: request.request,
                    hostFingerprint: request.hostFingerprint,
                    issuedAt: request.issuedAt,
                    nonce: request.nonce
                )
            }
        }
    }

    func validateFallbackRequest(_ request: SignedClientScreenshotRequest, record: StoredPairingRecord?) -> Bool {
        queue.sync {
            validateFallbackEnvelope(
                hostFingerprint: request.hostFingerprint,
                issuedAt: request.issuedAt,
                nonce: request.nonce,
                signatureData: request.hostSignature,
                record: record
            ) {
                try ClientScreenshotRequestSignature.signingData(
                    request: request.request,
                    hostFingerprint: request.hostFingerprint,
                    issuedAt: request.issuedAt,
                    nonce: request.nonce
                )
            }
        }
    }

    private func validateFallbackEnvelope(
        hostFingerprint: String,
        issuedAt: Int,
        nonce: Data,
        signatureData: Data,
        record: StoredPairingRecord?,
        signingData: () throws -> Data
    ) -> Bool {
        guard bootstrapped,
              let record,
              record.token.hostFingerprint == hostFingerprint else {
            return false
        }
        let currentTime = now()
        let skew = abs(currentTime - issuedAt)
        guard skew <= configuration.authMaxSkewSeconds else {
            return false
        }
        seenFallbackNonces = seenFallbackNonces.filter {
            abs(currentTime - $0.value) <= configuration.authMaxSkewSeconds
        }
        let nonceKey = nonce.base64URLEncodedString()
        guard seenFallbackNonces[nonceKey] == nil else {
            return false
        }
        let publicKey: P256.Signing.PublicKey
        let signature: P256.Signing.ECDSASignature
        do {
            publicKey = try P256.Signing.PublicKey(x963Representation: record.hostPublicKey)
            signature = try P256.Signing.ECDSASignature(rawRepresentation: signatureData)
        } catch {
            return false
        }
        guard let signedBytes = try? signingData(),
              publicKey.isValidSignature(signature, for: signedBytes) else {
            return false
        }
        guard seenFallbackNonces.count < Config.diagnosticsAuthNonceCacheLimit else { return false }
        seenFallbackNonces[nonceKey] = issuedAt
        return true
    }

    func reconnectAnnouncementSummary() -> DiagnosticsSummary? {
        queue.sync {
            guard bootstrapped,
                  let currentRun = manifest.current else {
                return nil
            }
            let pending = manifest.archives
                .filter { $0.retrievedAt == nil }
                .sorted { $0.startedAt < $1.startedAt }
            return DiagnosticsSummary(
                requestId: "announce-\(currentRun.runId)",
                runs: (pending + [currentRun]).map(makeRunSummary),
                droppedEvents: manifest.droppedEvents,
                droppedBytes: manifest.droppedBytes,
                latestMetricKitPayloadAt: manifest.latestMetricKitPayloadAt
            )
        }
    }

    func currentRunId() -> String? {
        queue.sync {
            guard bootstrapped else { return nil }
            return manifest.current?.runId
        }
    }

    func setLiveAnnouncementSender(_ sender: AnnouncementSender?) {
        queue.sync {
            announcementSender = sender
        }
    }

    func announceCurrentRun() {
        guard let summary = reconnectAnnouncementSummary(),
              let sender = queue.sync(execute: { announcementSender })
        else {
            return
        }
        Task {
            do {
                try await sender(summary)
            } catch {
                record(
                    type: "diagnosticsAnnouncementSendFailed",
                    fields: [
                        "requestId": summary.requestId,
                        "error": error.localizedDescription
                    ],
                    level: .error
                )
            }
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
                guard let bounded = boundedCompressedPayload(sourceData: sourceData, remainingBytes: remaining) else {
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
                for (index, crash) in (payload.crashDiagnostics ?? []).enumerated() {
                    recordLocked(
                        type: "metricKitCrash",
                        fields: [
                            "index": String(index),
                            "applicationVersion": String(crash.applicationVersion.prefix(80)),
                            "terminationReason": String((crash.terminationReason ?? "unavailable").prefix(500)),
                            "exceptionType": crash.exceptionType?.stringValue ?? "unavailable",
                            "exceptionCode": crash.exceptionCode?.stringValue ?? "unavailable",
                            "signal": crash.signal?.stringValue ?? "unavailable"
                        ],
                        level: .error
                    )
                }
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

    private func recordLocked(
        type: String,
        fields: [String: String],
        level: OSLogType,
        retention: DiagnosticsRetention = .lifecycle,
        atMs: Int? = nil
    ) {
        guard var current = manifest.current else { return }
        let sanitizedFields = sanitize(fields: fields)
        let line = encodeLine(
            type: type,
            runId: current.runId,
            fields: sanitizedFields,
            retention: retention,
            atMs: atMs ?? nowMs()
        )
        appendLine(line, to: configuration.currentRunURL)
        current.byteCount += line.count
        current.eventCount += 1
        manifest.current = current
        trimCurrentRunIfNeeded()
        enforceArchiveRetention()
        mirrorToLogger(type: type, fields: sanitizedFields, level: level)
    }

    /// Brings an over-budget run back under it, sacrificing stream telemetry before lifecycle.
    ///
    /// Trims down to a low-water mark rather than to the limit. Trimming to the limit meant that
    /// once a run reached the cap, EVERY subsequent event re-read, re-split and rewrote the
    /// whole file -- 2MB of work per recorded event, on the busiest path in the app. The
    /// headroom turns that back into one rewrite per however many events fit in the gap.
    private func trimCurrentRunIfNeeded() {
        guard var current = manifest.current,
              current.byteCount > configuration.maxRunBytes,
              let data = try? Data(contentsOf: configuration.currentRunURL) else {
            return
        }
        let lines = splitNDJSON(data)
        let trimmed = trimLinesToLimit(lines, limit: trimLowWaterBytes)
        guard trimmed.droppedCount > 0 else { return }
        writeLines(trimmed.keptLines, to: configuration.currentRunURL)
        current.byteCount = trimmed.totalBytes
        current.eventCount = trimmed.keptLines.count
        manifest.current = current
        manifest.droppedEvents += trimmed.droppedCount
        manifest.droppedBytes += trimmed.droppedBytes
    }

    private var trimLowWaterBytes: Int {
        max(1, configuration.maxRunBytes * configuration.trimLowWaterPercent / 100)
    }

    /// The retention class a stored line declares, for the budget to act on.
    ///
    /// A line that will not decode carries no information, so it is sacrificed first rather
    /// than defended: treating corruption as precious would let it crowd out real events.
    private func retention(ofStoredLine line: Data) -> DiagnosticsRetention {
        (try? JSONDecoder().decode(StoredEventClass.self, from: line))?.rc ?? .stream
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

    /// Mark the manifest dirty and write it at most once per coalescing interval.
    ///
    /// Per-event atomic writes were the expensive half of recording, and they bought
    /// nothing: the NDJSON file is appended per event and is the authoritative record, while
    /// the manifest only carries the run list and its counters. Must be called on `queue`.
    private func scheduleManifestSave() {
        manifestDirty = true
        guard !manifestSaveScheduled else { return }
        manifestSaveScheduled = true
        queue.asyncAfter(deadline: .now() + .milliseconds(configuration.manifestSaveCoalesceMs)) { [weak self] in
            guard let self else { return }
            self.manifestSaveScheduled = false
            self.saveManifestIfDirty()
        }
    }

    /// Write the manifest now if anything is pending. Must be called on `queue`.
    private func saveManifestIfDirty() {
        guard manifestDirty else { return }
        saveManifest()
    }

    private func saveManifest() {
        manifestDirty = false
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

    private func encodeLine(
        type: String,
        runId: String,
        fields: [String: String],
        retention: DiagnosticsRetention,
        atMs: Int
    ) -> Data {
        let event = StoredEvent(
            tsMs: atMs,
            runId: runId,
            type: type,
            fields: fields,
            rc: retention
        )
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
        let truncatedEvent = StoredEvent(
            tsMs: atMs,
            runId: runId,
            type: type,
            fields: truncatedFields,
            rc: retention
        )
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

    /// The largest slice of a run that fits the response budget once compressed.
    ///
    /// This used to keep a TAIL, which made the fetch undo what the on-disk budget now
    /// protects: the newest frame telemetry would arrive and the launch and dial records that
    /// explain it would be cut off, because they are the oldest lines in the file. It searches
    /// an uncompressed byte budget instead, and every candidate is chosen by the same policy
    /// the trim uses, so what survives the disk also survives the wire.
    private func boundedCompressedPayload(sourceData: Data, remainingBytes: Int) -> (compressed: Data, uncompressedBytes: Int)? {
        guard let fullCompressed = try? DiagnosticsGzip.compress(sourceData) else {
            return nil
        }
        if fullCompressed.count <= remainingBytes {
            return (fullCompressed, sourceData.count)
        }
        let lines = splitNDJSON(sourceData)
        guard !lines.isEmpty else { return nil }
        // Classified once, not per probe: the search runs the policy a dozen-odd times, and
        // re-decoding every line each pass would cost more than the compression it is sizing.
        let classified = lines.map { (line: $0, retention: retention(ofStoredLine: $0)) }
        var low = 0
        var high = sourceData.count
        var best: (compressed: Data, uncompressedBytes: Int)?
        while low <= high {
            let mid = (low + high) / 2
            let kept = DiagnosticsTrimPolicy.keep(
                classified,
                limit: mid,
                bytes: { $0.line.count + 1 },
                retention: { $0.retention }
            )
            let candidate = joinedLines(kept.map(\.line))
            guard let compressed = try? DiagnosticsGzip.compress(candidate) else { return nil }
            if compressed.count <= remainingBytes {
                // An empty slice always fits, and answering a request with nothing would read
                // as a delivered log rather than as the budget being too small for one event.
                // It still searches upward from here; it just refuses to call this an answer.
                if !kept.isEmpty {
                    best = (compressed, candidate.count)
                }
                low = mid + 1
            } else {
                high = mid - 1
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

    /// Seconds, for run bookkeeping and the signed-request skew check, both of which are
    /// wall-clock facts shared with the host and need no more resolution than they have.
    /// Derived from the millisecond clock so there is only one source of time here.
    private func now() -> Int {
        nowMs() / 1000
    }

    private func nowMs() -> Int {
        nowMsProvider()
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
        let before = joinedLines(lines).count
        let kept = DiagnosticsTrimPolicy.keep(
            lines,
            limit: limit,
            // The newline each line gets on the way back to disk is part of what it costs.
            bytes: { $0.count + 1 },
            retention: { self.retention(ofStoredLine: $0) }
        )
        let total = joinedLines(kept).count
        return (kept, max(total, 0), lines.count - kept.count, max(before - total, 0))
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
