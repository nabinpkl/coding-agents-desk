import Foundation

public enum KeyboardCommandTimeoutAction: Equatable, Sendable {
    case waitForAcknowledgement
    case probeLiveness
}

public enum KeyboardDictationInteractionPolicy {
    public static func commandTimeoutAction(
        hasUnacknowledgedCommand: Bool
    ) -> KeyboardCommandTimeoutAction {
        hasUnacknowledgedCommand
            ? .waitForAcknowledgement
            : .probeLiveness
    }

    public static func shouldPresentDraft(
        recordingID: String,
        typingTarget: KeyboardTypingTarget
    ) -> Bool {
        typingTarget != .draft(recordingID: recordingID)
    }
}
