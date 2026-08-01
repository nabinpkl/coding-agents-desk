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
        let l = try #require(button("agentdesk-key-6c", in: keyboard))
        let shift = try #require(button(
            "agentdesk-key-shift",
            in: keyboard
        ))
        let z = try #require(button("agentdesk-key-7a", in: keyboard))
        let m = try #require(button("agentdesk-key-6d", in: keyboard))
        let delete = try #require(button(
            "agentdesk-key-delete",
            in: keyboard
        ))

        #expect(abs(q.frameIn(keyboard).height - 46) < 0.01)
        #expect(abs(q.frameIn(keyboard).minX - 7) < 0.01)
        #expect(abs(w.frameIn(keyboard).minX - q.frameIn(keyboard).maxX - 6) < 0.01)
        #expect(abs(a.frameIn(keyboard).width - q.frameIn(keyboard).width) < 0.01)
        #expect(abs(l.frameIn(keyboard).width - q.frameIn(keyboard).width) < 0.01)
        #expect(abs(
            a.frameIn(keyboard).minX
                - (keyboard.bounds.width - l.frameIn(keyboard).maxX)
        ) < 0.01)
        #expect(abs(a.frameIn(keyboard).minY - q.frameIn(keyboard).maxY - 10) < 0.01)
        #expect(abs(
            z.frameIn(keyboard).minX - shift.frameIn(keyboard).maxX - 10
        ) < 0.01)
        #expect(abs(
            delete.frameIn(keyboard).minX - m.frameIn(keyboard).maxX - 10
        ) < 0.01)
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
        let l = try #require(button("agentdesk-key-6c", in: keyboard))
        let shift = try #require(button(
            "agentdesk-key-shift",
            in: keyboard
        ))
        let z = try #require(button("agentdesk-key-7a", in: keyboard))
        let m = try #require(button("agentdesk-key-6d", in: keyboard))
        let delete = try #require(button(
            "agentdesk-key-delete",
            in: keyboard
        ))

        #expect(abs(q.frameIn(keyboard).height - 44) < 0.01)
        #expect(abs(w.frameIn(keyboard).minX - q.frameIn(keyboard).maxX - 4) < 0.01)
        #expect(abs(a.frameIn(keyboard).minY - q.frameIn(keyboard).maxY - 5) < 0.01)
        #expect(abs(a.frameIn(keyboard).width - q.frameIn(keyboard).width) < 0.01)
        #expect(abs(l.frameIn(keyboard).width - q.frameIn(keyboard).width) < 0.01)
        #expect(abs(
            a.frameIn(keyboard).minX
                - (keyboard.bounds.width - l.frameIn(keyboard).maxX)
        ) < 0.01)
        #expect(abs(
            z.frameIn(keyboard).minX - shift.frameIn(keyboard).maxX - 8
        ) < 0.01)
        #expect(abs(
            delete.frameIn(keyboard).minX - m.frameIn(keyboard).maxX - 8
        ) < 0.01)
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
        #expect(whiteComponent(
            KeyboardKeyAppearance.characterPreviewFill,
            style: .light
        ) == 1)
        #expect(whiteComponent(
            KeyboardKeyAppearance.characterPreviewFill,
            style: .dark
        ) == 0.55)
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
    func characterPreviewTracksTouchDownAndClearsBeforeInsertion() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        let q = try #require(button("agentdesk-key-71", in: keyboard))
        let preview = try #require(characterPreview(in: keyboard))
        var previewWasHiddenDuringInsertion = false
        keyboard.onKey = { _ in
            previewWasHiddenDuringInsertion = preview.isHidden
        }

        q.touchDown()
        #expect(preview.isHidden == false)
        #expect(preview.character == "q")
        #expect(preview.isUserInteractionEnabled == false)
        #expect(preview.isAccessibilityElement == false)

        q.touchUpInside()
        #expect(preview.isHidden)
        #expect(preview.character == nil)
        #expect(previewWasHiddenDuringInsertion)
    }

    @Test @MainActor
    func characterPreviewUsesRenderedShiftTitleAndCancelsCleanly() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        var state = KeyboardLayoutState(
            showsInputModeSwitchKey: false
        )
        state.handleShiftTap(isDoubleTap: false)
        keyboard.render(state)
        keyboard.layoutIfNeeded()
        let q = try #require(button("agentdesk-key-71", in: keyboard))
        let preview = try #require(characterPreview(in: keyboard))

        q.touchDown()
        #expect(preview.character == "Q")
        q.cancelKeyTracking()

        #expect(preview.isHidden)
        #expect(preview.character == nil)
    }

    @Test @MainActor
    func newerCharacterTouchOwnsTheSinglePreviewUntilItEnds() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        let q = try #require(button("agentdesk-key-71", in: keyboard))
        let w = try #require(button("agentdesk-key-77", in: keyboard))
        let preview = try #require(characterPreview(in: keyboard))

        q.touchDown()
        w.touchDown()
        #expect(preview.character == "w")

        q.touchUpInside()
        #expect(preview.isHidden == false)
        #expect(preview.character == "w")

        w.touchUpInside()
        #expect(preview.isHidden)
    }

    @Test @MainActor
    func specialKeysNeverCreateACharacterPreview() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        let shift = try #require(button(
            "agentdesk-key-shift",
            in: keyboard
        ))
        let preview = try #require(characterPreview(in: keyboard))

        shift.touchDown()

        #expect(preview.isHidden)
        #expect(preview.character == nil)
    }

    @Test @MainActor
    func genericReturnUsesGlyphButKeepsItsAccessibleName() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        let returnKey = try #require(button(
            "agentdesk-key-return",
            in: keyboard
        ))

        #expect(returnKey.currentTitle == "↵")
        #expect(returnKey.titleLabel?.font.pointSize == 24)
        #expect(returnKey.accessibilityLabel == "Return")

        keyboard.returnKeyPresentation = KeyboardReturnKeyPresentation(
            returnKeyType: .send
        )
        keyboard.render(KeyboardLayoutState(
            showsInputModeSwitchKey: false
        ))
        keyboard.layoutIfNeeded()
        let sendKey = try #require(button(
            "agentdesk-key-return",
            in: keyboard
        ))
        #expect(sendKey.currentTitle == nil)
        #expect(sendKey.currentImage != nil)
        #expect(sendKey.accessibilityLabel == "Send")
    }

    @Test
    func returnKeyPresentationsMatchIOS26PrimaryKeyGlyphs() {
        let cases: [(UIReturnKeyType, String, String)] = [
            (.go, "arrow.forward", "Go"),
            (.google, "magnifyingglass", "Google"),
            (.join, "arrow.forward", "Join"),
            (.next, "chevron.forward", "Next"),
            (.route, "arrow.forward", "Route"),
            (.search, "magnifyingglass", "Search"),
            (.send, "arrow.up", "Send"),
            (.yahoo, "magnifyingglass", "Yahoo"),
            (.done, "checkmark", "Done"),
            (.emergencyCall, "phone", "Emergency Call"),
            (.continue, "chevron.forward", "Continue"),
        ]

        for (returnKeyType, symbolName, accessibilityLabel) in cases {
            let presentation = KeyboardReturnKeyPresentation(
                returnKeyType: returnKeyType
            )
            #expect(presentation.visual == .systemImage(symbolName))
            #expect(
                presentation.accessibilityLabel == accessibilityLabel
            )
        }

        #expect(
            KeyboardReturnKeyPresentation(returnKeyType: .default)
                == .default
        )
        #expect(
            KeyboardReturnKeyPresentation(returnKeyType: nil)
                == .default
        )
    }

    @Test @MainActor
    func spaceKeyIsVisuallyBlankButRemainsAccessible() throws {
        let keyboard = makeKeyboard(metrics: .portrait, width: 390)
        let space = try #require(button(
            "agentdesk-key-space",
            in: keyboard
        ))

        #expect(space.currentTitle == "")
        #expect(space.accessibilityLabel == "Space")
    }

    @Test
    func characterPreviewGeometryClampsEdgesAndKeepsItsTailOnTheKey() {
        let leftKey = CGRect(x: 7, y: 14, width: 32, height: 46)
        let left = KeyboardCharacterPreviewGeometry.layout(
            above: leftKey,
            containerWidth: 390
        )
        #expect(left.frame.minX == 3)
        #expect(abs(left.frame.minX + left.tipX - leftKey.midX) < 0.01)
        #expect(left.frame.maxY == leftKey.minY + 3)

        let rightKey = CGRect(x: 351, y: 14, width: 32, height: 46)
        let right = KeyboardCharacterPreviewGeometry.layout(
            above: rightKey,
            containerWidth: 390
        )
        #expect(right.frame.maxX == 387)
        #expect(abs(
            right.frame.minX + right.tipX - rightKey.midX
        ) < 0.01)
        #expect(right.frame.minY < 0)
    }

    @Test
    func topRowPreviewStaysInsideThePrimaryKeyboardView() {
        for metrics in [
            KeyboardDeckMetrics.portrait,
            KeyboardDeckMetrics.compactLandscape,
        ] {
            let keyFrame = CGRect(
                x: metrics.horizontalDeckInset,
                y: metrics.topDeckPadding,
                width: 32,
                height: metrics.keycapHeight
            )
            let preview = KeyboardCharacterPreviewGeometry.layout(
                above: keyFrame,
                containerWidth: 390
            )
            let deckOriginY = metrics.inputTopInset
                + metrics.toolbarMinimumHeight
                + metrics.sectionSpacing

            #expect(deckOriginY + preview.frame.minY >= 0)
        }
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
    private func characterPreview(
        in view: UIView
    ) -> KeyboardCharacterPreviewView? {
        if let preview = view as? KeyboardCharacterPreviewView {
            return preview
        }
        for subview in view.subviews {
            if let match = characterPreview(in: subview) {
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

    private func whiteComponent(
        _ color: UIColor,
        style: UIUserInterfaceStyle
    ) -> CGFloat? {
        var white: CGFloat = 0
        guard color
            .resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
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
