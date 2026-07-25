import CryptoKit
import Foundation
import Network
import os
import AgentDeskWire

@MainActor
final class ClientDiagnosticsRequester: ClientDiagnosticsRequesting {
    private let sessions: SessionRegistry
    private let pairing: Pairing
    private let tailnetDiscovery: TailnetDiscovering
    private let logger = Logger(subsystem: Config.logSubsystem, category: "client-diagnostics")

    init(
        sessions: SessionRegistry,
        pairing: Pairing,
        tailnetDiscovery: TailnetDiscovering
    ) {
        self.sessions = sessions
        self.pairing = pairing
        self.tailnetDiscovery = tailnetDiscovery
    }

    func collect(request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics {
        if let broker = sessions.allDiagnosticsBrokers().first {
            do {
                return try await broker.collect(request)
            } catch {
                logger.notice("session diagnostics request failed, falling back to tailnet: \(String(describing: error), privacy: .public)")
            }
        }
        return try await collectViaTailnet(request: request)
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

    func write(collected: CollectedClientDiagnostics, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let summaryURL = directory.appendingPathComponent("summary.json", isDirectory: false)
        try encoder.encode(collected.summary).write(
            to: summaryURL,
            options: .atomic
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: summaryURL.path)
        for (runId, payload) in collected.runPayloads {
            let payloadURL = directory.appendingPathComponent("\(runId).ndjson.gz", isDirectory: false)
            try payload.write(
                to: payloadURL,
                options: .atomic
            )
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: payloadURL.path)
        }
    }

}

private final class TailnetDiagnosticsProbe: @unchecked Sendable {
    private let ipv4: String
    private let requestFrame: Data
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).tailnet-diagnostics")
    private let logger = Logger(subsystem: Config.logSubsystem, category: "client-diagnostics")
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
