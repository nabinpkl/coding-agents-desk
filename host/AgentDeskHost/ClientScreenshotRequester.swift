import CryptoKit
import Foundation
import Network
import os
import AgentDeskWire

struct CollectedClientScreenshot: Equatable {
    let manifest: ClientScreenshotManifest
    let jpegData: Data
}

enum ClientScreenshotRequesterError: Error, LocalizedError, Equatable {
    case timedOut
    case unavailable
    case unauthorized
    case malformedResponse
    case responseTooLarge
    case remote(String)

    var errorDescription: String? {
        switch self {
        case .timedOut: "client screenshot request timed out"
        case .unavailable: "client screenshot unavailable"
        case .unauthorized: "client screenshot sharing is not authorized"
        case .malformedResponse: "client returned a malformed screenshot"
        case .responseTooLarge: "client screenshot exceeded the response limit"
        case .remote(let reason): reason
        }
    }
}

struct ClientScreenshotAssembler {
    private(set) var manifest: ClientScreenshotManifest?
    private(set) var data = Data()
    private var nextSequence = 0
    let requestId: String
    let maxBytes: Int
    let maxPixelDimension: Int

    init(requestId: String, maxBytes: Int, maxPixelDimension: Int) {
        self.requestId = requestId
        self.maxBytes = maxBytes
        self.maxPixelDimension = maxPixelDimension
    }

    mutating func accept(manifest incoming: ClientScreenshotManifest) throws {
        guard manifest == nil,
              incoming.type == "client-screenshot-manifest",
              incoming.requestId == requestId,
              incoming.mimeType == "image/jpeg",
              incoming.capturedAt > 0,
              !incoming.clientBuildSHA.isEmpty,
              incoming.clientBuildSHA.utf8.count <= 128,
              !incoming.surfaceName.isEmpty,
              incoming.surfaceName.utf8.count <= 256,
              incoming.pixelWidth > 0,
              incoming.pixelHeight > 0,
              incoming.pixelWidth <= maxPixelDimension,
              incoming.pixelHeight <= maxPixelDimension,
              incoming.scale.isFinite,
              incoming.scale > 0,
              ["portrait", "landscape", "unknown"].contains(incoming.orientation),
              incoming.totalBytes > 0,
              incoming.totalBytes <= maxBytes,
              incoming.sha256.count == 64,
              incoming.sha256.allSatisfy({ $0.isHexDigit }),
              incoming.omittedLayers.count <= 16,
              incoming.omittedLayers.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 128 }) else {
            throw ClientScreenshotRequesterError.malformedResponse
        }
        manifest = incoming
    }

    mutating func accept(chunk: ClientScreenshotChunk) throws -> CollectedClientScreenshot? {
        guard let manifest,
              chunk.type == "client-screenshot-chunk",
              chunk.requestId == requestId,
              chunk.sequence == nextSequence,
              chunk.payloadBase64.utf8.count <= ((Config.screenshotChunkBytes + 2) / 3) * 4,
              let decoded = Data(base64Encoded: chunk.payloadBase64),
              decoded.count <= Config.screenshotChunkBytes,
              data.count + decoded.count <= maxBytes else {
            throw ClientScreenshotRequesterError.malformedResponse
        }
        data.append(decoded)
        nextSequence += 1
        guard chunk.isFinal else { return nil }
        guard data.count == manifest.totalBytes else {
            throw ClientScreenshotRequesterError.malformedResponse
        }
        guard data.starts(with: [0xFF, 0xD8]),
              data.suffix(2) == Data([0xFF, 0xD9]) else {
            throw ClientScreenshotRequesterError.malformedResponse
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.sha256.lowercased() else {
            throw ClientScreenshotRequesterError.malformedResponse
        }
        return CollectedClientScreenshot(manifest: manifest, jpegData: data)
    }
}

@MainActor
final class ClientScreenshotRequester: ClientScreenshotRequesting {
    private let sessions: SessionRegistry
    private let pairing: Pairing
    private let tailnetDiscovery: TailnetDiscovering
    private let logger = Logger(subsystem: Config.logSubsystem, category: "client-screenshot")

    init(sessions: SessionRegistry, pairing: Pairing, tailnetDiscovery: TailnetDiscovering) {
        self.sessions = sessions
        self.pairing = pairing
        self.tailnetDiscovery = tailnetDiscovery
    }

    func collect(request: ClientScreenshotRequest) async throws -> CollectedClientScreenshot {
        if let active = sessions.allInputChannelServers().first {
            do {
                return try await collectViaSession(server: active, request: request)
            } catch ClientScreenshotRequesterError.unauthorized {
                throw ClientScreenshotRequesterError.unauthorized
            } catch {
                logger.notice("session screenshot request failed; trying foreground tailnet fallback error=\(String(describing: error), privacy: .public)")
            }
        }
        return try await collectViaTailnet(request: request)
    }

    func write(_ collected: CollectedClientScreenshot, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let imageURL = directory.appendingPathComponent("client.jpg", isDirectory: false)
        let manifestURL = directory.appendingPathComponent("manifest.json", isDirectory: false)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try collected.jpegData.write(to: imageURL, options: .atomic)
        try encoder.encode(collected.manifest).write(to: manifestURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: imageURL.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifestURL.path)
    }

    private func collectViaSession(
        server: any InputChannelServing,
        request: ClientScreenshotRequest
    ) async throws -> CollectedClientScreenshot {
        let task = Task { try await self.waitForScreenshot(on: server, request: request) }
        server.pushScreenshotRequest(request)
        return try await awaitTask(task, timeoutSeconds: Config.screenshotRequestTimeoutSeconds)
    }

    private func waitForScreenshot(
        on server: any InputChannelServing,
        request: ClientScreenshotRequest
    ) async throws -> CollectedClientScreenshot {
        var assembler = ClientScreenshotAssembler(
            requestId: request.requestId,
            maxBytes: min(request.maxBytes ?? Config.screenshotMaxBytes, Config.screenshotMaxBytes),
            maxPixelDimension: min(
                request.maxPixelDimension ?? Config.screenshotMaxPixelDimension,
                Config.screenshotMaxPixelDimension
            )
        )
        for await update in server.screenshotUpdates {
            switch update {
            case .manifest(let manifest):
                guard manifest.requestId == request.requestId else { continue }
                try assembler.accept(manifest: manifest)
            case .chunk(let chunk):
                guard chunk.requestId == request.requestId else { continue }
                if let collected = try assembler.accept(chunk: chunk) { return collected }
            case .error(let error):
                guard error.requestId == request.requestId else { continue }
                let remoteError = try validatedScreenshotRemoteError(error)
                throw remoteError
            }
        }
        throw ClientScreenshotRequesterError.unavailable
    }

    private func collectViaTailnet(request: ClientScreenshotRequest) async throws -> CollectedClientScreenshot {
        let peers = try tailnetDiscovery.peerDevices().filter { $0.isIOS && $0.online }
        let key = try pairing.signingKey()
        let fingerprint = key.publicKey.agentDeskFingerprint
        for peer in peers {
            do {
                let requestFrame = try signedRequestData(
                    request: request,
                    hostFingerprint: fingerprint,
                    key: key
                )
                return try await TailnetClientScreenshotProbe(
                    ipv4: peer.ipv4,
                    requestFrame: requestFrame,
                    request: request
                ).run()
            } catch {
                logger.notice("tailnet screenshot probe failed peer=\(peer.ipv4, privacy: .public) error=\(String(describing: error), privacy: .public)")
            }
        }
        throw ClientScreenshotRequesterError.unavailable
    }

    private func signedRequestData(
        request: ClientScreenshotRequest,
        hostFingerprint: String,
        key: HostSigningKey
    ) throws -> Data {
        let nonce = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        let issuedAt = Int(Date().timeIntervalSince1970)
        let signature = try key.signature(for: ClientScreenshotRequestSignature.signingData(
            request: request,
            hostFingerprint: hostFingerprint,
            issuedAt: issuedAt,
            nonce: nonce
        )).rawRepresentation
        return try OfferPortFrame.encode(JSONEncoder().encode(SignedClientScreenshotRequest(
            requestId: request.requestId,
            maxPixelDimension: request.maxPixelDimension,
            maxBytes: request.maxBytes,
            hostFingerprint: hostFingerprint,
            issuedAt: issuedAt,
            nonce: nonce,
            hostSignature: signature
        )))
    }

    private func awaitTask<T>(_ task: Task<T, Error>, timeoutSeconds: TimeInterval) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await task.value }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                throw ClientScreenshotRequesterError.timedOut
            }
            let value = try await group.next()!
            group.cancelAll()
            return value
        }
    }
}

private final class TailnetClientScreenshotProbe: @unchecked Sendable {
    private let ipv4: String
    private let requestFrame: Data
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).tailnet-client-screenshot")
    private var parser = OfferPortFrameParser()
    private var connection: NWConnection?
    private var continuation: CheckedContinuation<CollectedClientScreenshot, Error>?
    private var assembler: ClientScreenshotAssembler
    private var finished = false

    init(ipv4: String, requestFrame: Data, request: ClientScreenshotRequest) {
        self.ipv4 = ipv4
        self.requestFrame = requestFrame
        assembler = ClientScreenshotAssembler(
            requestId: request.requestId,
            maxBytes: min(request.maxBytes ?? Config.screenshotMaxBytes, Config.screenshotMaxBytes),
            maxPixelDimension: min(
                request.maxPixelDimension ?? Config.screenshotMaxPixelDimension,
                Config.screenshotMaxPixelDimension
            )
        )
    }

    func run() async throws -> CollectedClientScreenshot {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            guard let port = NWEndpoint.Port(rawValue: Config.offerPort) else {
                finish(throwing: ClientScreenshotRequesterError.unavailable)
                return
            }
            let connection = NWConnection(host: NWEndpoint.Host(ipv4), port: port, using: .tcp)
            self.connection = connection
            queue.asyncAfter(deadline: .now() + Config.screenshotRequestTimeoutSeconds) { [weak self] in
                self?.finish(throwing: ClientScreenshotRequesterError.timedOut)
            }
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    connection.send(content: self.requestFrame, completion: .contentProcessed { [weak self] error in
                        if let error { self?.finish(throwing: error) }
                    })
                    self.receive()
                case .failed(let error):
                    self.finish(throwing: error)
                case .cancelled:
                    if !self.finished { self.finish(throwing: ClientScreenshotRequesterError.unavailable) }
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1_024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            do {
                if let data, !data.isEmpty {
                    for body in try self.parser.append(data) {
                        switch OfferPortMessage.classify(body) {
                        case .screenshotManifest(let manifest):
                            try self.assembler.accept(manifest: manifest)
                        case .screenshotChunk(let chunk):
                            if let collected = try self.assembler.accept(chunk: chunk) {
                                self.finish(returning: collected)
                                return
                            }
                        case .screenshotError(let remote):
                            guard remote.requestId == self.assembler.requestId else { break }
                            self.finish(throwing: try validatedScreenshotRemoteError(remote))
                            return
                        default:
                            break
                        }
                    }
                }
            } catch {
                finish(throwing: error)
                return
            }
            if let error {
                finish(throwing: error)
            } else if isComplete {
                finish(throwing: ClientScreenshotRequesterError.unavailable)
            } else {
                receive()
            }
        }
    }

    private func finish(returning value: CollectedClientScreenshot) {
        guard !finished else { return }
        finished = true
        connection?.cancel()
        continuation?.resume(returning: value)
        continuation = nil
    }

    private func finish(throwing error: Error) {
        guard !finished else { return }
        finished = true
        connection?.cancel()
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

private func validatedScreenshotRemoteError(
    _ frame: ClientScreenshotError
) throws -> ClientScreenshotRequesterError {
    let validReason = !frame.reason.isEmpty
        && frame.type == "client-screenshot-error"
        && frame.reason.utf8.count <= 64
        && frame.reason.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 0x61 && scalar.value <= 0x7A)
                || (scalar.value >= 0x30 && scalar.value <= 0x39)
                || scalar.value == 0x2D
        }
    guard validReason else { throw ClientScreenshotRequesterError.malformedResponse }
    if frame.reason == "not-authorized" || frame.reason == "unauthorized" {
        return .unauthorized
    }
    return .remote(frame.reason)
}
