import Foundation
import KeyboardDictation

enum KeyboardDictationContainingAppState: Equatable {
    case inactive
    case arming
    case ready
    case recording
    case finalizing
    case failed

    init(snapshot: KeyboardDictationServiceSnapshot) {
        switch snapshot.phase {
        case .inactive:
            self = .inactive
        case .arming:
            self = .arming
        case .ready, .completed:
            self = .ready
        case .recording:
            self = .recording
        case .saving, .transcribing, .analyzing:
            self = .finalizing
        case .failed:
            self = .failed
        }
    }

    var settingsActionTitle: String {
        self == .inactive
            ? "Activate Keyboard Dictation"
            : "Manage Keyboard Dictation"
    }

    var railSymbolName: String {
        switch self {
        case .inactive: "mic.badge.plus"
        case .arming: "hourglass.circle"
        case .ready: "mic.circle.fill"
        case .recording: "waveform.circle.fill"
        case .finalizing: "ellipsis.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case .inactive: "Activate Keyboard Dictation"
        case .arming: "Keyboard Dictation starting"
        case .ready: "Keyboard Dictation active"
        case .recording: "Keyboard Dictation recording"
        case .finalizing: "Keyboard Dictation finishing"
        case .failed: "Keyboard Dictation needs attention"
        }
    }

    var isHighlighted: Bool {
        self != .inactive
    }
}

enum KeyboardDictationLifecyclePolicy {
    static func acceptsLaneCallback(
        callbackGeneration: UUID,
        activeGeneration: UUID?
    ) -> Bool {
        callbackGeneration == activeGeneration
    }

    static func acceptsSocketCompletion(
        requestID: String,
        activeRequestID: String?
    ) -> Bool {
        requestID == activeRequestID
    }

    static func acceptsCaptureCallback(
        captureSessionID: UUID,
        activeSessionID: UUID?
    ) -> Bool {
        captureSessionID == activeSessionID
    }

    static func canUseInAgentDesk(
        snapshot: KeyboardDictationServiceSnapshot
    ) -> Bool {
        snapshot.phase == .ready
            || (snapshot.phase == .failed && snapshot.isArmed)
    }
}
