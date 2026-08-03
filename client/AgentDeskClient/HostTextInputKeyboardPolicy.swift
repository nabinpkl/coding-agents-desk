import CoreGraphics
import AgentDeskWire

enum KeyboardPresentationState: Equatable {
    case hidden
    case pendingTextFocus
    case shown
}

enum KeyboardPresentationIntent: Equatable {
    case show
    case hide
    case toggle
    case timeoutPendingTextFocus
    case hostFocus(editability: HostTextInputEditability, cursorKind: CursorKind?)
    case remoteTap
}

struct KeyboardPresentationTransition: Equatable {
    let previous: KeyboardPresentationState
    let next: KeyboardPresentationState

    var changed: Bool {
        previous != next
    }
}

enum KeyboardPresentationTiming {
    static let pendingTextFocusTimeoutNs: UInt64 = 700_000_000
}

enum KeyboardAvoidanceGeometry {
    static let bottomPadding: CGFloat = 12

    static func bottomConstant(
        viewHeight: CGFloat,
        keyboardMinY: CGFloat,
        safeBottom: CGFloat,
        accessoryHeight: CGFloat
    ) -> CGFloat {
        let overlap = max(0, viewHeight - keyboardMinY)
        let keyboardExtra = max(0, overlap - safeBottom)
        guard keyboardExtra > 0 else { return -bottomPadding }
        return -(keyboardExtra + max(0, accessoryHeight) + bottomPadding)
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
        case .timeoutPendingTextFocus:
            if state == .pendingTextFocus {
                next = .hidden
            } else {
                next = state
            }
        case let .hostFocus(editability, cursorKind):
            if state == .pendingTextFocus {
                switch editability {
                case .editable:
                    next = .shown
                case .ambiguous:
                    next = cursorKind == .ibeam ? .shown : .hidden
                case .nonEditable:
                    next = .hidden
                }
            } else {
                next = state
            }
        case .remoteTap:
            switch state {
            case .shown:
                next = .hidden
            case .hidden, .pendingTextFocus:
                next = .pendingTextFocus
            }
        }
        return KeyboardPresentationTransition(previous: state, next: next)
    }
}

enum HostTextInputKeyboardPolicy {
    static func intent(for push: HostTextInputFocusPush) -> KeyboardPresentationIntent {
        .hostFocus(editability: push.editability, cursorKind: push.cursorKind)
    }

    static func intentForRemoteTap() -> KeyboardPresentationIntent {
        .remoteTap
    }

    static func intentForRemoteInput(
        _ input: NormalizedInput,
        autoKeyboardEnabled: Bool = true,
        keyboardIsShown: Bool = false
    ) -> KeyboardPresentationIntent? {
        guard case .click(.left) = input else { return nil }
        guard autoKeyboardEnabled || keyboardIsShown else { return nil }
        return intentForRemoteTap()
    }
}
