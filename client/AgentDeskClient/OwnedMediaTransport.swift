import Foundation
import OSLog

final class OwnedMediaTransportFactory: MediaTransportFactory {
    private let host: String
    private let port: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private let urlSession: URLSession

    init(
        host: String,
        port: UInt16,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        urlSession: URLSession
    ) {
        self.host = host
        self.port = port
        self.active = active
        self.mediaCapability = mediaCapability
        self.urlSession = urlSession
    }

    func make() -> MediaTransport {
        OwnedMediaTransport(
            host: host,
            port: port,
            active: active,
            mediaCapability: mediaCapability,
            urlSession: urlSession
        )
    }
}

final class OwnedMediaTransport: MediaTransport, @unchecked Sendable {
    let connectionState: AsyncStream<MediaConnectionState>
    private let stateContinuation: AsyncStream<MediaConnectionState>.Continuation
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "owned-media")
    private let host: String
    private let port: UInt16
    private let active: ActiveSession
    private let mediaCapability: MediaCapabilityGrant
    private let urlSession: URLSession
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private weak var sink: (any OwnedMediaFrameSink)?

    init(
        host: String,
        port: UInt16,
        active: ActiveSession,
        mediaCapability: MediaCapabilityGrant,
        urlSession: URLSession
    ) {
        self.host = host
        self.port = port
        self.active = active
        self.mediaCapability = mediaCapability
        self.urlSession = urlSession
        var continuation: AsyncStream<MediaConnectionState>.Continuation!
        connectionState = AsyncStream { continuation = $0 }
        self.stateContinuation = continuation
    }

    func start(
        role: MediaTransportRole,
        signaling: SignalingChannel,
        videoSources: VideoPlaneSources?,
        videoSinks: VideoPlaneSinks?
    ) async throws {
        guard let sink = videoSinks?[.detail] as? any OwnedMediaFrameSink else {
            throw MediaTransportError.notYetImplemented
        }
        self.sink = sink
        guard let url = URL(string: "wss://\(host):\(port)/media") else {
            throw SessionRejected(reason: .malformed)
        }
        let task = urlSession.webSocketTask(with: url)
        self.task = task
        stateContinuation.yield(.connecting)
        task.resume()
        let hello = MediaChannelHello(
            deviceFingerprint: active.deviceFingerprint,
            sessionId: active.sessionId,
            mediaCapability: mediaCapability.mediaCapability
        )
        try await send(hello, on: task)
        try await receiveReady(sessionId: active.sessionId, on: task)
        stateContinuation.yield(.connected)
        receiveTask = Task { [weak self, task] in
            await self?.receiveLoop(task: task)
        }
    }

    func stop() {
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        stateContinuation.yield(.closed)
        stateContinuation.finish()
    }

    private func receiveLoop(task: URLSessionWebSocketTask) async {
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                let data: Data
                switch message {
                case .data(let bytes):
                    data = bytes
                case .string(let text):
                    logger.notice("owned media ignored text frame bytes=\(text.utf8.count, privacy: .public)")
                    continue
                @unknown default:
                    stateContinuation.yield(.failed)
                    return
                }
                let envelope = try OwnedMediaFrameEnvelope.decode(data)
                await MainActor.run { [weak self] in
                    self?.sink?.renderOwnedMediaFrame(envelope)
                }
            } catch {
                logger.error("owned media receive failed: \(String(describing: error), privacy: .public)")
                stateContinuation.yield(.failed)
                return
            }
        }
    }

    private func send<T: Encodable>(_ value: T, on task: URLSessionWebSocketTask) async throws {
        let data = try JSONEncoder().encode(value)
        guard let text = String(data: data, encoding: .utf8) else {
            throw SessionRejected(reason: .malformed)
        }
        try await task.send(.string(text))
    }

    private func receiveReady(sessionId: String, on task: URLSessionWebSocketTask) async throws {
        let message = try await task.receive()
        let data: Data
        switch message {
        case .data(let bytes):
            data = bytes
        case .string(let text):
            data = Data(text.utf8)
        @unknown default:
            throw SessionRejected(reason: .malformed)
        }
        let header = try JSONDecoder().decode(MediaFrameHeader.self, from: data)
        switch header.type {
        case "media-ready":
            let ready = try JSONDecoder().decode(MediaChannelReady.self, from: data)
            guard ready.sessionId == sessionId else {
                throw SessionRejected(reason: .malformed)
            }
        case "session-rejected":
            if let rejected = try? JSONDecoder().decode(SessionRejected.self, from: data) {
                throw rejected
            }
            throw SessionRejected(reason: .malformed)
        default:
            throw SessionRejected(reason: .malformed)
        }
    }

    private struct MediaFrameHeader: Decodable {
        let type: String
        enum CodingKeys: String, CodingKey { case type = "t" }
    }
}
