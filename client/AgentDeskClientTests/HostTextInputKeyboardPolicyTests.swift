import Testing
import AgentDeskWire

@testable import AgentDeskClient

struct HostTextInputKeyboardPolicyTests {
    @Test func keyboardChromeAnchorSitsDirectlyAboveComposedKeyboardFrame() {
        let constant = KeyboardAvoidanceGeometry.bottomConstant(
            viewHeight: 956,
            keyboardMinY: 626,
            safeBottom: 34
        )

        #expect(constant == -308)
    }

    @Test func hiddenKeyboardRestoresBottomPadding() {
        let constant = KeyboardAvoidanceGeometry.bottomConstant(
            viewHeight: 956,
            keyboardMinY: 956,
            safeBottom: 34
        )

        #expect(constant == -12)
    }

    @Test func typingHidesAndCollapsesControlRow() {
        let presentation = KeyboardControlRowPresentation.resolve(
            keyboardIsShown: true,
            controlSurfaceIsActive: true
        )

        #expect(presentation.isHidden)
        #expect(presentation.height == 0)
    }

    @Test func hiddenKeyboardRestoresControlRow() {
        let presentation = KeyboardControlRowPresentation.resolve(
            keyboardIsShown: false,
            controlSurfaceIsActive: true
        )

        #expect(!presentation.isHidden)
        #expect(presentation.height == KeyboardControlRowPresentation.visibleHeight)
    }

    @Test func inactiveControlSurfaceKeepsControlRowCollapsed() {
        let presentation = KeyboardControlRowPresentation.resolve(
            keyboardIsShown: false,
            controlSurfaceIsActive: false
        )

        #expect(presentation.isHidden)
        #expect(presentation.height == 0)
    }

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
            from: .pendingTextFocus,
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
            editability: .editable,
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
            editability: .nonEditable,
            secure: false,
            source: .accessibility,
            role: "AXButton"
        )
        let transition = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intent(for: push)
        )
        #expect(transition.next == .shown)
    }

    @Test func iBeamClickWaitsForHostFocusResult() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .pendingTextFocus)
    }

    @Test func pendingTextFocusShowsWhenAccessibilityConfirmsEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .editable, cursorKind: nil)
        ).next == .shown)
    }

    @Test func pendingTextFocusShowsForAmbiguousIBeamResult() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .ambiguous, cursorKind: .ibeam)
        ).next == .shown)
    }

    @Test func pendingTextFocusHidesWhenAccessibilityReportsNonEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .nonEditable, cursorKind: .ibeam)
        ).next == .hidden)
    }

    @Test func pendingTextFocusHidesWhenAmbiguousResultIsNotIBeam() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .ambiguous, cursorKind: .arrow)
        ).next == .hidden)
    }

    @Test func pendingTextFocusTimeoutReturnsHidden() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .timeoutPendingTextFocus
        ).next == .hidden)
    }

    @Test func arrowTapArmsPendingUntilHostRejects() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .pendingTextFocus)
    }

    @Test func presentedKeyboardTapHidesEvenWhenCursorIsIBeam() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .hidden)
    }

    @Test func hiddenNonIBeamTapArmsPendingUntilHostRejects() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .pendingTextFocus)
    }

    @Test func hostPostClickArrowResultReturnsPendingToHidden() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .nonEditable, cursorKind: .arrow)
        ).next == .hidden)
    }

    @Test func shownKeyboardClickHidesAndLaterFocusDoesNotReopen() {
        let hidden = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        )
        #expect(hidden.next == .hidden)
        #expect(KeyboardPresentationStateMachine.transition(
            from: hidden.next,
            intent: .hostFocus(editability: .editable, cursorKind: .ibeam)
        ).next == .hidden)
    }

    @Test func leftClickInputUsesRemoteTapPolicy() {
        let intent = HostTextInputKeyboardPolicy.intentForRemoteInput(
            .click(button: .left)
        )
        #expect(intent == .remoteTap)
    }

    @Test func autoKeyboardOffSuppressesHiddenRemoteTapIntent() {
        let intent = HostTextInputKeyboardPolicy.intentForRemoteInput(
            .click(button: .left),
            autoKeyboardEnabled: false,
            keyboardIsShown: false
        )
        #expect(intent == nil)
    }

    @Test func autoKeyboardOffStillAllowsShownKeyboardDismissal() {
        let intent = HostTextInputKeyboardPolicy.intentForRemoteInput(
            .click(button: .left),
            autoKeyboardEnabled: false,
            keyboardIsShown: true
        )
        #expect(intent == .remoteTap)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: intent!
        ).next == .hidden)
    }

    @Test func nonLeftClickInputDoesNotAffectKeyboardPolicy() {
        #expect(HostTextInputKeyboardPolicy.intentForRemoteInput(
            .click(button: .right)
        ) == nil)
        #expect(HostTextInputKeyboardPolicy.intentForRemoteInput(
            .cursorMove(dx: 1, dy: 2)
        ) == nil)
        #expect(HostTextInputKeyboardPolicy.intentForRemoteInput(
            .systemCommand(.missionControl)
        ) == nil)
    }
}
