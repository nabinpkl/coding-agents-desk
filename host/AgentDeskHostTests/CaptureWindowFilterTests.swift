import CoreGraphics
import Testing

@testable import AgentDeskHost

// The rule that decides what the phone's window picker offers and what the Space thumbnail
// compositor draws. `SCWindow` cannot be constructed outside ScreenCaptureKit, which is why
// the rule takes plain facts and these tests exercise it directly.
@Suite("Capture window filter")
struct CaptureWindowFilterTests {
    private func isCandidate(
        bundleIdentifier: String? = "dev.test.editor",
        windowLayer: Int = 0,
        width: CGFloat = 800,
        height: CGFloat = 600,
        title: String? = "Build log",
        canActivate: Bool = true
    ) -> Bool {
        CaptureWindowFilter.isCandidate(
            bundleIdentifier: bundleIdentifier,
            windowLayer: windowLayer,
            width: width,
            height: height,
            title: title,
            canActivate: canActivate
        )
    }

    @Test("an ordinary titled app window is offered")
    func anOrdinaryTitledAppWindowIsOffered() {
        #expect(isCandidate())
    }

    // The bug this suite was written for: a menu-bar-only app parks an untitled placeholder
    // at layer 0, large enough to clear the size floor, and it filled the picker with apps
    // that had nothing to watch.
    @Test("an untitled placeholder window is not offered")
    func anUntitledPlaceholderWindowIsNotOffered() {
        #expect(!isCandidate(width: 500, height: 500, title: ""))
        #expect(!isCandidate(width: 500, height: 500, title: nil))
    }

    // Accessory apps are not excluded wholesale, because the same ones that park
    // placeholders also own real windows a viewer wants. Only the placeholder goes.
    @Test("a menu-bar app's real titled window is still offered")
    func aMenuBarAppsRealTitledWindowIsStillOffered() {
        #expect(isCandidate(bundleIdentifier: "com.bitwarden.desktop", title: "Bitwarden"))
    }

    // Window mode raises the window and drives it, so an app the system will not let anyone
    // switch to cannot be a target no matter what it draws.
    @Test("a window owned by an unactivatable process is not offered")
    func aWindowOwnedByAnUnactivatableProcessIsNotOffered() {
        #expect(!isCandidate(title: "AutoFill", canActivate: false))
    }

    @Test("dock and window-manager chrome is not offered")
    func dockAndWindowManagerChromeIsNotOffered() {
        for bundleId in CaptureWindowFilter.excludedBundleIds {
            #expect(!isCandidate(bundleIdentifier: bundleId, title: "Dock"))
        }
    }

    @Test("overlays above the document layer are not offered")
    func overlaysAboveTheDocumentLayerAreNotOffered() {
        #expect(!isCandidate(windowLayer: 25))
    }

    @Test("windows below the size floor are not offered")
    func windowsBelowTheSizeFloorAreNotOffered() {
        let floor = CaptureWindowFilter.minimumSidePoints
        #expect(!isCandidate(width: floor - 1, height: 600))
        #expect(!isCandidate(width: 800, height: floor - 1))
        #expect(isCandidate(width: floor, height: floor))
    }

    @Test("a window with no owning bundle is not offered")
    func aWindowWithNoOwningBundleIsNotOffered() {
        #expect(!isCandidate(bundleIdentifier: nil))
    }
}
