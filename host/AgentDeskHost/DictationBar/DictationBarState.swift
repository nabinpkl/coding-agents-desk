import AppKit
import InteractionPanel

/// Pure ownership state for the all-Spaces dictation shell. Keeping these
/// decisions outside AppKit makes Fn readiness, top-bar busy gating, panel
/// sizing, and final insertion deduplication directly testable.
struct DictationBarState {
    enum CaptureCommand: String, Equatable {
        case start
        case stop
    }

    /// Fn arrives as a raw modifier-flags stream, so most events carry no
    /// edge at all. Naming why an event produced no command keeps the shell's
    /// log able to separate "Fn never reached us" from "the mini was not ready".
    enum CaptureDecision: Equatable {
        case deliver(CaptureCommand)
        case ignoredRepeatedFnState
        case ignoredWebNotReady
    }

    static let compactSize = CGSize(width: 68, height: 68)

    private(set) var isWebReady = false
    private(set) var runStatus: InteractionDictationRunStatus = .idle
    private var fnDown = false
    private var committedRecordingIDs = Set<String>()

    var isBusy: Bool {
        switch runStatus {
        case .requestingMic, .capturing, .saving, .transcribing, .analyzing:
            true
        case .idle, .complete, .error:
            false
        }
    }

    mutating func markWebReady() {
        isWebReady = true
    }

    mutating func applyRunStatus(_ status: InteractionDictationRunStatus) {
        runStatus = status
    }

    mutating func captureDecision(functionPressed: Bool) -> CaptureDecision {
        guard functionPressed != fnDown else { return .ignoredRepeatedFnState }
        fnDown = functionPressed
        guard isWebReady else { return .ignoredWebNotReady }
        return .deliver(functionPressed ? .start : .stop)
    }

    mutating func shouldCommit(recordingID: String, transcript: String) -> Bool {
        !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            committedRecordingIDs.insert(recordingID).inserted
    }

    mutating func resetForTeardown() {
        isWebReady = false
        fnDown = false
        runStatus = .idle
    }
}
