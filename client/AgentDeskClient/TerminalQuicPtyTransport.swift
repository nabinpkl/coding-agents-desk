import Foundation
import Network
import AgentDeskWire
import PtyClientSwift

enum TerminalQuicPtyTransportError: Error {
    case unexpectedRole(QuicSessionStreamRole)
}

@available(iOS 26.0, *)
final class TerminalQuicPtyTransport: PtyTransport, @unchecked Sendable {
    private let stream: QUIC.Stream<QUICStream>
    private let stateLock = NSLock()
    private var closed = false

    init(stream: QUIC.Stream<QUICStream>) {
        self.stream = stream
    }

    func announce() async throws {
        try ensureOpen()
        try await QuicSessionStreamIO.sendPayload(Data([0]), role: .terminal, on: stream)
    }

    func sendFrame(_ data: Data) async throws {
        try ensureOpen()
        try await QuicSessionStreamIO.sendPayload(data, role: .terminal, on: stream)
    }

    func receiveFrame() async throws -> Data {
        try ensureOpen()
        let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
        guard frame.role == .terminal else {
            throw TerminalQuicPtyTransportError.unexpectedRole(frame.role)
        }
        return frame.payload
    }

    func close() {
        guard markClosed() else { return }
        Task { [stream] in
            try? await stream.send(Data(), endOfStream: true)
        }
    }

    private func ensureOpen() throws {
        stateLock.lock()
        let isClosed = closed
        stateLock.unlock()
        if isClosed { throw PtyClientError.closed }
    }

    private func markClosed() -> Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        guard !closed else { return false }
        closed = true
        return true
    }
}
