import Foundation
import KeyboardDictation
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
    func intentionalVoiceLaneCloseDoesNotReportTransportLoss() {
        #expect(!VoiceLaneReceiveTerminationPolicy.shouldReportTransportLoss(
            isClosed: true,
            errorIsCancellation: true
        ))
        #expect(!VoiceLaneReceiveTerminationPolicy.shouldReportTransportLoss(
            isClosed: true,
            errorIsCancellation: false
        ))
        #expect(!VoiceLaneReceiveTerminationPolicy.shouldReportTransportLoss(
            isClosed: false,
            errorIsCancellation: true
        ))
        #expect(VoiceLaneReceiveTerminationPolicy.shouldReportTransportLoss(
            isClosed: false,
            errorIsCancellation: false
        ))
    }

    @Test
    func staleLifecycleCallbacksAreRejected() {
        let activeGeneration = UUID()
        #expect(!KeyboardDictationLifecyclePolicy.acceptsLaneCallback(
            callbackGeneration: UUID(),
            activeGeneration: activeGeneration
        ))
        #expect(KeyboardDictationLifecyclePolicy.acceptsLaneCallback(
            callbackGeneration: activeGeneration,
            activeGeneration: activeGeneration
        ))
        #expect(!KeyboardDictationLifecyclePolicy.acceptsSocketCompletion(
            requestID: "stale",
            activeRequestID: "current"
        ))
        #expect(KeyboardDictationLifecyclePolicy.acceptsSocketCompletion(
            requestID: "current",
            activeRequestID: "current"
        ))
        #expect(!KeyboardDictationLifecyclePolicy.acceptsCaptureCallback(
            captureSessionID: UUID(),
            activeSessionID: activeGeneration
        ))
        #expect(KeyboardDictationLifecyclePolicy.acceptsCaptureCallback(
            captureSessionID: activeGeneration,
            activeSessionID: activeGeneration
        ))
    }

    @Test
    func containingAppPresentationTracksEveryServicePhase() {
        let generationID = UUID()
        let cases: [
            (
                KeyboardDictationServicePhase,
                KeyboardDictationContainingAppState
            )
        ] = [
            (.inactive, .inactive),
            (.arming, .arming),
            (.ready, .ready),
            (.recording, .recording),
            (.saving, .finalizing),
            (.transcribing, .finalizing),
            (.analyzing, .finalizing),
            (.completed, .ready),
            (.failed, .failed),
        ]

        for (phase, expected) in cases {
            let snapshot = KeyboardDictationServiceSnapshot(
                generationID: phase == .inactive ? nil : generationID,
                phase: phase
            )
            #expect(
                KeyboardDictationContainingAppState(snapshot: snapshot)
                    == expected
            )
        }

        #expect(KeyboardDictationContainingAppState.inactive
            .settingsActionTitle == "Activate Keyboard Dictation")
        #expect(KeyboardDictationContainingAppState.ready
            .settingsActionTitle == "Manage Keyboard Dictation")
        #expect(KeyboardDictationLifecyclePolicy.canUseInAgentDesk(
            snapshot: KeyboardDictationServiceSnapshot(
                generationID: generationID,
                phase: .ready
            )
        ))
        #expect(!KeyboardDictationLifecyclePolicy.canUseInAgentDesk(
            snapshot: KeyboardDictationServiceSnapshot(
                generationID: generationID,
                phase: .recording
            )
        ))
        #expect(KeyboardDictationLifecyclePolicy.canUseInAgentDesk(
            snapshot: KeyboardDictationServiceSnapshot(
                generationID: generationID,
                phase: .failed
            )
        ))
        #expect(!KeyboardDictationLifecyclePolicy.canUseInAgentDesk(
            snapshot: KeyboardDictationServiceSnapshot(
                generationID: nil,
                phase: .failed
            )
        ))
    }

    @Test @MainActor
    func snapshotObserversAreIndependentAndRemovable() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let coordinator = KeyboardDictationCoordinator(
            store: try KeyboardDictationStore(directoryURL: directory)
        )
        var first: [KeyboardDictationServicePhase] = []
        var second: [KeyboardDictationServicePhase] = []
        let firstID = coordinator.observeSnapshots {
            first.append($0.phase)
        }
        let secondID = coordinator.observeSnapshots {
            second.append($0.phase)
        }

        coordinator.turnOff()
        coordinator.removeSnapshotObserver(firstID)
        coordinator.turnOff()
        coordinator.removeSnapshotObserver(secondID)

        #expect(first == [.inactive, .inactive])
        #expect(second == [.inactive, .inactive, .inactive])
    }

    @Test
    func sendsOutOfOrderArrivalsInSequenceBeforeFlushReturns() async throws {
        let collector = KeyboardFrameCollector()
        let queue = KeyboardDictationFrameQueue()
        let captureSessionID = UUID()
        try await queue.reset(captureSessionID: captureSessionID) { frame in
            await collector.append(frame.sequence)
        }

        try await queue.enqueue(frame(
            captureSessionID: captureSessionID,
            sequence: 1
        ))
        try await queue.enqueue(frame(
            captureSessionID: captureSessionID,
            sequence: 0
        ))
        try await queue.flush(through: 1)

        #expect(await collector.sequences == [0, 1])
    }

    @Test
    func ignoresFramesFromAReplacedCaptureSession() async throws {
        let collector = KeyboardFrameCollector()
        let queue = KeyboardDictationFrameQueue()
        let captureSessionID = UUID()
        try await queue.reset(captureSessionID: captureSessionID) { frame in
            await collector.append(frame.sequence)
        }

        try await queue.enqueue(frame(
            captureSessionID: UUID(),
            sequence: 0
        ))
        try await queue.enqueue(frame(
            captureSessionID: captureSessionID,
            sequence: 0
        ))
        try await queue.flush(through: 0)

        #expect(await collector.sequences == [0])
    }

    @Test
    func overflowFailsTheTakeInsteadOfDroppingAudio() async throws {
        let gate = KeyboardFrameSendGate()
        let queue = KeyboardDictationFrameQueue(maximumPendingFrames: 2)
        let captureSessionID = UUID()
        try await queue.reset(captureSessionID: captureSessionID) { _ in
            await gate.wait()
        }
        try await queue.enqueue(frame(
            captureSessionID: captureSessionID,
            sequence: 0
        ))
        await gate.waitUntilStarted()
        try await queue.enqueue(frame(
            captureSessionID: captureSessionID,
            sequence: 1
        ))
        try await queue.enqueue(frame(
            captureSessionID: captureSessionID,
            sequence: 2
        ))

        await #expect(throws: KeyboardDictationCoordinatorError.self) {
            try await queue.enqueue(frame(
                captureSessionID: captureSessionID,
                sequence: 3
            ))
        }
        await gate.open()
    }

    private func frame(
        captureSessionID: UUID,
        sequence: Int
    ) -> KeyboardDictationPCMFrame {
        KeyboardDictationPCMFrame(
            captureSessionID: captureSessionID,
            sequence: sequence,
            samples: Data([UInt8(sequence)])
        )
    }
}
