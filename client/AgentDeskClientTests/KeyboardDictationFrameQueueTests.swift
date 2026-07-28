import Foundation
import Testing

private actor KeyboardFrameCollector {
    private(set) var sequences: [Int] = []

    func append(_ sequence: Int) {
        sequences.append(sequence)
    }
}

private actor KeyboardFrameSendGate {
    private var started = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        started = true
        await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilStarted() async {
        while !started {
            await Task.yield()
        }
    }

    func open() {
        continuation?.resume()
        continuation = nil
    }
}

struct KeyboardDictationFrameQueueTests {
    @Test
    func sendsOutOfOrderArrivalsInSequenceBeforeFlushReturns() async throws {
        let collector = KeyboardFrameCollector()
        let queue = KeyboardDictationFrameQueue()
        try await queue.reset { frame in
            await collector.append(frame.sequence)
        }

        try await queue.enqueue(frame(sequence: 1))
        try await queue.enqueue(frame(sequence: 0))
        try await queue.flush(through: 1)

        #expect(await collector.sequences == [0, 1])
    }

    @Test
    func overflowFailsTheTakeInsteadOfDroppingAudio() async throws {
        let gate = KeyboardFrameSendGate()
        let queue = KeyboardDictationFrameQueue(maximumPendingFrames: 2)
        try await queue.reset { _ in
            await gate.wait()
        }
        try await queue.enqueue(frame(sequence: 0))
        await gate.waitUntilStarted()
        try await queue.enqueue(frame(sequence: 1))
        try await queue.enqueue(frame(sequence: 2))

        await #expect(throws: KeyboardDictationCoordinatorError.self) {
            try await queue.enqueue(frame(sequence: 3))
        }
        await gate.open()
    }

    private func frame(sequence: Int) -> KeyboardDictationPCMFrame {
        KeyboardDictationPCMFrame(
            sequence: sequence,
            samples: Data([UInt8(sequence)])
        )
    }
}
