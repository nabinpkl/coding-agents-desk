import Testing
import AgentDeskWire

@testable import AgentDeskClient

struct HostTextInputKeyboardPolicyTests {
    @Test func stateMachineShowHideAndToggleTransitions() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: .show
        ).next == .shown)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .hide
        ).next == .hidden)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: .toggle
        ).next == .shown)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .toggle
        ).next == .hidden)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .awaitingEditableFocusAfterIBeamTap,
            intent: .toggle
        ).next == .shown)
    }

    @Test func stateMachineReportsUnchangedTransition() {
        let transition = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .show
        )
        #expect(transition.next == .shown)
        #expect(!transition.changed)
    }

    @Test func editableFocusPushAloneDoesNotShowKeyboard() {
        let push = HostTextInputFocusPush(
            editable: true,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        let transition = KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intent(for: push)
        )
        #expect(transition.next == .hidden)
    }

    @Test func nonEditableFocusPushLeavesVisibleKeyboardAlone() {
        let push = HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .accessibility,
            role: "AXGroup"
        )
        let transition = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intent(for: push)
        )
        #expect(transition.next == .shown)
    }

    @Test func iBeamTapWaitsForAccessibilityWhenFocusIsNotKnownEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap(
                lastCursorKind: .ibeam,
                focusedEditable: false
            )
        ).next == .awaitingEditableFocusAfterIBeamTap)
    }

    @Test func pendingIBeamTapShowsWhenAccessibilityConfirmsEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .awaitingEditableFocusAfterIBeamTap,
            intent: .hostFocus(editable: true)
        ).next == .shown)
    }

    @Test func pendingIBeamTapHidesWhenAccessibilityReportsNonEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .awaitingEditableFocusAfterIBeamTap,
            intent: .hostFocus(editable: false)
        ).next == .hidden)
    }

    @Test func iBeamTapShowsWhenAccessibilityAlreadyConfirmedEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap(
                lastCursorKind: .ibeam,
                focusedEditable: true
            )
        ).next == .shown)
    }

    @Test func arrowTapLeavesHiddenKeyboardAlone() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap(
                lastCursorKind: .arrow,
                focusedEditable: true
            )
        ).next == .hidden)
    }

    @Test func presentedKeyboardTapHidesEvenWhenCursorIsIBeam() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap(
                lastCursorKind: .ibeam,
                focusedEditable: true
            )
        ).next == .hidden)
    }

    @Test func hiddenNonIBeamTapLeavesKeyboardAlone() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap(
                lastCursorKind: .pointingHand,
                focusedEditable: false
            )
        ).next == .hidden)
    }
}
