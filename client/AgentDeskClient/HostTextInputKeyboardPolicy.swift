import AgentDeskWire

enum KeyboardPresentationState: Equatable {
    case hidden
    case shown
}

enum KeyboardPresentationIntent: Equatable {
    case show
    case hide
    case toggle
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
        }
        return KeyboardPresentationTransition(previous: state, next: next)
    }
}

enum HostTextInputKeyboardPolicy {
    static func intent(for push: HostTextInputFocusPush) -> KeyboardPresentationIntent? {
        push.editable ? .show : nil
    }

    static func intentAfterRemoteTap(
        lastCursorKind: CursorKind,
        keyboardState: KeyboardPresentationState
    ) -> KeyboardPresentationIntent? {
        switch keyboardState {
        case .shown:
            return .hide
        case .hidden:
            return lastCursorKind == .ibeam ? .show : nil
        }
    }
}
