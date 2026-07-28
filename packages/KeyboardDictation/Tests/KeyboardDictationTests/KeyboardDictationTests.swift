import Foundation
import Testing
@testable import KeyboardDictation

struct KeyboardDictationTests {
    @Test func handoffURLRoundTripsRequest() {
        let requestID = UUID()
        #expect(KeyboardDictationContract.requestID(
            from: KeyboardDictationContract.handoffURL(requestID: requestID)
        ) == requestID)
        #expect(KeyboardDictationContract.requestID(
            from: URL(string: "agentdesk://pair")!
        ) == nil)
    }

    @Test func handoffCanOnlyBeConsumedOnce() throws {
        let store = try makeStore()
        let request = try store.prepareHandoff(
            createdAt: Date(timeIntervalSince1970: 1_234.567)
        )

        #expect(try store.consumeHandoff(requestID: request.id) == request)
        #expect(throws: KeyboardDictationStoreError.unexpectedHandoffRequest) {
            try store.consumeHandoff(requestID: request.id)
        }
    }

    @Test func serviceCommandAndPreferencesRoundTrip() throws {
        let store = try makeStore()
        let generation = UUID()
        let timestamp = Date(timeIntervalSince1970: 1_234.567)
        let command = KeyboardDictationCommand(
            generationID: generation,
            kind: .start,
            createdAt: timestamp
        )
        let snapshot = KeyboardDictationServiceSnapshot(
            generationID: generation,
            phase: .recording,
            captureSessionID: UUID(),
            acknowledgedCommandID: command.id,
            partialTranscript: "hello",
            meterLevel: 0.42,
            updatedAt: timestamp
        )

        try store.saveCommand(command)
        try store.saveServiceSnapshot(snapshot)
        try store.savePreferences(KeyboardDictationPreferences(
            insertionMode: .explicitReview
        ))

        #expect(try store.pendingCommand() == command)
        #expect(try store.serviceSnapshot() == snapshot)
        #expect(try store.preferences().insertionMode == .explicitReview)
        try store.clearCommand(ifMatching: command.id)
        #expect(try store.pendingCommand() == nil)
    }

    @Test func commandGenerationAndAcknowledgementRemainCorrelated() {
        let currentGeneration = UUID()
        let staleCommand = KeyboardDictationCommand(
            generationID: UUID(),
            kind: .ping
        )
        let currentCommand = KeyboardDictationCommand(
            generationID: currentGeneration,
            kind: .ping
        )
        var snapshot = KeyboardDictationServiceSnapshot(
            generationID: currentGeneration,
            phase: .ready
        )

        #expect(staleCommand.generationID != snapshot.generationID)
        #expect(currentCommand.generationID == snapshot.generationID)
        snapshot = snapshot.acknowledging(currentCommand.id)
        #expect(snapshot.acknowledgedCommandID == currentCommand.id)
        #expect(snapshot.generationID == currentGeneration)
        #expect(snapshot.phase == .ready)
    }

    @Test func malformedAndOversizedStateFailsLoudly() throws {
        let store = try makeStore()
        try Data("not-json".utf8).write(
            to: store.directoryURL.appendingPathComponent("service.json")
        )
        #expect(throws: KeyboardDictationStoreError.invalidStoredValue(
            "service state"
        )) {
            try store.serviceSnapshot()
        }

        let oversized = String(
            repeating: "x",
            count: KeyboardDictationContract.maximumTranscriptUTF8Bytes + 1
        )
        #expect(throws: KeyboardDictationStoreError.valueTooLarge(
            "final transcript"
        )) {
            try store.saveServiceSnapshot(
                KeyboardDictationServiceSnapshot(
                    generationID: UUID(),
                    phase: .completed,
                    finalTranscript: oversized
                )
            )
        }
    }

    @Test func consumptionLogIsDeduplicatedAndBounded() {
        var log = KeyboardDictationConsumptionLog()
        for index in 0..<40 {
            log.record(recordingID: "recording-\(index)")
        }
        log.record(recordingID: "recording-39")

        #expect(log.entries.count == 32)
        #expect(log.entries.last?.recordingID == "recording-39")
        #expect(log.entries.filter {
            $0.recordingID == "recording-39"
        }.count == 1)
    }

    @Test func expiredCompletedResultReturnsServiceToReady() throws {
        let store = try makeStore()
        let generation = UUID()
        let completedAt = Date(timeIntervalSince1970: 1_000)
        try store.saveServiceSnapshot(KeyboardDictationServiceSnapshot(
            generationID: generation,
            phase: .completed,
            finalTranscript: "hello",
            recordingID: "recording-1",
            updatedAt: completedAt
        ))
        try store.saveDraft(KeyboardDictationDraft(
            recordingID: "recording-1",
            text: "edited"
        ))

        try store.purgeExpiredResult(
            now: completedAt.addingTimeInterval(
                KeyboardDictationContract.resultLifetime + 1
            )
        )

        #expect(try store.serviceSnapshot().phase == .ready)
        #expect(try store.draft() == nil)
    }

    @Test func alphabetShiftCapsAndPagesAreDeterministic() {
        var state = KeyboardLayoutState()
        #expect(state.handle(.character("a")) == "a")
        #expect(state.handle(.shift) == nil)
        #expect(state.handle(.character("a")) == "A")
        #expect(state.shift == .off)
        _ = state.handle(.shift)
        _ = state.handle(.shift)
        #expect(state.shift == .locked)
        #expect(state.handle(.character("b")) == "B")
        #expect(state.shift == .locked)
        _ = state.handle(.page(.numbers))
        #expect(state.page == .numbers)
        #expect(state.shift == .off)
        #expect(state.handle(.character("1")) == "1")
    }

    @Test func automaticShiftDoesNotClearCapsLock() {
        var state = KeyboardLayoutState(shift: .locked)
        state.setAutomaticShift(false)
        #expect(state.shift == .locked)
    }

    @Test func capsLockRequiresADoubleShiftTap() {
        var state = KeyboardLayoutState()
        state.handleShiftTap(isDoubleTap: false)
        #expect(state.shift == .on)
        state.handleShiftTap(isDoubleTap: false)
        #expect(state.shift == .off)
        state.handleShiftTap(isDoubleTap: false)
        state.handleShiftTap(isDoubleTap: true)
        #expect(state.shift == .locked)
    }

    @Test func emailAndURLLayoutsExposeTargetKeys() {
        var state = KeyboardLayoutState(fieldKind: .email)
        #expect(state.rows.last?.contains(.character("@")) == true)
        #expect(state.rows.last?.contains(.character(".")) == true)
        state.fieldKind = .url
        #expect(state.rows.last?.contains(.character("/")) == true)
        #expect(state.rows.last?.contains(.character(".")) == true)
    }

    @Test func automaticInsertionRequiresSameActiveContext() {
        let documentIdentifier = UUID()
        let context = KeyboardDocumentContextFingerprint(
            beforeInput: "before",
            afterInput: "after",
            selectedText: nil
        )
        #expect(KeyboardAutomaticInsertionGuard.allowsInsertion(
            captureContext: context,
            currentContext: context,
            captureDocumentIdentifier: documentIdentifier,
            currentDocumentIdentifier: documentIdentifier,
            keyboardControllerIsActive: true
        ))
        #expect(!KeyboardAutomaticInsertionGuard.allowsInsertion(
            captureContext: context,
            currentContext: KeyboardDocumentContextFingerprint(
                beforeInput: "changed",
                afterInput: "after",
                selectedText: nil
            ),
            captureDocumentIdentifier: documentIdentifier,
            currentDocumentIdentifier: documentIdentifier,
            keyboardControllerIsActive: true
        ))
        #expect(!KeyboardAutomaticInsertionGuard.allowsInsertion(
            captureContext: context,
            currentContext: context,
            captureDocumentIdentifier: documentIdentifier,
            currentDocumentIdentifier: documentIdentifier,
            keyboardControllerIsActive: false
        ))
        #expect(!KeyboardAutomaticInsertionGuard.allowsInsertion(
            captureContext: context,
            currentContext: context,
            captureDocumentIdentifier: UUID(),
            currentDocumentIdentifier: UUID(),
            keyboardControllerIsActive: true
        ))
    }

    @Test func commandTimeoutPreservesTheUnacknowledgedCommand() {
        #expect(
            KeyboardDictationInteractionPolicy.commandTimeoutAction(
                hasUnacknowledgedCommand: true
            ) == .waitForAcknowledgement
        )
        #expect(
            KeyboardDictationInteractionPolicy.commandTimeoutAction(
                hasUnacknowledgedCommand: false
            ) == .probeLiveness
        )
    }

    @Test func activeDraftIsNotPresentedAgainDuringPolling() {
        #expect(!KeyboardDictationInteractionPolicy.shouldPresentDraft(
            recordingID: "recording-1",
            typingTarget: .draft(recordingID: "recording-1")
        ))
        #expect(KeyboardDictationInteractionPolicy.shouldPresentDraft(
            recordingID: "recording-2",
            typingTarget: .draft(recordingID: "recording-1")
        ))
    }

    @Test func documentFingerprintBoundsHostContext() {
        let fingerprint = KeyboardDocumentContextFingerprint(
            beforeInput: String(repeating: "a", count: 200),
            afterInput: String(repeating: "b", count: 200),
            selectedText: String(repeating: "c", count: 200)
        )
        #expect(fingerprint.beforeInput?.count == 128)
        #expect(fingerprint.afterInput?.count == 128)
        #expect(fingerprint.selectedText?.count == 128)
    }

    private func makeStore() throws -> KeyboardDictationStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        return try KeyboardDictationStore(directoryURL: directory)
    }
}
