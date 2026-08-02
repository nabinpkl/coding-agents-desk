import Testing
import UIKit

@MainActor
struct SurfaceControlRailTests {
    @Test func deferredMediaLayoutInstallsWhenSinkFollowsPreVideoShell() {
        var installation = DeferredMediaLayoutInstallation()

        let beforeSink = installation.beginIfReady(shellMounted: true, sinkMounted: false)
        let afterSink = installation.beginIfReady(shellMounted: true, sinkMounted: true)
        let duplicate = installation.beginIfReady(shellMounted: true, sinkMounted: true)
        #expect(!beforeSink)
        #expect(afterSink)
        #expect(!duplicate)

        installation.reset()
        let afterReset = installation.beginIfReady(shellMounted: true, sinkMounted: true)
        #expect(afterReset)
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
            [.control, .agent, .terminal, .browser, .workspace, .ide],
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
            [.control, .agent, .terminal, .browser, .workspace, .ide],
            selected: .browser,
            onSelection: { _ in }
        )
        rail.setSurfaces(
            [.control, .agent, .terminal, .workspace, .ide],
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

    /// The toggle is the only control a closed rail leaves on screen, so it must
    /// not move when the session gains or loses a surface button. Leading the
    /// stack pins it to the top of the rail, which is itself top-anchored.
    @Test func theToggleLeadsTheRailSoItsPositionSurvivesSurfaceChanges() {
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
        let controls = rail.surfaceButtons + rail.utilityButtons
        #expect(controls.allSatisfy { $0.convert($0.bounds, to: rail).minY > toggleTop })
    }

    private func utilityButton(label: String, identifier: String) -> UIButton {
        let button = UIButton(type: .system)
        button.accessibilityLabel = label
        button.accessibilityIdentifier = identifier
        return button
    }
}
