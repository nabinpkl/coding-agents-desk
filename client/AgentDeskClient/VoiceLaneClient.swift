import AgentDeskWire
import Foundation
import Network

enum VoiceLaneClientError: LocalizedError {
    case updateHost
    case closed

    var errorDescription: String? {
        switch self {
        case .updateHost: "Update the Mac host to use iPhone recording."
        case .closed: "The iPhone voice connection closed."
        }
    }
}

@available(iOS 26.0, *)
final class VoiceLaneClient: @unchecked Sendable {
    typealias Delivery = @MainActor @Sendable (VoiceLaneHostMessage) -> Void

    private let stream: QUIC.Stream<QUICStream>
    private let delivery: Delivery
    private let lock = NSLock()
    private var receiveTask: Task<Void, Never>?
    private var closed = false

    init(stream: QUIC.Stream<QUICStream>, delivery: @escaping Delivery) {
        self.stream = stream
        self.delivery = delivery
    }

    func open() async throws {
        try await QuicSessionStreamIO.sendPayload(
            VoiceLaneCodec.encode(VoiceLaneHello()),
            role: .voice,
            on: stream
        )
        let ready: VoiceLaneHostMessage
        do {
            ready = try await withThrowingTaskGroup(of: VoiceLaneHostMessage.self) { group in
                group.addTask { [stream] in
                    let frame = try await QuicSessionStreamIO.receiveFrame(
                        on: stream,
                        expectedRole: .voice
                    )
                    return try VoiceLaneCodec.decode(
                        VoiceLaneHostMessage.self,
                        from: frame.payload
                    )
                }
                group.addTask {
                    try await Task.sleep(for: .seconds(3))
                    throw VoiceLaneClientError.updateHost
                }
                let result = try await group.next()!
                group.cancelAll()
                return result
            }
        } catch {
            // An older host rejects the unknown role before it can speak the
            // voice-lane protocol, so every handshake failure maps to the one
            // actionable compatibility message.
            throw VoiceLaneClientError.updateHost
        }
        guard ready == .ready else { throw VoiceLaneClientError.updateHost }
        receiveTask = Task { [weak self] in await self?.receiveLoop() }
    }

    func send(_ message: VoiceLaneClientMessage) async throws {
        guard lock.withLock({ !closed }) else { throw VoiceLaneClientError.closed }
        try await QuicSessionStreamIO.sendPayload(
            VoiceLaneCodec.encode(message),
            role: .voice,
            on: stream
        )
    }

    func close() {
        guard lock.withLock({
            guard !closed else { return false }
            closed = true
            return true
        }) else { return }
        receiveTask?.cancel()
        Task { [stream] in try? await stream.send(Data(), endOfStream: true) }
    }

    private func receiveLoop() async {
        do {
            while !Task.isCancelled {
                let frame = try await QuicSessionStreamIO.receiveFrame(
                    on: stream,
                    expectedRole: .voice
                )
                let message = try VoiceLaneCodec.decode(
                    VoiceLaneHostMessage.self,
                    from: frame.payload
                )
                await delivery(message)
            }
        } catch {
            await delivery(.error(
                requestID: nil,
                recordingSessionID: nil,
                code: .transportLost,
                message: error.localizedDescription
            ))
            close()
        }
    }
}
