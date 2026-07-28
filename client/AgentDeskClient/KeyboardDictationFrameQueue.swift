import Foundation

/// Bounded, ordered handoff between the realtime audio callback and the
/// authenticated voice lane. A failed sender poisons the current take; reset is
/// permitted only after all flush waiters have settled.
actor KeyboardDictationFrameQueue {
    typealias Sender = @Sendable (KeyboardDictationPCMFrame) async throws -> Void

    private struct Waiter {
        let through: Int
        let continuation: CheckedContinuation<Void, Error>
    }

    private let maximumPendingFrames: Int
    private var captureSessionID: UUID?
    private var sender: Sender?
    private var pending: [Int: KeyboardDictationPCMFrame] = [:]
    private var nextSequence = 0
    private var sentThrough = -1
    private var draining = false
    private var terminalError: Error?
    private var waiters: [Waiter] = []

    init(maximumPendingFrames: Int = 32) {
        self.maximumPendingFrames = maximumPendingFrames
    }

    func reset(
        captureSessionID: UUID,
        sender: @escaping Sender
    ) throws {
        guard !draining, waiters.isEmpty else {
            throw KeyboardDictationCoordinatorError.audioQueueClosed
        }
        self.captureSessionID = captureSessionID
        self.sender = sender
        pending.removeAll(keepingCapacity: true)
        nextSequence = 0
        sentThrough = -1
        terminalError = nil
    }

    func enqueue(_ frame: KeyboardDictationPCMFrame) throws {
        if let terminalError {
            throw terminalError
        }
        guard frame.captureSessionID == captureSessionID else {
            return
        }
        guard pending.count < maximumPendingFrames else {
            let error = KeyboardDictationCoordinatorError.audioQueueOverflow
            fail(error)
            throw error
        }
        guard frame.sequence >= nextSequence,
              pending[frame.sequence] == nil
        else {
            return
        }
        pending[frame.sequence] = frame
        beginDrainIfNeeded()
    }

    func flush(through sequence: Int) async throws {
        if let terminalError {
            throw terminalError
        }
        guard sequence >= 0, sentThrough < sequence else { return }
        try await withCheckedThrowingContinuation { continuation in
            waiters.append(Waiter(
                through: sequence,
                continuation: continuation
            ))
            beginDrainIfNeeded()
        }
    }

    func cancel(_ error: Error) {
        fail(error)
    }

    private func beginDrainIfNeeded() {
        guard !draining,
              terminalError == nil,
              pending[nextSequence] != nil,
              sender != nil
        else {
            return
        }
        draining = true
        Task { await drain() }
    }

    private func drain() async {
        guard let sender else {
            fail(KeyboardDictationCoordinatorError.audioQueueClosed)
            draining = false
            return
        }
        while terminalError == nil,
              let frame = pending.removeValue(forKey: nextSequence) {
            do {
                try await sender(frame)
            } catch {
                fail(error)
                break
            }
            sentThrough = nextSequence
            nextSequence += 1
            resolveWaiters()
        }
        draining = false
        beginDrainIfNeeded()
    }

    private func fail(_ error: Error) {
        guard terminalError == nil else { return }
        terminalError = error
        pending.removeAll()
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.continuation.resume(throwing: error)
        }
    }

    private func resolveWaiters() {
        var unresolved: [Waiter] = []
        for waiter in waiters {
            if sentThrough >= waiter.through {
                waiter.continuation.resume()
            } else {
                unresolved.append(waiter)
            }
        }
        waiters = unresolved
    }
}
