import AgentDeskWire

enum KeyboardAutoPresentationDecision: Equatable {
    case show
    case leaveUnchanged
}

enum KeyboardRemoteTapDecision: Equatable {
    case show
    case keepVisible
    case hide
}

enum HostTextInputKeyboardPolicy {
    static func decision(for push: HostTextInputFocusPush) -> KeyboardAutoPresentationDecision {
        push.editable ? .show : .leaveUnchanged
    }

    static func decisionAfterRemoteTap(
        lastCursorKind: CursorKind,
        lastHostFocus: HostTextInputFocusPush
    ) -> KeyboardRemoteTapDecision {
        guard lastCursorKind == .ibeam else {
            return .hide
        }
        return lastHostFocus.editable ? .keepVisible : .show
    }
}
