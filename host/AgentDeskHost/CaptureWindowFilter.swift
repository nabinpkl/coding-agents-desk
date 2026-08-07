import CoreGraphics
import ScreenCaptureKit

// Which of the Mac's windows are worth showing a human.
//
// One home for the rule, shared by the Space thumbnail compositor and the phone's window
// picker. They had drifted toward two copies of the same list of bundle ids; a window the
// picker offers but the thumbnails ignore (or the reverse) is a bug nobody would look for.
enum CaptureWindowFilter {
    // Chrome that draws as ordinary windows: the Dock, Stage Manager's strip, Control
    // Center. Streaming or thumbnailing any of them shows the user furniture, not work.
    static let excludedBundleIds: Set<String> = [
        "com.apple.dock",
        "com.apple.WindowManager",
        "com.apple.controlcenter"
    ]

    // Below this, a window is a tooltip, a badge, or a shadow helper.
    static let minimumSidePoints: CGFloat = 50

    // Split from `candidates` so the rule itself is testable without an SCWindow, which
    // cannot be constructed outside ScreenCaptureKit.
    static func isCandidate(
        bundleIdentifier: String?,
        windowLayer: Int,
        width: CGFloat,
        height: CGFloat
    ) -> Bool {
        guard let bundleIdentifier else { return false }
        if excludedBundleIds.contains(bundleIdentifier) { return false }
        // Layer 0 is the normal document/app layer. Anything else is an overlay.
        if windowLayer != 0 { return false }
        if width < minimumSidePoints || height < minimumSidePoints { return false }
        return true
    }

    static func candidates(_ content: SCShareableContent) -> [SCWindow] {
        content.windows.filter { win in
            isCandidate(
                bundleIdentifier: win.owningApplication?.bundleIdentifier,
                windowLayer: win.windowLayer,
                width: win.frame.width,
                height: win.frame.height
            )
        }
    }
}
