import KeyboardDictation
import Testing
import UIKit

@MainActor
private final class KeyboardFeedbackSpy: KeyboardFeedbackProviding {
    private(set) var clicks = 0
    private(set) var impacts = 0
    private(set) var repeatClicks = 0
    private(set) var selections = 0

    func keyActivated(hapticsEnabled: Bool) {
        clicks += 1
        if hapticsEnabled {
            impacts += 1
        }
    }

    func deleteRepeated() {
        repeatClicks += 1
    }

    func cursorMoved(hapticsEnabled: Bool) {
        if hapticsEnabled {
            selections += 1
        }
    }
}

@MainActor
private final class KeyboardRepeatSchedulerSpy: KeyboardRepeatScheduling {
    private var action: (@MainActor () -> Void)?
    private(set) var initialDelay: Duration?
    private(set) var interval: Duration?
    private(set) var stopCount = 0

    func start(
        after initialDelay: Duration,
        every interval: Duration,
        action: @escaping @MainActor () -> Void
    ) {
        self.initialDelay = initialDelay
        self.interval = interval
        self.action = action
    }

    func stop() {
        stopCount += 1
        action = nil
    }

    func fire() {
        action?()
    }
}

struct NativeKeyboardTests {
    @Test @MainActor
    func portraitGeometryUsesTheAuthoritativeMetrics() throws {
        let keyboard = makeKeyboard(
            metrics: .portrait,
            width: 390
        )
        let q = try #require(button("agentdesk-key-71", in: keyboard))
        let w = try #require(button("agentdesk-key-77", in: keyboard))
        let a = try #require(button("agentdesk-key-61", in: keyboard))

        #expect(abs(q.frameIn(keyboard).height - 46) < 0.01)
        #expect(abs(q.frameIn(keyboard).minX - 7) < 0.01)
        #expect(abs(w.frameIn(keyboard).minX - q.frameIn(keyboard).maxX - 6) < 0.01)
        #expect(abs(a.frameIn(keyboard).minX - 18) < 0.01)
        #expect(abs(a.frameIn(keyboard).minY - q.frameIn(keyboard).maxY - 10) < 0.01)
    }

    @Test @MainActor
    func landscapeGeometryKeepsFortyFourPointTargets() throws {
        let keyboard = makeKeyboard(
            metrics: .compactLandscape,
            width: 844
        )
        let q = try #require(button("agentdesk-key-71", in: keyboard))
        let w = try #require(button("agentdesk-key-77", in: keyboard))
        let a = try #require(button("agentdesk-key-61", in: keyboard))

        #expect(abs(q.frameIn(keyboard).height - 44) < 0.01)
        #expect(abs(w.frameIn(keyboard).minX - q.frameIn(keyboard).maxX - 4) < 0.01)
        #expect(abs(a.frameIn(keyboard).minY - q.frameIn(keyboard).maxY - 5) < 0.01)
    }

    @Test func fixedDeckCannotBeCompressedByToolbarState() {
        let portrait = KeyboardDeckMetrics.portrait
        #expect(portrait.deckHeight == 236)
        #expect(portrait.inputHeight(
            toolbarHeight: 72,
            reviewEditorHeight: nil
        ) == 330)
        #expect(portrait.inputHeight(
            toolbarHeight: 100,
            reviewEditorHeight: nil
        ) == 358)
        #expect(portrait.inputHeight(
            toolbarHeight: 72,
            reviewEditorHeight: 76
        ) == 414)

        let landscape = KeyboardDeckMetrics.compactLandscape
        #expect(landscape.deckHeight == 201)
        #expect(landscape.keycapHeight == 44)
    }

    @Test func raisedTokensAreDistinctInLightAndDarkModes() {
        let lightRegular = KeyboardKeyAppearance.tokens(
            for: .regular,
            style: .light
        )
        let darkRegular = KeyboardKeyAppearance.tokens(
            for: .regular,
            style: .dark
        )
        let darkSpecial = KeyboardKeyAppearance.tokens(
            for: .special,
            style: .dark
        )

        #expect(lightRegular.restingWhite == 1)
        #expect(darkRegular.restingWhite == 0.45)
        #expect(darkSpecial.restingWhite == 0.28)
        #expect(darkRegular.pressedWhite != darkRegular.restingWhite)
        #expect(darkRegular.shadowOpacity > lightRegular.shadowOpacity)
    }

    @Test @MainActor
    func highlightDepressesAndThenRestoresTheKey() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        let q = try #require(button("agentdesk-key-71", in: keyboard))
        let restingWhite = try #require(whiteComponent(q.backgroundColor))
        let restingShadow = q.layer.shadowOpacity

        q.isHighlighted = true
        #expect(abs(q.transform.ty - 1) < 0.01)
        #expect(whiteComponent(q.backgroundColor) != restingWhite)
        #expect(q.layer.shadowOpacity < restingShadow)

        q.isHighlighted = false
        #expect(q.transform == .identity)
        #expect(whiteComponent(q.backgroundColor) == restingWhite)
        #expect(q.layer.shadowOpacity == restingShadow)
    }

    @Test @MainActor
    func acceptedTapClicksAndHapticsButCancellationDoesNeither() throws {
        let feedback = KeyboardFeedbackSpy()
        let keyboard = makeKeyboard(
            metrics: .portrait,
            width: 390,
            feedback: feedback
        )
        var acceptedKeys: [KeyboardKey] = []
        keyboard.onKey = { acceptedKeys.append($0) }
        let q = try #require(button("agentdesk-key-71", in: keyboard))

        q.touchDown()
        q.touchUpInside()
        #expect(acceptedKeys == [.character("q")])
        #expect(feedback.clicks == 1)
        #expect(feedback.impacts == 1)

        q.touchDown()
        q.cancelKeyTracking()
        #expect(acceptedKeys == [.character("q")])
        #expect(feedback.clicks == 1)
        #expect(feedback.impacts == 1)
    }

    @Test @MainActor
    func hapticPreferenceDoesNotDisableKeyboardClicks() throws {
        let feedback = KeyboardFeedbackSpy()
        let keyboard = makeKeyboard(
            metrics: .portrait,
            width: 390,
            feedback: feedback
        )
        keyboard.hapticsEnabled = false
        let q = try #require(button("agentdesk-key-71", in: keyboard))

        q.touchDown()
        q.touchUpInside()

        #expect(feedback.clicks == 1)
        #expect(feedback.impacts == 0)
    }

    @Test @MainActor
    func deleteStartsImmediatelyRepeatsAndDoesNotDeleteOnRelease() {
        let feedback = KeyboardFeedbackSpy()
        let scheduler = KeyboardRepeatSchedulerSpy()
        let delete = KeyboardKeyButton(repeatScheduler: scheduler)
        delete.key = .delete
        var deleteCount = 0
        var deleteEndedCount = 0
        delete.onDelete = { isRepeat in
            if isRepeat {
                feedback.deleteRepeated()
            } else {
                feedback.keyActivated(hapticsEnabled: true)
            }
            deleteCount += 1
        }
        delete.onDeleteEnded = { deleteEndedCount += 1 }

        delete.touchDown()
        #expect(deleteCount == 1)
        #expect(feedback.clicks == 1)
        #expect(feedback.impacts == 1)
        #expect(scheduler.initialDelay == .milliseconds(450))
        #expect(scheduler.interval == .milliseconds(80))

        scheduler.fire()
        #expect(deleteCount == 2)
        #expect(feedback.repeatClicks == 1)
        let countBeforeRelease = deleteCount

        delete.touchUpInside()
        #expect(deleteCount == countBeforeRelease)
        #expect(deleteEndedCount == 1)
        #expect(scheduler.stopCount == 1)
        scheduler.fire()
        #expect(deleteCount == countBeforeRelease)
    }

    @Test @MainActor
    func cursorStepsUseSelectionFeedbackOnlyWhenEnabled() {
        let feedback = KeyboardFeedbackSpy()
        let keyboard = makeKeyboard(
            metrics: .portrait,
            width: 390,
            feedback: feedback
        )
        var deltas: [Int] = []
        keyboard.onCursorDelta = { deltas.append($0) }

        keyboard.handleCursorDelta(2)
        #expect(feedback.selections == 2)
        #expect(deltas == [2])

        keyboard.hapticsEnabled = false
        keyboard.handleCursorDelta(-1)
        #expect(feedback.selections == 2)
        #expect(deltas == [2, -1])
    }

    @Test @MainActor
    func globeIsRenderedOnlyWhenTheSystemRequiresIt() {
        let keyboard = AgentDeskQWERTYView()
        keyboard.frame = CGRect(x: 0, y: 0, width: 390, height: 236)
        keyboard.apply(.portrait)

        keyboard.render(KeyboardLayoutState(
            showsInputModeSwitchKey: true
        ))
        keyboard.layoutIfNeeded()
        #expect(button("agentdesk-key-globe", in: keyboard) != nil)

        keyboard.render(KeyboardLayoutState(
            showsInputModeSwitchKey: false
        ))
        keyboard.layoutIfNeeded()
        #expect(button("agentdesk-key-globe", in: keyboard) == nil)
    }

    @MainActor
    private func makeKeyboard(
        metrics: KeyboardDeckMetrics,
        width: CGFloat,
        feedback: KeyboardFeedbackProviding = KeyboardFeedbackSpy()
    ) -> AgentDeskQWERTYView {
        let keyboard = AgentDeskQWERTYView(feedback: feedback)
        keyboard.frame = CGRect(
            x: 0,
            y: 0,
            width: width,
            height: metrics.deckHeight
        )
        keyboard.apply(metrics)
        keyboard.render(KeyboardLayoutState(
            showsInputModeSwitchKey: false
        ))
        keyboard.layoutIfNeeded()
        return keyboard
    }

    @MainActor
    private func button(
        _ identifier: String,
        in view: UIView
    ) -> KeyboardKeyButton? {
        if let button = view as? KeyboardKeyButton,
           button.accessibilityIdentifier == identifier {
            return button
        }
        for subview in view.subviews {
            if let match = button(identifier, in: subview) {
                return match
            }
        }
        return nil
    }

    @MainActor
    private func whiteComponent(_ color: UIColor?) -> CGFloat? {
        guard let color else { return nil }
        var white: CGFloat = 0
        guard color
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
            .getWhite(&white, alpha: nil)
        else {
            return nil
        }
        return white
    }

}

@MainActor
private extension UIView {
    func frameIn(_ ancestor: UIView) -> CGRect {
        convert(bounds, to: ancestor)
    }
}
