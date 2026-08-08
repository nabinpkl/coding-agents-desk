import AppKit
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
        height: CGFloat,
        title: String?,
        canActivate: Bool
    ) -> Bool {
        guard let bundleIdentifier else { return false }
        if excludedBundleIds.contains(bundleIdentifier) { return false }
        // An app with activation policy `.prohibited` cannot be brought to the front at all,
        // so its windows can never be raised or driven. That is exactly what the XPC view
        // services are -- CursorUIViewService, AutoFill, Open and Save Panel Service,
        // SiriNCService -- each parking a layer-0 window that the picker was offering as if
        // it were an app the user could switch to.
        if !canActivate { return false }
        // Layer 0 is the normal document/app layer. Anything else is an overlay.
        if windowLayer != 0 { return false }
        if width < minimumSidePoints || height < minimumSidePoints { return false }
        // A menu-bar-only app still owns layer-0 windows: Raycast, Bitwarden, LinearMouse,
        // and this host all park an untitled placeholder offscreen, and those placeholders
        // are what filled the picker with apps that have no window to watch. Activation
        // policy does not separate them, because the same accessory apps also own real
        // titled windows a viewer does want. The title does: every parked placeholder
        // measured on this Mac was untitled, and every real window carried its name. It is
        // also the honest UX rule -- a picker tile with an icon and no title is one the user
        // cannot identify anyway.
        guard let title, !title.isEmpty else { return false }
        return true
    }

    static func candidates(_ content: SCShareableContent) -> [SCWindow] {
        // Policy is per process, and one app commonly owns several windows here, so resolve
        // each pid once rather than paying an NSRunningApplication lookup per window.
        var canActivateByPID: [pid_t: Bool] = [:]
        return content.windows.filter { win in
            guard let app = win.owningApplication else { return false }
            let canActivate: Bool
            if let known = canActivateByPID[app.processID] {
                canActivate = known
            } else {
                // A pid that no longer resolves is kept: the title rule below is the strict
                // one, and dropping a window because its owner raced us would be a picker
                // entry that flickers away for no reason the user can see.
                let policy = NSRunningApplication(processIdentifier: app.processID)?.activationPolicy
                canActivate = policy != .prohibited
                canActivateByPID[app.processID] = canActivate
            }
            return isCandidate(
                bundleIdentifier: app.bundleIdentifier,
                windowLayer: win.windowLayer,
                width: win.frame.width,
                height: win.frame.height,
                title: win.title,
                canActivate: canActivate
            )
        }
    }
}
