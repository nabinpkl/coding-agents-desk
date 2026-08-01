import AgentDeskWire
import Foundation
import Network

enum VoiceLaneClientError: LocalizedError {
    case updateHost
    case closed
    case congested

    var errorDescription: String? {
        switch self {
        case .updateHost: "Update the Mac host to use iPhone recording."
        case .closed: "The iPhone voice connection closed."
        case .congested: "The Mac connection could not keep up with microphone audio."
        }
    }
}

enum VoiceLaneReceiveTerminationPolicy {
    static func shouldReportTransportLoss(
        isClosed: Bool,
        errorIsCancellation: Bool
    ) -> Bool {
        !isClosed && !errorIsCancellation
    }
}

@available(iOS 26.0, *)
final class VoiceLaneClient: @unchecked Sendable {
    typealias Delivery = @MainActor @Sendable (VoiceLaneHostMessage) -> Void

    private let stream: QUIC.Stream<QUICStream>
    private let writer: VoiceLaneClientWriter
    private let delivery: Delivery
    private let lock = NSLock()
    private var receiveTask: Task<Void, Never>?
    private var closed = false

    init(stream: QUIC.Stream<QUICStream>, delivery: @escaping Delivery) {
        self.stream = stream
        self.delivery = delivery
        writer = VoiceLaneClientWriter(stream: stream)
    }

    func open() async throws {
        try await writer.send(VoiceLaneCodec.encode(VoiceLaneHello()))
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
        try await writer.send(VoiceLaneCodec.encode(message))
    }

    func close() {
        guard lock.withLock({
            guard !closed else { return false }
            closed = true
            return true
        }) else { return }
        receiveTask?.cancel()
        Task { [writer] in await writer.close() }
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
            let isClosed = lock.withLock { closed }
            if VoiceLaneReceiveTerminationPolicy.shouldReportTransportLoss(
                isClosed: isClosed,
                errorIsCancellation: error is CancellationError
            ) {
                await delivery(.error(
                    requestID: nil,
                    recordingSessionID: nil,
                    code: .transportLost,
                    message: error.localizedDescription
                ))
            }
            close()
        }
    }
}

@available(iOS 26.0, *)
private actor VoiceLaneClientWriter {
    private struct Pending {
        let payload: Data
        let continuation: CheckedContinuation<Void, Error>
    }

    private static let maximumPendingMessages = 32
    private let stream: QUIC.Stream<QUICStream>
    private var pending: [Pending] = []
    private var draining = false
    private var closed = false
    private var endSent = false
    private var closeWaiters: [CheckedContinuation<Void, Never>] = []

    init(stream: QUIC.Stream<QUICStream>) {
        self.stream = stream
    }

    func send(_ payload: Data) async throws {
        guard !closed else { throw VoiceLaneClientError.closed }
        guard pending.count < Self.maximumPendingMessages else {
            throw VoiceLaneClientError.congested
        }
        try await withCheckedThrowingContinuation { continuation in
            pending.append(Pending(payload: payload, continuation: continuation))
            beginDrainIfNeeded()
        }
    }

    func close() async {
        if endSent { return }
        if !closed {
            closed = true
            let waiting = pending
            pending.removeAll()
            for item in waiting {
                item.continuation.resume(throwing: VoiceLaneClientError.closed)
            }
        }
        await withCheckedContinuation { continuation in
            closeWaiters.append(continuation)
            if !draining {
                Task { await finishClose() }
            }
        }
    }

    private func beginDrainIfNeeded() {
        guard !draining, !pending.isEmpty, !closed else { return }
        draining = true
        Task { await drain() }
    }

    private func drain() async {
        while !closed, !pending.isEmpty {
            let item = pending.removeFirst()
            do {
                try await QuicSessionStreamIO.sendPayload(
                    item.payload,
                    role: .voice,
                    on: stream
                )
                item.continuation.resume()
            } catch {
                item.continuation.resume(throwing: error)
                closed = true
                let waiting = pending
                pending.removeAll()
                for pendingItem in waiting {
                    pendingItem.continuation.resume(throwing: error)
                }
            }
        }
        draining = false
        if closed {
            await finishClose()
            return
        }
        beginDrainIfNeeded()
    }

    private func finishClose() async {
        guard closed, !endSent else { return }
        endSent = true
        try? await stream.send(Data(), endOfStream: true)
        let waiters = closeWaiters
        closeWaiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }
}
