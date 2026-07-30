import AgentDeskWire
import Foundation
import Network
import os

enum VoiceLaneServerError: Error, Equatable {
    case malformedHello
    case unsupportedVersion
    case invalidRequest
    case invalidSequence
    case sidecarUnavailable
}

@available(macOS 26.0, *)
final class VoiceLaneServer: @unchecked Sendable {
    typealias BaseURLProvider = @Sendable () -> URL?
    static let maximumRESTChunkBytes = 96 * 1024
    static let maximumConcurrentRESTRequests = 8

    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private let helloPayload: Data
    private var baseURLProvider: BaseURLProvider = { nil }
    private let writer: VoiceLaneWriter
    private let logger = Logger(subsystem: Config.logSubsystem, category: "voice-lane")
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    private var socketReceiveTask: Task<Void, Never>?
    private var webSocket: URLSessionWebSocketTask?
    private var webSocketSession: URLSession?
    private var recordingSessionID: String?
    private var restTasks: [String: Task<Void, Never>] = [:]
    private var reservedRESTRequestIDs: Set<String> = []
    private var stopped = false

    var onClose: (() -> Void)?

    init(
        stream: QUIC.Stream<QUICStream>,
        fingerprint: DeviceFingerprint,
        helloPayload: Data
    ) {
        self.stream = stream
        self.fingerprint = fingerprint
        self.helloPayload = helloPayload
        writer = VoiceLaneWriter(stream: stream)
    }

    func start(baseURLProvider: @escaping BaseURLProvider) {
        lock.lock()
        guard task == nil, !stopped else {
            lock.unlock()
            return
        }
        self.baseURLProvider = baseURLProvider
        task = Task { await run() }
        lock.unlock()
    }

    func stop() {
        lock.lock()
        stopped = true
        let task = task
        self.task = nil
        lock.unlock()
        task?.cancel()
        cancelRESTTasks()
        closeSocket(code: .goingAway, reason: "voice lane stopped")
    }

    private func run() async {
        defer {
            cancelRESTTasks()
            closeSocket(code: .goingAway, reason: "voice transport lost")
            lock.withLock { task = nil }
            onClose?()
        }
        do {
            let hello = try VoiceLaneCodec.decode(VoiceLaneHello.self, from: helloPayload)
            guard hello.protocolIdentifier == VoiceLaneCodec.protocolIdentifier else {
                try await writer.send(.error(
                    requestID: nil,
                    recordingSessionID: nil,
                    code: .unsupportedVersion,
                    message: "Update the Mac host to use iPhone recording."
                ))
                throw VoiceLaneServerError.unsupportedVersion
            }
            try await writer.send(.ready)
            while !Task.isCancelled {
                let frame = try await QuicSessionStreamIO.receiveFrame(
                    on: stream,
                    expectedRole: .voice
                )
                let message = try VoiceLaneCodec.decode(
                    VoiceLaneClientMessage.self,
                    from: frame.payload
                )
                try await handle(message)
            }
        } catch {
            logger.notice(
                "voice lane ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
        }
    }

    private func handle(_ message: VoiceLaneClientMessage) async throws {
        switch message {
        case .socketOpen(let requestID, let sessionID):
            guard let baseURL = baseURLProvider(),
                  let url = Self.websocketURL(
                      baseURL: baseURL,
                      recordingSessionID: sessionID
                  )
            else {
                try await writer.send(.error(
                    requestID: requestID,
                    recordingSessionID: sessionID,
                    code: .sidecarUnavailable,
                    message: "The Mac voice service is unavailable."
                ))
                return
            }
            var request = URLRequest(url: url)
            request.setValue("interactionfeed://app", forHTTPHeaderField: "Origin")
            let openGate = VoiceLoopbackWebSocketOpenGate()
            let urlSession = URLSession(
                configuration: .ephemeral,
                delegate: openGate,
                delegateQueue: nil
            )
            let socket = urlSession.webSocketTask(with: request)
            let installed = lock.withLock {
                guard recordingSessionID == nil, webSocket == nil else {
                    return false
                }
                webSocketSession = urlSession
                webSocket = socket
                recordingSessionID = sessionID
                return true
            }
            guard installed else {
                urlSession.invalidateAndCancel()
                try await writer.send(.error(
                    requestID: requestID,
                    recordingSessionID: sessionID,
                    code: .invalidSequence,
                    message: "A voice WebSocket is already open."
                ))
                return
            }
            socket.resume()
            do {
                try await openGate.waitUntilOpen()
                guard isCurrentSocket(sessionID: sessionID) else { return }
                let receiveTask = Task { [weak self, weak socket] in
                    guard let self, let socket else { return }
                    await receiveSocketMessages(socket, sessionID: sessionID)
                }
                let receiveInstalled = lock.withLock {
                    guard recordingSessionID == sessionID, webSocket === socket else {
                        return false
                    }
                    socketReceiveTask = receiveTask
                    return true
                }
                guard receiveInstalled else {
                    receiveTask.cancel()
                    return
                }
                try await writer.send(.socketOpened(
                    requestID: requestID,
                    recordingSessionID: sessionID
                ))
            } catch {
                closeSocket(code: .goingAway, reason: "voice lane write failed")
                try await writer.send(.error(
                    requestID: requestID,
                    recordingSessionID: sessionID,
                    code: .sidecarUnavailable,
                    message: "The Mac voice service WebSocket could not open."
                ))
            }

        case .socketMessage(let sessionID, let json):
            guard let webSocket = currentSocket(sessionID: sessionID) else {
                try await writer.send(.error(
                    requestID: nil,
                    recordingSessionID: sessionID,
                    code: .invalidSequence,
                    message: "The voice WebSocket session is stale."
                ))
                return
            }
            try VoiceLaneCodec.validateJSON(json)
            try await webSocket.send(.string(json))

        case .socketClose(let sessionID):
            guard isCurrentSocket(sessionID: sessionID) else { return }
            closeSocket(code: .normalClosure, reason: "browser closed")

        case .rest(let request):
            await beginREST(request)
        }
    }

    private func beginREST(_ request: VoiceRESTRequest) async {
        let reserved = lock.withLock {
            guard !stopped,
                  restTasks.count + reservedRESTRequestIDs.count
                    < Self.maximumConcurrentRESTRequests,
                  !restTasks.keys.contains(request.requestID),
                  !reservedRESTRequestIDs.contains(request.requestID)
            else {
                return false
            }
            reservedRESTRequestIDs.insert(request.requestID)
            return true
        }
        guard reserved else {
            try? await writer.send(.error(
                requestID: request.requestID,
                recordingSessionID: nil,
                code: .invalidSequence,
                message: "The voice REST request is duplicated or the lane is busy."
            ))
            return
        }

        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                lock.withLock {
                    restTasks.removeValue(forKey: request.requestID)
                    reservedRESTRequestIDs.remove(request.requestID)
                }
            }
            await handleREST(request)
        }
        let installed = lock.withLock {
            guard !stopped, reservedRESTRequestIDs.remove(request.requestID) != nil else {
                return false
            }
            restTasks[request.requestID] = task
            return true
        }
        if !installed {
            task.cancel()
        }
    }

    private func receiveSocketMessages(
        _ socket: URLSessionWebSocketTask,
        sessionID: String
    ) async {
        do {
            while !Task.isCancelled {
                let message = try await socket.receive()
                guard isCurrentSocket(sessionID: sessionID) else { return }
                let json: String
                switch message {
                case .string(let value):
                    json = value
                case .data(let data):
                    guard let value = String(data: data, encoding: .utf8) else {
                        throw VoiceLaneServerError.invalidRequest
                    }
                    json = value
                @unknown default:
                    throw VoiceLaneServerError.invalidRequest
                }
                try VoiceLaneCodec.validateJSON(json)
                try await writer.send(.socketMessage(
                    recordingSessionID: sessionID,
                    json: json
                ))
            }
        } catch {
            if isCurrentSocket(sessionID: sessionID) {
                try? await writer.send(.socketClosed(
                    recordingSessionID: sessionID,
                    reason: String(describing: error)
                ))
                closeSocket(code: .goingAway, reason: "sidecar socket ended")
            }
        }
    }

    private func handleREST(_ request: VoiceRESTRequest) async {
        guard Self.isAllowed(method: request.method, path: request.path) else {
            try? await writer.send(.error(
                requestID: request.requestID,
                recordingSessionID: nil,
                code: .invalidRequest,
                message: "The requested voice endpoint is not allowed."
            ))
            return
        }
        guard let baseURL = baseURLProvider(),
              let url = URL(string: request.path, relativeTo: baseURL)?.absoluteURL,
              url.host == baseURL.host,
              url.port == baseURL.port
        else {
            try? await writer.send(.error(
                requestID: request.requestID,
                recordingSessionID: nil,
                code: .sidecarUnavailable,
                message: "The Mac voice service is unavailable."
            ))
            return
        }
        do {
            var urlRequest = URLRequest(url: url)
            urlRequest.httpMethod = request.method.rawValue
            urlRequest.httpBody = request.body
            if request.body != nil {
                urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
            let (body, response) = try await URLSession.shared.data(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw VoiceLaneServerError.sidecarUnavailable
            }
            try await sendRESTResponse(
                requestID: request.requestID,
                status: http.statusCode,
                contentType: http.value(forHTTPHeaderField: "Content-Type"),
                body: body
            )
        } catch {
            guard !Task.isCancelled else { return }
            try? await writer.send(.error(
                requestID: request.requestID,
                recordingSessionID: nil,
                code: .sidecarUnavailable,
                message: "The Mac voice service request failed: \(error.localizedDescription)"
            ))
        }
    }

    private func closeSocket(
        code: URLSessionWebSocketTask.CloseCode,
        reason: String
    ) {
        let resources = lock.withLock {
            let resources = (socketReceiveTask, webSocket, webSocketSession)
            socketReceiveTask = nil
            webSocket = nil
            webSocketSession = nil
            recordingSessionID = nil
            return resources
        }
        resources.0?.cancel()
        resources.1?.cancel(with: code, reason: reason.data(using: .utf8))
        resources.2?.invalidateAndCancel()
    }

    private func cancelRESTTasks() {
        let tasks = lock.withLock {
            let tasks = Array(restTasks.values)
            restTasks.removeAll()
            reservedRESTRequestIDs.removeAll()
            return tasks
        }
        for task in tasks {
            task.cancel()
        }
    }

    private func currentSocket(sessionID: String) -> URLSessionWebSocketTask? {
        lock.withLock {
            recordingSessionID == sessionID ? webSocket : nil
        }
    }

    private func isCurrentSocket(sessionID: String) -> Bool {
        lock.withLock { recordingSessionID == sessionID }
    }

    private func sendRESTResponse(
        requestID: String,
        status: Int,
        contentType: String?,
        body: Data
    ) async throws {
        if body.isEmpty {
            try await writer.send(.rest(VoiceRESTResponse(
                requestID: requestID,
                status: status,
                contentType: contentType,
                body: Data()
            )))
            return
        }
        var sequence = 0
        var offset = 0
        while offset < body.count {
            let end = min(offset + Self.maximumRESTChunkBytes, body.count)
            try await writer.send(.rest(VoiceRESTResponse(
                requestID: requestID,
                status: status,
                contentType: contentType,
                sequence: sequence,
                isFinal: end == body.count,
                body: body.subdata(in: offset ..< end)
            )))
            sequence += 1
            offset = end
        }
    }

    static func websocketURL(
        baseURL: URL,
        recordingSessionID: String
    ) -> URL? {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("ws/voice"),
            resolvingAgainstBaseURL: false
        )
        components?.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components?.queryItems = [
            URLQueryItem(name: "source", value: "iphone"),
            URLQueryItem(
                name: "clientSessionID",
                value: recordingSessionID
            ),
        ]
        return components?.url
    }

    static func isAllowed(method: VoiceRESTMethod, path: String) -> Bool {
        guard let request = URLComponents(string: path),
              request.scheme == nil,
              request.host == nil,
              request.fragment == nil,
              request.path.hasPrefix("/"),
              !request.path.contains("..")
        else {
            return false
        }
        let components = request.path.split(
            separator: "/",
            omittingEmptySubsequences: true
        )
        if method == .get,
           request.path == "/recordings",
           request.queryItems == nil {
            return true
        }
        if method == .get,
           components.count == 3,
           components[0] == "recordings",
           components[1] == "client-session",
           request.queryItems == nil {
            return UUID(uuidString: String(components[2])) != nil
        }
        if components.first == "practice-passages" {
            return isAllowedPracticePassageRequest(
                method: method,
                components: components,
                queryItems: request.queryItems
            )
        }
        if components.first == "reference-speech" {
            guard request.queryItems == nil else { return false }
            switch (method, components.count) {
            case (.get, 2):
                return components[1] == "state"
            case (.post, 2):
                return components[1] == "artifacts"
            case (.get, 4):
                return components[1] == "artifacts"
                    && isArtifactID(String(components[2]))
                    && components[3] == "audio"
            default:
                return false
            }
        }
        guard components.count >= 2,
              components[0] == "recordings",
              isRecordingID(String(components[1])),
              request.queryItems == nil
        else {
            return false
        }
        switch (method, components.count, components.last) {
        case (.get, 2, _), (.delete, 2, _):
            return true
        case (.get, 3, "audio"), (.post, 3, "reanalyze"):
            return true
        default:
            return false
        }
    }

    private static func isAllowedPracticePassageRequest(
        method: VoiceRESTMethod,
        components: [Substring],
        queryItems: [URLQueryItem]?
    ) -> Bool {
        if components.count == 1 {
            return method == .get && isAllowedListQuery(
                queryItems,
                cursorValidator: isPassageID
            )
        }
        guard components.count >= 2,
              isPassageID(String(components[1]))
        else {
            return false
        }
        switch (method, components.count, components.last) {
        case (.get, 2, _), (.delete, 2, _):
            return queryItems == nil
        case (.post, 3, "intended-text"), (.post, 3, "baseline"):
            return queryItems == nil
        case (.get, 3, "attempts"):
            return isAllowedListQuery(
                queryItems,
                cursorValidator: isRecordingID
            )
        case (.delete, 4, _):
            return components[2] == "attempts"
                && isRecordingID(String(components[3]))
                && queryItems == nil
        default:
            return false
        }
    }

    private static func isAllowedListQuery(
        _ queryItems: [URLQueryItem]?,
        cursorValidator: (String) -> Bool
    ) -> Bool {
        guard let queryItems else { return true }
        var names = Set<String>()
        for item in queryItems {
            guard names.insert(item.name).inserted,
                  let value = item.value
            else {
                return false
            }
            switch item.name {
            case "cursor":
                guard cursorValidator(value) else { return false }
            case "limit":
                guard let limit = Int(value), (1 ... 100).contains(limit) else {
                    return false
                }
            default:
                return false
            }
        }
        return true
    }

    private static func isRecordingID(_ value: String) -> Bool {
        value.range(
            of: #"^session-\d{8}-\d{6}-\d{6}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func isPassageID(_ value: String) -> Bool {
        value.range(
            of: #"^passage-[0-9a-f]{32}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func isArtifactID(_ value: String) -> Bool {
        value.range(
            of: #"^[0-9a-f]{64}$"#,
            options: .regularExpression
        ) != nil
    }
}

private final class VoiceLoopbackWebSocketOpenGate:
    NSObject,
    URLSessionWebSocketDelegate,
    @unchecked Sendable
{
    private enum State {
        case waiting
        case opened
        case failed(Error)
    }

    private let lock = NSLock()
    private var state: State = .waiting
    private var waiters: [CheckedContinuation<Void, Error>] = []

    func waitUntilOpen() async throws {
        try await withCheckedThrowingContinuation { continuation in
            let result: Result<Void, Error>? = lock.withLock {
                switch state {
                case .waiting:
                    waiters.append(continuation)
                    return nil
                case .opened:
                    return .success(())
                case .failed(let error):
                    return .failure(error)
                }
            }
            if let result {
                continuation.resume(with: result)
            } else {
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    self?.resolve(.failure(VoiceLaneServerError.sidecarUnavailable))
                }
            }
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        resolve(.success(()))
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        resolve(.failure(VoiceLaneServerError.sidecarUnavailable))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            resolve(.failure(error))
        }
    }

    private func resolve(_ result: Result<Void, Error>) {
        let continuations: [CheckedContinuation<Void, Error>] = lock.withLock {
            guard case .waiting = state else { return [] }
            switch result {
            case .success:
                state = .opened
            case .failure(let error):
                state = .failed(error)
            }
            let continuations = waiters
            waiters.removeAll()
            return continuations
        }
        for continuation in continuations {
            continuation.resume(with: result)
        }
    }
}

@available(macOS 26.0, *)
private actor VoiceLaneWriter {
    private let stream: QUIC.Stream<QUICStream>

    init(stream: QUIC.Stream<QUICStream>) {
        self.stream = stream
    }

    func send(_ message: VoiceLaneHostMessage) async throws {
        try await QuicSessionStreamIO.sendPayload(
            VoiceLaneCodec.encode(message),
            role: .voice,
            on: stream
        )
    }
}
