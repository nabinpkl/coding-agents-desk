import Foundation
import SwiftProtobuf

public final class PtyClient {
    public static let protocolVersion: UInt32 = 3

    private let makeTransport: () throws -> PtyTransport

    public init(makeTransport: @escaping () throws -> PtyTransport) {
        self.makeTransport = makeTransport
    }

    public convenience init(socketPath: String = "/tmp/pty-manager.sock") {
        self.init(makeTransport: { try UnixSocketPtyTransport(socketPath: socketPath) })
    }

    public init(transport: PtyTransport) {
        self.makeTransport = { transport }
    }

    public func listSessions() async throws -> [PtySessionSummary] {
        let transport = try makeTransport()
        defer { transport.close() }
        try await send(.with {
            $0.protocolVersion = Self.protocolVersion
            $0.requestID = 1
            $0.payload = .listSessions(.init())
        }, transport: transport)
        let envelope = try await receiveEnvelope(transport: transport)
        switch envelope.payload {
        case .sessionList(let list):
            return list.sessions.map(PtySessionSummary.init(proto:))
        case .error(let error):
            throw PtyClientError.daemonError(error.message)
        case .none:
            throw PtyClientError.missingPayload
        default:
            throw PtyClientError.unexpectedPayload(String(describing: envelope.payload))
        }
    }

    public func sessionSnapshots() -> AsyncThrowingStream<[PtySessionSummary], Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let transport = try makeTransport()
                    defer { transport.close() }
                    try await send(.with {
                        $0.protocolVersion = Self.protocolVersion
                        $0.requestID = 1
                        $0.payload = .subscribeSessions(.init())
                    }, transport: transport)

                    while !Task.isCancelled {
                        let envelope = try await receiveEnvelope(transport: transport)
                        switch envelope.payload {
                        case .sessionSnapshot(let snapshot):
                            continuation.yield(snapshot.sessions.map(PtySessionSummary.init(proto:)))
                        case .error(let error):
                            throw PtyClientError.daemonError(error.message)
                        case .none:
                            throw PtyClientError.missingPayload
                        default:
                            throw PtyClientError.unexpectedPayload(String(describing: envelope.payload))
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

    public func openSession(
        name: String,
        cwd: String,
        shell: String,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool = true,
        clientTitle: String = ""
    ) async throws -> PtySessionConnection {
        let transport = try makeTransport()
        do {
            try await send(.with {
                $0.protocolVersion = Self.protocolVersion
                $0.requestID = 1
                $0.sessionName = name
                $0.payload = .createOrAttach(.with {
                    $0.cwd = cwd
                    $0.shell = shell
                    $0.columns = columns
                    $0.rows = rows
                    $0.createIfMissing = createIfMissing
                    $0.clientTitle = clientTitle
                })
            }, transport: transport)

            while true {
                let envelope = try await receiveEnvelope(transport: transport)
                switch envelope.payload {
                case .attached(let attached):
                    return PtySessionConnection(
                        sessionName: envelope.sessionName.isEmpty ? name : envelope.sessionName,
                        attachment: PtySessionConnection.attachment(
                            from: attached,
                            sessionName: envelope.sessionName.isEmpty ? name : envelope.sessionName
                        ),
                        transport: transport
                    )
                case .error(let error):
                    throw PtyClientError.daemonError(error.message)
                case .none:
                    throw PtyClientError.missingPayload
                default:
                    continue
                }
            }
        } catch {
            transport.close()
            throw error
        }
    }

    public func killSession(name: String) async throws {
        let transport = try makeTransport()
        defer { transport.close() }
        try await send(.with {
            $0.protocolVersion = Self.protocolVersion
            $0.requestID = 1
            $0.sessionName = name
            $0.payload = .killSession(.init())
        }, transport: transport)
        let envelope = try await receiveEnvelope(transport: transport)
        switch envelope.payload {
        case .sessionExited, .none:
            return
        case .error(let error):
            throw PtyClientError.daemonError(error.message)
        default:
            throw PtyClientError.unexpectedPayload(String(describing: envelope.payload))
        }
    }

    public func closeClient(sessionName: String, clientID: UInt64) async throws {
        let transport = try makeTransport()
        defer { transport.close() }
        try await send(.with {
            $0.protocolVersion = Self.protocolVersion
            $0.requestID = 1
            $0.sessionName = sessionName
            $0.payload = .closeClient(.with {
                $0.clientID = clientID
            })
        }, transport: transport)
        let envelope = try await receiveEnvelope(transport: transport)
        switch envelope.payload {
        case .clientDetached(let detached) where detached.clientID == clientID:
            return
        case .error(let error):
            throw PtyClientError.daemonError(error.message)
        case .none:
            throw PtyClientError.missingPayload
        default:
            throw PtyClientError.unexpectedPayload(String(describing: envelope.payload))
        }
    }

    private func send(_ envelope: Pty_V1_Envelope, transport: PtyTransport) async throws {
        try await transport.sendFrame(try envelope.serializedData())
    }

    private func receiveEnvelope(transport: PtyTransport) async throws -> Pty_V1_Envelope {
        let data = try await transport.receiveFrame()
        let envelope = try Pty_V1_Envelope(serializedBytes: data)
        guard envelope.protocolVersion == Self.protocolVersion else {
            throw PtyClientError.invalidProtocolVersion(envelope.protocolVersion)
        }
        return envelope
    }
}

private extension PtySessionSummary {
    init(proto: Pty_V1_SessionSummary) {
        self.init(
            name: proto.name,
            cwd: proto.cwd,
            shell: proto.shell,
            pid: proto.pid,
            state: .init(proto: proto.state),
            clients: proto.clients.map(PtySessionClientSummary.init(proto:))
        )
    }
}

private extension PtySessionClientSummary {
    init(proto: Pty_V1_ClientSummary) {
        self.init(id: proto.id, title: proto.title)
    }
}

private extension PtySessionSummary.State {
    init(proto: Pty_V1_SessionState) {
        switch proto {
        case .running:
            self = .running
        case .exited:
            self = .exited
        case .unspecified, .UNRECOGNIZED:
            self = .unspecified
        }
    }
}
