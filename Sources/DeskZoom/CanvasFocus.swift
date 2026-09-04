import AppKit
import ApplicationServices

/// Moves keyboard focus onto the virtual display.
///
/// macOS decides where a new window opens from the *active* display, and active means the display holding
/// the focused window. Focus follows clicks, never the pointer, so teleporting the pointer onto the canvas
/// left focus on DeskZoom's own window back on the built-in screen, and anything launched from Spotlight
/// opened there. Activating the app under the destination is what makes the canvas the active display.
enum CanvasFocus {
    /// One on-screen window, reduced to what choosing between them needs.
    struct Window: Equatable {
        let pid: pid_t
        /// Window server layer. Ordinary application windows are layer 0; menus, the Dock, overlays and
        /// the desktop itself all sit on other layers and must not take focus.
        let layer: Int
        let frame: CGRect
    }

    /// The application owning the frontmost ordinary window at `point`. `windows` must be front-to-back,
    /// which is the order the window server lists them in.
    static func topmostOwner(at point: CGPoint, in windows: [Window], excluding excluded: pid_t) -> pid_t? {
        windows.first { $0.layer == 0 && $0.pid != excluded && $0.frame.contains(point) }?.pid
    }

    /// Gives focus to whatever is at `point` in global screen coordinates, falling back to the Finder when
    /// the spot is bare desktop, so the display still becomes the active one.
    static func activate(at point: CGPoint) {
        let own = ProcessInfo.processInfo.processIdentifier
        guard topmostOwner(at: point, in: onScreenWindows(), excluding: own) != nil else {
            activateFinder()
            return
        }
        guard focusWindow(at: point) else { activateFinder(); return }
    }

    /// Focuses the actual window under the point, not just its application. Making an app frontmost leaves
    /// the active Space where it was, so a display whose window merely belongs to the frontmost app does not
    /// become the display macOS opens new windows on. Raising and focusing the specific window is what moves
    /// the Space. Returns false when nothing focusable is there.
    private static func focusWindow(at point: CGPoint) -> Bool {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
              let hit, let window = enclosingWindow(of: hit)
        else { return false }

        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)

        var pid: pid_t = 0
        guard AXUIElementGetPid(window, &pid) == .success else { return true }
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        return true
    }

    /// The element under the pointer is usually a button or a text area; walk up to the window that owns it.
    private static func enclosingWindow(of element: AXUIElement) -> AXUIElement? {
        var current = element
        for _ in 0..<12 {
            var role: CFTypeRef?
            if AXUIElementCopyAttributeValue(current, kAXRoleAttribute as CFString, &role) == .success,
               (role as? String) == (kAXWindowRole as String) {
                return current
            }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                  let parent, CFGetTypeID(parent) == AXUIElementGetTypeID()
            else { return nil }
            current = parent as! AXUIElement
        }
        return nil
    }

    /// The Finder owns the desktop, so making it frontmost is the neutral way to hand a display focus
    /// without borrowing somebody's window. Used at launch so the canvas does not start out owned by
    /// DeskZoom, and whenever a click lands on empty desktop.
    static func activateFinder() {
        guard let finder, !finder.isActive else { return }
        hand(to: finder)
    }

    /// macOS refuses to let an inactive app activate a different one, and DeskZoom is deliberately
    /// inactive here. Measured 2026-09-04: `activate()` was silently ignored, and so was activating
    /// ourselves first and then calling `activate(from:)`, because our own activation had not landed yet.
    /// Setting the Accessibility frontmost attribute does not depend on who is active. It needs the same
    /// Accessibility grant the event taps already require, so it adds no new permission.
    private static func hand(to app: NSRunningApplication) {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }

    private static var finder: NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == "com.apple.finder" }
    }

    private static func onScreenWindows() -> [Window] {
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.compactMap { entry in
            guard let pid = entry[kCGWindowOwnerPID as String] as? pid_t,
                  let layer = entry[kCGWindowLayer as String] as? Int,
                  let bounds = entry[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"], let height = bounds["Height"]
            else { return nil }
            return Window(pid: pid, layer: layer, frame: CGRect(x: x, y: y, width: width, height: height))
        }
    }
}
