import AgentDeskWire

enum KeyboardPresentationState: Equatable {
    case hidden
    case awaitingEditableFocusAfterIBeamTap
    case shown
}

enum KeyboardPresentationIntent: Equatable {
    case show
    case hide
    case toggle
    case hostFocus(editable: Bool)
    case remoteTap(cursorKind: CursorKind, focusedEditable: Bool)
}

struct KeyboardPresentationTransition: Equatable {
    let previous: KeyboardPresentationState
    let next: KeyboardPresentationState

    var changed: Bool {
        previous != next
    }
}

enum KeyboardPresentationStateMachine {
    static func transition(
        from state: KeyboardPresentationState,
        intent: KeyboardPresentationIntent
    ) -> KeyboardPresentationTransition {
        let next: KeyboardPresentationState
        switch intent {
        case .show:
            next = .shown
        case .hide:
            next = .hidden
        case .toggle:
            next = state == .shown ? .hidden : .shown
        case let .hostFocus(editable):
            if state == .awaitingEditableFocusAfterIBeamTap {
                next = editable ? .shown : .hidden
            } else {
                next = state
            }
        case let .remoteTap(cursorKind, focusedEditable):
            switch state {
            case .shown:
                next = .hidden
            case .hidden, .awaitingEditableFocusAfterIBeamTap:
                guard cursorKind == .ibeam else {
                    next = .hidden
                    break
                }
                next = focusedEditable ? .shown : .awaitingEditableFocusAfterIBeamTap
            }
        }
        return KeyboardPresentationTransition(previous: state, next: next)
    }
}

enum HostTextInputKeyboardPolicy {
    static func intent(for push: HostTextInputFocusPush) -> KeyboardPresentationIntent {
        .hostFocus(editable: push.editable)
    }

    static func intentForRemoteTap(
        lastCursorKind: CursorKind,
        focusedEditable: Bool
    ) -> KeyboardPresentationIntent {
        .remoteTap(cursorKind: lastCursorKind, focusedEditable: focusedEditable)
    }
}
