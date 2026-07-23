import Testing
import UIKit

@MainActor
struct SurfaceControlRailTests {
    @Test func presentsSurfaceAndUtilityButtonsInOneVerticalRail() throws {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let orientation = utilityButton(label: "Rotate", identifier: "orientation-toggle")
        let settings = utilityButton(label: "Settings", identifier: "settings-button")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: orientation,
            settingsButton: settings
        )

        rail.setSurfaces(
            [.control, .agent, .terminal, .browser, .workspace, .ide],
            selected: .control,
            onSelection: { _ in }
        )

        #expect(rail.accessibilityIdentifier == "surface-control-rail")
        #expect(rail.axis == .vertical)
        #expect(rail.backgroundColor == .clear)
        #expect(!rail.isOpaque)
        #expect(rail.collapseButton.accessibilityIdentifier == "surface-control-collapse")
        #expect(rail.collapseButton.accessibilityLabel == "Collapse controls")
        #expect(rail.intrinsicContentSize.width == 60)
        #expect(rail.surfaceButtons.count == 6)
        #expect(rail.surfaceButtons.map(\.accessibilityLabel) == [
            "Control", "Agent", "Terminal", "Browser", "Workspace", "IDE"
        ])
        #expect(rail.utilityButtons == [gesture, orientation, settings])
        for button in rail.surfaceButtons + rail.utilityButtons {
            #expect(button.constraints.contains { $0.firstAttribute == .height && $0.constant == 44 })
            #expect(button.constraints.contains { $0.firstAttribute == .width && $0.constant == 44 })
        }
    }

    @Test func selectionUpdatesVisualStateAndEmitsTheSelectedSurface() throws {
        let rail = SurfaceControlRail(
            gestureButton: utilityButton(label: "Gesture", identifier: "gesture-toggle"),
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
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
        terminalButton.sendActions(for: .touchUpInside)

        #expect(selections == [.terminal])
        #expect(terminalButton.isSelected)
        #expect(terminalButton.accessibilityTraits.contains(.selected))
        #expect(rail.surfaceButtons.first { $0.accessibilityLabel == "Control" }?.isSelected == false)
    }

    @Test func refreshingAvailabilityReusesUtilityButtonsWithoutDuplicates() {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let orientation = utilityButton(label: "Rotate", identifier: "orientation-toggle")
        let settings = utilityButton(label: "Settings", identifier: "settings-button")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: orientation,
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
        #expect(rail.utilityButtons == [gesture, orientation, settings])
        #expect(Set(rail.utilityButtons.map(ObjectIdentifier.init)).count == 3)
    }

    @Test func utilitySelectionUsesTheSameVisualLanguageAsSurfaceSelection() {
        let gesture = utilityButton(label: "Gesture", identifier: "gesture-toggle")
        let rail = SurfaceControlRail(
            gestureButton: gesture,
            orientationButton: utilityButton(label: "Rotate", identifier: "orientation-toggle"),
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

        rail.collapseButton.sendActions(for: .touchUpInside)

        #expect(rail.isCollapsed)
        #expect(rail.collapseButton.isHidden == false)
        #expect(rail.collapseButton.accessibilityLabel == "Expand controls")
        #expect(rail.collapseButton.accessibilityValue == "Collapsed")
        #expect(rail.intrinsicContentSize.width == 44)
        #expect(rail.intrinsicContentSize.height == expandedHeight)
        #expect(rail.surfaceButtons.allSatisfy { !$0.isHidden && $0.alpha == 0 })
        #expect(rail.utilityButtons.allSatisfy { !$0.isHidden && $0.alpha == 0 })
        #expect(rail.surfaceButtons.allSatisfy { !$0.isUserInteractionEnabled })
        #expect(rail.utilityButtons.allSatisfy { $0.accessibilityElementsHidden })
        #expect(agent.isSelected)

        rail.collapseButton.sendActions(for: .touchUpInside)

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

    private func utilityButton(label: String, identifier: String) -> UIButton {
        let button = UIButton(type: .system)
        button.accessibilityLabel = label
        button.accessibilityIdentifier = identifier
        return button
    }
}
