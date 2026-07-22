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
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(256)) { continuation in
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
                            continuation.yield(.output(data: output.data, revision: output.revision))
                        case .terminalViewportStatus(let status):
                            guard status.sourceColumns > 0, status.sourceRows > 0,
                                  status.viewColumns > 0, status.viewRows > 0 else {
                                throw PtyClientError.unexpectedPayload("invalid terminal viewport status")
                            }
                            continuation.yield(.viewportStatus(.init(
                                ownershipEpoch: status.ownershipEpoch,
                                ownerClientID: status.ownerClientID,
                                ownerTitle: status.ownerTitle,
                                isOwner: status.isOwner,
                                sourceDimensions: .init(
                                    columns: status.sourceColumns,
                                    rows: status.sourceRows
                                ),
                                sourceRevision: status.sourceRevision,
                                viewDimensions: .init(
                                    columns: status.viewColumns,
                                    rows: status.viewRows
                                )
                            )))
                        case .terminalCheckpointBegin(let begin):
                            continuation.yield(.checkpointBegan(.init(
                                checkpointID: begin.checkpointID,
                                revision: begin.revision,
                                columns: begin.columns,
                                rows: begin.rows,
                                totalBytes: begin.totalBytes,
                                chunkCount: begin.chunkCount,
                                historyTruncated: begin.historyTruncated
                            )))
                        case .terminalCheckpointChunk(let chunk):
                            continuation.yield(.checkpointChunk(
                                checkpointID: chunk.checkpointID,
                                index: chunk.index,
                                data: chunk.data
                            ))
                        case .terminalCheckpointEnd(let end):
                            continuation.yield(.checkpointEnded(
                                checkpointID: end.checkpointID,
                                revision: end.revision
                            ))
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

    public func updateViewerState(
        sequence: UInt64,
        active: Bool,
        claim: Bool,
        columns: UInt32,
        rows: UInt32
    ) async throws {
        try await send(.terminalViewerState(.with {
            $0.sequence = sequence
            $0.active = active
            $0.claim = claim
            $0.columns = columns
            $0.rows = rows
        }))
    }

    public func requestCheckpoint(lastAppliedRevision: UInt64) async throws {
        try await send(.requestTerminalCheckpoint(.with {
            $0.lastAppliedRevision = lastAppliedRevision
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
            clientID: attached.clientID,
            columns: attached.columns,
            rows: attached.rows,
            revision: attached.revision,
            ownerClientID: attached.ownerClientID,
            ownershipEpoch: attached.ownershipEpoch
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
