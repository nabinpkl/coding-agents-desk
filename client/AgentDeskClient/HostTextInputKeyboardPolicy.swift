import AgentDeskWire

enum KeyboardPresentationState: Equatable {
    case hidden
    case awaitingEditableFocusAfterVideoTap
    case shown
}

enum KeyboardPresentationIntent: Equatable {
    case show
    case hide
    case toggle
    case hostFocus(editable: Bool, cursorKind: CursorKind?)
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
        case let .hostFocus(editable, cursorKind):
            if state == .awaitingEditableFocusAfterVideoTap {
                next = editable || cursorKind == .ibeam ? .shown : .hidden
            } else {
                next = state
            }
        case let .remoteTap(cursorKind, focusedEditable):
            switch state {
            case .shown:
                next = .hidden
            case .hidden, .awaitingEditableFocusAfterVideoTap:
                if cursorKind == .ibeam {
                    next = focusedEditable ? .shown : .awaitingEditableFocusAfterVideoTap
                } else {
                    next = .hidden
                }
            }
        }
        return KeyboardPresentationTransition(previous: state, next: next)
    }
}

enum HostTextInputKeyboardPolicy {
    static func intent(for push: HostTextInputFocusPush) -> KeyboardPresentationIntent {
        .hostFocus(editable: push.editable, cursorKind: push.cursorKind)
    }

    static func intentForRemoteTap(
        lastCursorKind: CursorKind,
        focusedEditable: Bool
    ) -> KeyboardPresentationIntent {
        .remoteTap(cursorKind: lastCursorKind, focusedEditable: focusedEditable)
    }

    static func intentForRemoteInput(
        _ input: NormalizedInput,
        lastCursorKind: CursorKind,
        focusedEditable: Bool
    ) -> KeyboardPresentationIntent? {
        guard case .click(.left) = input else { return nil }
        return intentForRemoteTap(
            lastCursorKind: lastCursorKind,
            focusedEditable: focusedEditable
        )
    }
}
