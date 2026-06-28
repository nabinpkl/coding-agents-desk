import CryptoKit
import Foundation
import Network
import os

struct ClientDiagnosticsAutomationRequest: Codable {
    let requestId: String
    let outputDirectory: String
    let includePreviousRuns: Bool
    let maxBytes: Int?
}

struct ClientDiagnosticsAutomationResult: Codable {
    let requestId: String
    let status: String
    let outputDirectory: String?
    let message: String
}

struct CollectedClientDiagnostics {
    let summary: DiagnosticsSummary
    let runPayloads: [String: Data]
}

enum ClientDiagnosticsRequesterError: Error, LocalizedError {
    case noActiveSession
    case timedOut
    case unavailable
    case unauthorized
    case malformedResponse
    case remote(String)

    var errorDescription: String? {
        switch self {
        case .noActiveSession:
            return "no active client session"
        case .timedOut:
            return "diagnostics request timed out"
        case .unavailable:
            return "client diagnostics unavailable"
        case .unauthorized:
            return "client rejected diagnostics authentication"
        case .malformedResponse:
            return "client returned a malformed diagnostics response"
        case .remote(let reason):
            return reason
        }
    }
}

@MainActor
final class ClientDiagnosticsRequester {
    private let sessions: SessionRegistry
    private let pairing: Pairing
    private let tailnetDiscovery: TailnetDiscovering
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "client-diagnostics")

    init(
        sessions: SessionRegistry,
        pairing: Pairing,
        tailnetDiscovery: TailnetDiscovering
    ) {
        self.sessions = sessions
        self.pairing = pairing
        self.tailnetDiscovery = tailnetDiscovery
    }

    func handleAutomationRequestFromDisk() async {
        let requestURL = Config.devDiagnosticsRequestPath
        let resultURL = Config.devDiagnosticsResultPath
        let decoder = JSONDecoder()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let requestData = try? Data(contentsOf: requestURL)
        let requestId = requestData
            .flatMap { try? decoder.decode(ClientDiagnosticsAutomationRequest.self, from: $0).requestId }
            ?? UUID().uuidString.lowercased()
        do {
            guard let data = requestData else {
                throw ClientDiagnosticsRequesterError.unavailable
            }
            let automation = try decoder.decode(ClientDiagnosticsAutomationRequest.self, from: data)
            try? FileManager.default.removeItem(at: resultURL)
            let request = DiagnosticsRequest(
                requestId: automation.requestId,
                sinceRunId: nil,
                includePreviousRuns: automation.includePreviousRuns,
                maxBytes: automation.maxBytes
            )
            let collected = try await collect(request: request)
            try write(collected: collected, to: URL(fileURLWithPath: automation.outputDirectory))
            let result = ClientDiagnosticsAutomationResult(
                requestId: automation.requestId,
                status: "ok",
                outputDirectory: automation.outputDirectory,
                message: "client diagnostics written"
            )
            try encoder.encode(result).write(to: resultURL, options: .atomic)
        } catch {
            let result = ClientDiagnosticsAutomationResult(
                requestId: requestId,
                status: "error",
                outputDirectory: nil,
                message: error.localizedDescription
            )
            try? encoder.encode(result).write(to: resultURL, options: .atomic)
            logger.error("client diagnostics automation failed: \(String(describing: error), privacy: .public)")
        }
    }

    func collect(request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics {
        if let active = sessions.allInputChannelServers().first {
            do {
                return try await collectViaSession(server: active, request: request)
            } catch {
                logger.notice("session diagnostics request failed, falling back to tailnet: \(String(describing: error), privacy: .public)")
            }
        }
        return try await collectViaTailnet(request: request)
    }

    private func collectViaSession(server: any InputChannelServing, request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics {
        let task = Task {
            try await self.waitForDiagnostics(on: server, requestId: request.requestId)
        }
        server.pushDiagnosticsRequest(request)
        return try await awaitTask(task, timeoutSeconds: Config.diagnosticsRequestTimeoutSeconds)
    }

    private func waitForDiagnostics(on server: any InputChannelServing, requestId: String) async throws -> CollectedClientDiagnostics {
        var summary: DiagnosticsSummary?
        var payloads: [String: Data] = [:]
        for await update in server.diagnosticsUpdates {
            switch update {
            case .summary(let incoming):
                guard incoming.requestId == requestId else { continue }
                summary = incoming
                if incoming.runs.isEmpty {
                    return CollectedClientDiagnostics(summary: incoming, runPayloads: [:])
                }
            case .chunk(let chunk):
                guard chunk.requestId == requestId else { continue }
                let decoded: Data
                if chunk.payloadBase64.isEmpty {
                    decoded = Data()
                } else if let payload = Data(base64Encoded: chunk.payloadBase64) {
                    decoded = payload
                } else {
                    throw ClientDiagnosticsRequesterError.malformedResponse
                }
                payloads[chunk.runId, default: Data()].append(decoded)
                if chunk.isFinal {
                    guard let summary else {
                        throw ClientDiagnosticsRequesterError.malformedResponse
                    }
                    return CollectedClientDiagnostics(summary: summary, runPayloads: payloads)
                }
            case .error(let error):
                guard error.requestId == requestId else { continue }
                if error.reason == "unauthorized" {
                    throw ClientDiagnosticsRequesterError.unauthorized
                }
                throw ClientDiagnosticsRequesterError.remote(error.reason)
            }
        }
        throw ClientDiagnosticsRequesterError.unavailable
    }

    private func collectViaTailnet(request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics {
        let peers = try tailnetDiscovery.peerDevices().filter { $0.isIOS && $0.online }
        let key = try pairing.signingKey()
        let fingerprint = key.publicKey.agentDeskFingerprint
        for peer in peers {
            do {
                let requestBytes = try signedRequestData(
                    request: request,
                    hostFingerprint: fingerprint,
                    key: key
                )
                return try await TailnetDiagnosticsProbe(ipv4: peer.ipv4, requestFrame: requestBytes).run()
            } catch {
                logger.notice("tailnet diagnostics probe failed peer=\(peer.ipv4, privacy: .public) error=\(String(describing: error), privacy: .public)")
            }
        }
        throw ClientDiagnosticsRequesterError.unavailable
    }

    private func signedRequestData(
        request: DiagnosticsRequest,
        hostFingerprint: String,
        key: HostSigningKey
    ) throws -> Data {
        let nonce = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let issuedAt = Int(Date().timeIntervalSince1970)
        let signature = try key.signature(for: DiagnosticsRequestSignature.signingData(
            request: request,
            hostFingerprint: hostFingerprint,
            issuedAt: issuedAt,
            nonce: nonce
        )).rawRepresentation
        let signed = SignedDiagnosticsRequest(
            requestId: request.requestId,
            sinceRunId: request.sinceRunId,
            includePreviousRuns: request.includePreviousRuns,
            maxBytes: request.maxBytes,
            hostFingerprint: hostFingerprint,
            issuedAt: issuedAt,
            nonce: nonce,
            hostSignature: signature
        )
        return try OfferPortFrame.encode(JSONEncoder().encode(signed))
    }

    private func write(collected: CollectedClientDiagnostics, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(collected.summary).write(
            to: directory.appendingPathComponent("summary.json", isDirectory: false),
            options: .atomic
        )
        for (runId, payload) in collected.runPayloads {
            try payload.write(
                to: directory.appendingPathComponent("\(runId).ndjson.gz", isDirectory: false),
                options: .atomic
            )
        }
    }

    private func awaitTask<T>(_ task: Task<T, Error>, timeoutSeconds: TimeInterval) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await task.value }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                throw ClientDiagnosticsRequesterError.timedOut
            }
            let value = try await group.next()!
            group.cancelAll()
            return value
        }
    }
}

private final class TailnetDiagnosticsProbe: @unchecked Sendable {
    private let ipv4: String
    private let requestFrame: Data
    private let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.tailnet-diagnostics")
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "client-diagnostics")
    private var parser = OfferPortFrameParser()
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<CollectedClientDiagnostics, Error>?
    private var summary: DiagnosticsSummary?
    private var payloads: [String: Data] = [:]
    private var finished = false

    init(ipv4: String, requestFrame: Data) {
        self.ipv4 = ipv4
        self.requestFrame = requestFrame
    }

    func run() async throws -> CollectedClientDiagnostics {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            guard let port = NWEndpoint.Port(rawValue: Config.offerPort) else {
                continuation.resume(throwing: ClientDiagnosticsRequesterError.unavailable)
                return
            }
            let connection = NWConnection(host: NWEndpoint.Host(ipv4), port: port, using: .tcp)
            self.connection = connection
            queue.asyncAfter(deadline: .now() + Config.diagnosticsRequestTimeoutSeconds) { [weak self] in
                self?.finish(throwing: ClientDiagnosticsRequesterError.timedOut)
            }
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    connection.send(content: self.requestFrame, completion: .contentProcessed { [weak self] error in
                        if let error {
                            self?.finish(throwing: error)
                        } else {
                            self?.receive()
                        }
                    })
                case .failed(let error):
                    self.finish(throwing: error)
                case .cancelled:
                    self.finish(throwing: ClientDiagnosticsRequesterError.unavailable)
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                guard let bodies = try? self.parser.append(data) else {
                    self.finish(throwing: ClientDiagnosticsRequesterError.malformedResponse)
                    return
                }
                for body in bodies {
                    switch OfferPortMessage.classify(body) {
                    case .diagnosticsSummary(let summary):
                        self.summary = summary
                        if summary.runs.isEmpty {
                            self.finish(returning: CollectedClientDiagnostics(summary: summary, runPayloads: [:]))
                            return
                        }
                    case .diagnosticsChunk(let chunk):
                        guard let decoded = Data(base64Encoded: chunk.payloadBase64) else {
                            self.finish(throwing: ClientDiagnosticsRequesterError.malformedResponse)
                            return
                        }
                        self.payloads[chunk.runId, default: Data()].append(decoded)
                        if chunk.isFinal {
                            guard let summary = self.summary else {
                                self.finish(throwing: ClientDiagnosticsRequesterError.malformedResponse)
                                return
                            }
                            self.finish(returning: CollectedClientDiagnostics(summary: summary, runPayloads: self.payloads))
                            return
                        }
                    case .diagnosticsError(let error):
                        if error.reason == "unauthorized" {
                            self.finish(throwing: ClientDiagnosticsRequesterError.unauthorized)
                        } else {
                            self.finish(throwing: ClientDiagnosticsRequesterError.remote(error.reason))
                        }
                        return
                    default:
                        break
                    }
                }
            }
            if let error {
                self.finish(throwing: error)
                return
            }
            if isComplete {
                self.finish(throwing: ClientDiagnosticsRequesterError.unavailable)
                return
            }
            self.receive()
        }
    }

    private func finish(returning result: CollectedClientDiagnostics) {
        guard !finished else { return }
        finished = true
        connection?.cancel()
        continuation?.resume(returning: result)
        continuation = nil
    }

    private func finish(throwing error: Error) {
        guard !finished else { return }
        finished = true
        logger.notice("tailnet diagnostics probe ended error=\(String(describing: error), privacy: .public)")
        connection?.cancel()
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
