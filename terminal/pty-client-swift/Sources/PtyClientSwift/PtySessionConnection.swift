import Foundation

public final class PtySessionConnection: @unchecked Sendable {
    public let sessionName: String
    public let attachment: PtySessionAttachment

    private let transport: PtyTransport
    private let requestIDs = PtyRequestIDGenerator()
    private let eventsStarted = NSLock()
    private var didStartEvents = false

    init(sessionName: String, attachment: PtySessionAttachment, transport: PtyTransport) {
        self.sessionName = sessionName
        self.attachment = attachment
        self.transport = transport
    }

    deinit {
        transport.close()
    }

    public func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        AsyncThrowingStream { continuation in
            eventsStarted.lock()
            let canStart = !didStartEvents
            didStartEvents = true
            eventsStarted.unlock()

            guard canStart else {
                continuation.finish(throwing: PtyClientError.eventsAlreadyStarted)
                return
            }

            continuation.yield(.attached(attachment))
            let task = Task {
                do {
                    while !Task.isCancelled {
                        let envelope = try await Self.receiveEnvelope(transport: transport)
                        guard envelope.sessionName == sessionName || envelope.sessionName.isEmpty else {
                            continue
                        }
                        switch envelope.payload {
                        case .output(let output):
                            continuation.yield(.output(output.data))
                        case .sessionExited(let exited):
                            continuation.yield(.exited(exited.status))
                            continuation.finish()
                            transport.close()
                            return
                        case .clientDetached(let detached):
                            continuation.yield(.detachedByManager(detached.clientID))
                            continuation.finish()
                            transport.close()
                            return
                        case .error(let error):
                            continuation.yield(.error(error.message))
                            continuation.finish(throwing: PtyClientError.daemonError(error.message))
                            transport.close()
                            return
                        case .attached(let attached):
                            continuation.yield(.attached(Self.attachment(from: attached, sessionName: sessionName)))
                        case .none:
                            throw PtyClientError.missingPayload
                        default:
                            continue
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func sendInput(_ data: Data) async throws {
        try await send(.input(.with { $0.data = data }))
    }

    public func resize(columns: UInt32, rows: UInt32) async throws {
        try await send(.resize(.with {
            $0.columns = columns
            $0.rows = rows
        }))
    }

    public func detach() async throws {
        defer { transport.close() }
        try await send(.detach(.init()))
    }

    public func kill() async throws {
        try await send(.killSession(.init()))
    }

    private func send(_ payload: Pty_V1_Envelope.OneOf_Payload) async throws {
        let envelope = Pty_V1_Envelope.with {
            $0.protocolVersion = PtyClient.protocolVersion
            $0.requestID = requestIDs.next()
            $0.sessionName = sessionName
            $0.payload = payload
        }
        try await transport.sendFrame(try envelope.serializedData())
    }

    static func receiveEnvelope(transport: PtyTransport) async throws -> Pty_V1_Envelope {
        let data = try await transport.receiveFrame()
        let envelope = try Pty_V1_Envelope(serializedBytes: data)
        guard envelope.protocolVersion == PtyClient.protocolVersion else {
            throw PtyClientError.invalidProtocolVersion(envelope.protocolVersion)
        }
        return envelope
    }

    static func attachment(from attached: Pty_V1_Attached, sessionName: String) -> PtySessionAttachment {
        PtySessionAttachment(
            name: sessionName,
            pid: attached.pid,
            cwd: attached.cwd,
            shell: attached.shell,
            clientCount: attached.clientCount,
            clientID: attached.clientID
        )
    }
}

final class PtyRequestIDGenerator: @unchecked Sendable {
    private let lock = NSLock()
    private var value: UInt64 = 1

    func next() -> UInt64 {
        lock.lock()
        defer { lock.unlock() }
        value += 1
        return value
    }
}
