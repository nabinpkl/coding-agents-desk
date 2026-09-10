import Testing
import UIKit

@MainActor
struct SurfaceControlRailTests {
    @Test func sessionLayoutBuildsWhenSinkFollowsPreVideoShell() {
        var layout = SessionLayoutConstraints()

        #expect(layout.reconcile(shellMounted: true, sinkMounted: false) == .upToDate)
        #expect(!layout.hasInstalledConstraints)
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))
        #expect(layout.hasInstalledConstraints)
        // Nothing moved, so there is nothing to redo: a rebuild here would churn every
        // constraint on screen on any incidental re-entry.
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .upToDate)
    }

    /// The reconnect window. The surface-preserving teardown drops the shell and keeps the
    /// sink so the last frame stays on screen, which only works if the sink keeps its
    /// position and extent too. Treating this as "nothing to lay out" left the scroll view
    /// unconstrained for the whole outage: it collapsed, and the user saw black with the
    /// status label riding it up under the notch.
    @Test func sinkWithoutShellKeepsALayoutForTheOutage() {
        var layout = SessionLayoutConstraints()
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))

        #expect(layout.reconcile(shellMounted: false, sinkMounted: true) == .rebuild(.videoOnly))
        #expect(layout.hasInstalledConstraints)
        #expect(layout.reconcile(shellMounted: false, sinkMounted: true) == .upToDate)

        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))
    }

    /// R230. A handover tears the control shell down and rebuilds it while deliberately
    /// keeping the video sink, so the constraint set has to be re-derived from a composition
    /// whose sink never re-mounted. The one-shot gate this replaced reported "already
    /// installed" here, the sink kept no position or extent constraints, and the video view
    /// laid out at zero height -- frames decoding into a rect the user sees as black.
    /// R230. A handover tears the control shell down and rebuilds it while deliberately
    /// keeping the video sink, so the constraint set has to be re-derived from a composition
    /// whose sink never re-mounted. The one-shot gate this replaced reported "already
    /// installed" here, the sink kept no position or extent constraints, and the video view
    /// laid out at zero height -- frames decoding into a rect the user sees as black.
    @Test func sessionLayoutRebuildsWhenShellRemountsOverASurvivingSink() {
        var layout = SessionLayoutConstraints()
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))

        #expect(layout.reconcile(shellMounted: false, sinkMounted: true) == .rebuild(.videoOnly))
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))
        #expect(layout.hasInstalledConstraints)
    }

    @Test func sessionLayoutClearsOnceAndStaysQuietWhileNothingIsMounted() {
        var layout = SessionLayoutConstraints()
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))

        #expect(layout.reconcile(shellMounted: false, sinkMounted: false) == .clear)
        // The set is already gone; repeating the teardown must not ask for a second discard.
        #expect(layout.reconcile(shellMounted: false, sinkMounted: false) == .upToDate)
        #expect(layout.reconcile(shellMounted: true, sinkMounted: false) == .upToDate)
        #expect(!layout.hasInstalledConstraints)
    }

    @Test func sessionLayoutClearsWhenTheSinkGoesAndTheShellStays() {
        var layout = SessionLayoutConstraints()
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))

        // A non-preserving teardown drops the sink and leaves the shell up. With no video
        // there is nothing the orientation-variant set can position.
        #expect(layout.reconcile(shellMounted: true, sinkMounted: false) == .clear)
        #expect(layout.reconcile(shellMounted: true, sinkMounted: true) == .rebuild(.session))
    }

    @Test func preVideoRailHasVisibleBackdropAndUsableUtilities() throws {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let orientation = utilityButton(label: "Rotate", identifier: "orientation-toggle")
        let voice = utilityButton(label: "Voice", identifier: "voice-toggle")
        let keyboard = utilityButton(label: "Keyboard Dictation", identifier: "keyboard-dictation-service")
        let settings = utilityButton(label: "Settings", identifier: "settings-button")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: orientation,
            voiceButton: voice,
            keyboardDictationButton: keyboard,
            settingsButton: settings
        )

        let backgroundColor = try #require(rail.backgroundColor)
        var white: CGFloat = 0
        var alpha: CGFloat = 0
        #expect(backgroundColor.getWhite(&white, alpha: &alpha))
        #expect(alpha > 0)
        #expect(rail.surfaceButtons.isEmpty)
        #expect(rail.utilityButtons.allSatisfy {
            !$0.isHidden && $0.alpha == 1 && $0.isUserInteractionEnabled
        })
    }

    @Test func presentsSurfaceAndUtilityButtonsInOneVerticalRail() throws {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let orientation = utilityButton(label: "Rotate", identifier: "orientation-toggle")
        let voice = utilityButton(label: "Voice", identifier: "voice-toggle")
        let keyboard = utilityButton(label: "Keyboard Dictation", identifier: "keyboard-dictation-service")
        let settings = utilityButton(label: "Settings", identifier: "settings-button")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: orientation,
            voiceButton: voice,
            keyboardDictationButton: keyboard,
            settingsButton: settings
        )

        rail.setSurfaces(
            [.control, .agent, .terminal, .browser, .workspace],
            selected: .control,
            onSelection: { _ in }
        )

        #expect(rail.accessibilityIdentifier == "surface-control-rail")
        #expect(rail.axis == .vertical)
        #expect(rail.backgroundColor != .clear)
        #expect(!rail.isOpaque)
        #expect(rail.collapseButton.accessibilityIdentifier == "surface-control-collapse")
        #expect(rail.collapseButton.accessibilityLabel == "Collapse controls")
        #expect(rail.intrinsicContentSize.width == 60)
        #expect(rail.surfaceButtons.count == 6)
        #expect(rail.surfaceButtons.map(\.accessibilityLabel) == [
            "Control", "Agent", "Terminal", "Browser", "Workspace", "IDE"
        ])
        #expect(rail.utilityButtons == [
            gesture, orientation, voice, keyboard, settings,
        ])
        for button in rail.surfaceButtons + rail.utilityButtons {
            #expect(button.constraints.contains { $0.firstAttribute == .height && $0.constant == 44 })
            #expect(button.constraints.contains { $0.firstAttribute == .width && $0.constant == 44 })
        }
    }

    @Test func selectionUpdatesVisualStateAndEmitsTheSelectedSurface() throws {
        let rail = SurfaceControlRail(
            gestureButton: utilityButton(label: "Gesture", identifier: "gesture-toggle"),
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
            voiceButton: utilityButton(label: "Voice", identifier: "voice-toggle"),
            keyboardDictationButton: utilityButton(
                label: "Keyboard Dictation",
                identifier: "keyboard-dictation-service"
            ),
            settingsButton: utilityButton(label: "Settings", identifier: "settings-button")
        )
        var selections: [ControlSurface] = []
        rail.setSurfaces(
            [.control, .agent, .terminal],
            selected: .control,
            onSelection: { selections.append($0) }
        )

        let terminalButton = try #require(
            rail.surfaceButtons.first { $0.accessibilityLabel == "Terminal" }
        )
        // This is a hostless unit-test bundle, so UIApplication cannot
        // dispatch UIButton target actions on iOS 26.5. Invoke the rail action
        // directly and keep the assertion focused on rail state.
        rail.surfaceButtonPressed(terminalButton)

        #expect(selections == [.terminal])
        #expect(terminalButton.isSelected)
        #expect(terminalButton.accessibilityTraits.contains(.selected))
        #expect(rail.surfaceButtons.first { $0.accessibilityLabel == "Control" }?.isSelected == false)
    }

    @Test func refreshingAvailabilityReusesUtilityButtonsWithoutDuplicates() {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let orientation = utilityButton(label: "Rotate", identifier: "orientation-toggle")
        let voice = utilityButton(label: "Voice", identifier: "voice-toggle")
        let keyboard = utilityButton(label: "Keyboard Dictation", identifier: "keyboard-dictation-service")
        let settings = utilityButton(label: "Settings", identifier: "settings-button")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: orientation,
            voiceButton: voice,
            keyboardDictationButton: keyboard,
            settingsButton: settings
        )

        rail.setSurfaces(
            [.control, .agent, .terminal, .browser, .workspace],
            selected: .browser,
            onSelection: { _ in }
        )
        rail.setSurfaces(
            [.control, .agent, .terminal, .workspace],
            selected: .control,
            onSelection: { _ in }
        )

        #expect(rail.surfaceButtons.count == 5)
        #expect(rail.surfaceButtons.allSatisfy { $0.accessibilityLabel != "Browser" })
        #expect(rail.utilityButtons == [
            gesture, orientation, voice, keyboard, settings,
        ])
        #expect(Set(rail.utilityButtons.map(ObjectIdentifier.init)).count == 5)
    }

    @Test func utilitySelectionUsesTheSameVisualLanguageAsSurfaceSelection() {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
            voiceButton: utilityButton(label: "Voice", identifier: "voice-toggle"),
            keyboardDictationButton: utilityButton(
                label: "Keyboard Dictation",
                identifier: "keyboard-dictation-service"
            ),
            settingsButton: utilityButton(label: "Settings", identifier: "settings-button")
        )

        rail.setUtilityButton(gesture, selected: true)

        #expect(gesture.isSelected)
        #expect(gesture.accessibilityTraits.contains(.selected))
        #expect(gesture.configuration?.baseForegroundColor == .systemBlue)
        #expect(gesture.configuration?.background.backgroundColor == .clear)
    }

    @Test func collapseHidesControlsButPreservesSelectionAndAReopenButton() throws {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
            voiceButton: utilityButton(label: "Voice", identifier: "voice-toggle"),
            keyboardDictationButton: utilityButton(
                label: "Keyboard Dictation",
                identifier: "keyboard-dictation-service"
            ),
            settingsButton: utilityButton(label: "Settings", identifier: "settings-button")
        )
        rail.setSurfaces(
            [.control, .agent, .terminal],
            selected: .agent,
            onSelection: { _ in }
        )
        let agent = try #require(
            rail.surfaceButtons.first { $0.accessibilityLabel == "Agent" }
        )
        let expandedHeight = rail.intrinsicContentSize.height

        rail.collapseButtonPressed()

        #expect(rail.isCollapsed)
        #expect(rail.collapseButton.isHidden == false)
        #expect(rail.collapseButton.accessibilityLabel == "Expand controls")
        #expect(rail.collapseButton.accessibilityValue == "Collapsed")
        #expect(rail.intrinsicContentSize.width == 44)
        // The rail overlays the active surface, so a closed panel has to give the
        // area back rather than keep covering it with a transparent column: what
        // is left is the 44pt toggle plus the rail's own 8pt insets. Compared with
        // a tolerance because the height comes back from a real layout pass.
        #expect(rail.intrinsicContentSize.height < expandedHeight)
        #expect(abs(rail.intrinsicContentSize.height - 60) < 1)
        #expect(rail.surfaceButtons.allSatisfy { $0.isHidden })
        #expect(rail.utilityButtons.allSatisfy { $0.isHidden })
        #expect(agent.isSelected)

        rail.collapseButtonPressed()

        #expect(!rail.isCollapsed)
        #expect(rail.collapseButton.accessibilityLabel == "Collapse controls")
        #expect(rail.intrinsicContentSize.width == 60)
        #expect(rail.intrinsicContentSize.height == expandedHeight)
        #expect(rail.surfaceButtons.allSatisfy { !$0.isHidden && $0.alpha == 1 })
        #expect(rail.utilityButtons.allSatisfy { !$0.isHidden && $0.alpha == 1 })
        #expect(rail.surfaceButtons.allSatisfy { $0.isUserInteractionEnabled })
        #expect(rail.utilityButtons.allSatisfy { !$0.accessibilityElementsHidden })
        #expect(agent.isSelected)
    }

    /// The rail hangs from the top of the right edge, where the scroll strip also
    /// lives, so the toggle goes last: the collapsed rail's single button then
    /// sits as far down the edge as the rail's own height allows, and the two
    /// button groups stay adjacent instead of being split by it.
    @Test func theToggleSitsBelowBothButtonGroups() {
        let rail = SurfaceControlRail(
            gestureButton: utilityButton(label: "Gesture", identifier: "gesture-toggle"),
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
            voiceButton: utilityButton(label: "Voice", identifier: "voice-toggle"),
            keyboardDictationButton: utilityButton(
                label: "Keyboard Dictation",
                identifier: "keyboard-dictation-service"
            ),
            settingsButton: utilityButton(label: "Settings", identifier: "settings-button")
        )
        rail.setSurfaces(
            [.control, .agent, .terminal],
            selected: .control,
            onSelection: { _ in }
        )
        rail.frame = CGRect(
            x: 0,
            y: 0,
            width: rail.intrinsicContentSize.width,
            height: rail.intrinsicContentSize.height
        )
        rail.layoutIfNeeded()

        let toggleTop = rail.collapseButton.convert(rail.collapseButton.bounds, to: rail).minY
        #expect(rail.surfaceButtons.allSatisfy {
            $0.convert($0.bounds, to: rail).minY < toggleTop
        })
        #expect(rail.utilityButtons.allSatisfy {
            $0.convert($0.bounds, to: rail).minY < toggleTop
        })
        // The surfaces still lead, so the groups did not merely swap places.
        let firstUtilityTop = rail.utilityButtons
            .map { $0.convert($0.bounds, to: rail).minY }
            .min() ?? 0
        #expect(rail.surfaceButtons.allSatisfy {
            $0.convert($0.bounds, to: rail).minY < firstUtilityTop
        })
    }

    /// The chevron is the one control a closed rail leaves on screen, so it must
    /// not move when it is used. The rail hangs from its top and shrinks when it
    /// closes, which on its own would drag the chevron upward out from under the
    /// thumb, so it reports the height it gave up for its owner to add back below
    /// the anchor.
    @Test func collapsingLeavesTheChevronWhereTheFingerFoundIt() {
        let rail = SurfaceControlRail(
            gestureButton: utilityButton(label: "Gesture", identifier: "gesture-toggle"),
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
            voiceButton: utilityButton(label: "Voice", identifier: "voice-toggle"),
            keyboardDictationButton: utilityButton(
                label: "Keyboard Dictation",
                identifier: "keyboard-dictation-service"
            ),
            settingsButton: utilityButton(label: "Settings", identifier: "settings-button")
        )
        rail.setSurfaces(
            [.control, .agent, .terminal],
            selected: .control,
            onSelection: { _ in }
        )
        var reported: [CGFloat] = []
        rail.onTopOffsetChange = { reported.append($0) }
        let layOut = {
            rail.frame = CGRect(
                x: 0,
                y: 0,
                width: rail.intrinsicContentSize.width,
                height: rail.intrinsicContentSize.height
            )
            rail.layoutIfNeeded()
        }
        layOut()
        let expandedHeight = rail.bounds.height
        let chevronBefore = rail.collapseButton.convert(rail.collapseButton.bounds, to: rail).minY

        rail.collapseButtonPressed()
        layOut()

        // The chevron's place on screen is where the rail starts plus where it
        // sits inside the rail. The first term grew by exactly what the second
        // one lost, so the sum is unchanged.
        let chevronAfter = rail.collapseButton.convert(rail.collapseButton.bounds, to: rail).minY
        #expect(abs((rail.collapsedTopOffset + chevronAfter) - chevronBefore) < 1)
        #expect(abs(rail.collapsedTopOffset - (expandedHeight - 60)) < 1)
        #expect(reported == [rail.collapsedTopOffset])
        #expect(rail.collapsedTopOffset > 0)

        rail.collapseButtonPressed()
        layOut()

        // Reopening puts the rail back against its anchor, and the chevron back
        // at the far end of a full-height rail.
        #expect(rail.collapsedTopOffset == 0)
        #expect(reported.last == 0)
        let chevronReopened = rail.collapseButton.convert(rail.collapseButton.bounds, to: rail).minY
        #expect(abs(chevronReopened - chevronBefore) < 1)
    }

    /// Before the handshake the rail still lists every surface, so the app's shape
    /// is legible while unpaired, but the ones that read a lane off the session
    /// cannot be opened yet and must say so rather than opening onto nothing.
    @Test func surfacesWithoutASessionAreListedDimmedAndRefuseSelection() throws {
        let rail = SurfaceControlRail(
            gestureButton: utilityButton(label: "Gesture", identifier: "gesture-toggle"),
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
            voiceButton: utilityButton(label: "Voice", identifier: "voice-toggle"),
            keyboardDictationButton: utilityButton(
                label: "Keyboard Dictation",
                identifier: "keyboard-dictation-service"
            ),
            settingsButton: utilityButton(label: "Settings", identifier: "settings-button")
        )
        var selections: [ControlSurface] = []
        rail.setSurfaces(
            [.control, .agent, .terminal, .workspace],
            selected: .control,
            onSelection: { selections.append($0) }
        )
        rail.setEnabledSurfaces([.control])

        #expect(rail.surfaceButtons.count == 5)
        let control = try #require(rail.surfaceButtons.first { $0.accessibilityLabel == "Control" })
        let terminal = try #require(rail.surfaceButtons.first { $0.accessibilityLabel == "Terminal" })
        #expect(control.isEnabled)
        #expect(control.alpha == 1)
        #expect(!terminal.isEnabled)
        #expect(terminal.alpha < 1)
        #expect(rail.surfaceButtons.allSatisfy { !$0.isHidden })

        rail.surfaceButtonPressed(terminal)
        #expect(selections.isEmpty)

        rail.setEnabledSurfaces(nil)
        #expect(rail.surfaceButtons.allSatisfy { $0.isEnabled && $0.alpha == 1 })

        rail.surfaceButtonPressed(terminal)
        #expect(selections == [.terminal])
    }

    private func utilityButton(label: String, identifier: String) -> UIButton {
        let button = UIButton(type: .system)
        button.accessibilityLabel = label
        button.accessibilityIdentifier = identifier
        return button
    }
}
