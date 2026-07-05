import AgentDeskWire

enum KeyboardAutoPresentationDecision: Equatable {
    case show
    case leaveUnchanged
}

enum HostTextInputKeyboardPolicy {
    static func decision(for push: HostTextInputFocusPush) -> KeyboardAutoPresentationDecision {
        push.editable ? .show : .leaveUnchanged
    }

    static func decisionAfterRemoteTap(
        lastCursorKind: CursorKind,
        lastHostFocus: HostTextInputFocusPush
    ) -> KeyboardAutoPresentationDecision {
        guard !lastHostFocus.editable, lastCursorKind == .ibeam else {
            return .leaveUnchanged
        }
        return .show
    }
}
