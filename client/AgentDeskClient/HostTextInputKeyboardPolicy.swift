import AgentDeskWire

enum KeyboardAutoPresentationDecision: Equatable {
    case show
    case leaveUnchanged
}

enum KeyboardRemoteTapDecision: Equatable {
    case show
    case hide
}

enum HostTextInputKeyboardPolicy {
    static func decision(for push: HostTextInputFocusPush) -> KeyboardAutoPresentationDecision {
        push.editable ? .show : .leaveUnchanged
    }

    static func decisionAfterRemoteTap(
        lastCursorKind: CursorKind
    ) -> KeyboardRemoteTapDecision {
        lastCursorKind == .ibeam ? .show : .hide
    }
}
