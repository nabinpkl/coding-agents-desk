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
        var id: CGWindowID = 0
        let pid: pid_t
        /// Window server layer. Ordinary application windows are layer 0; menus, the Dock, overlays and
        /// the desktop itself all sit on other layers and must not take focus.
        let layer: Int
        let frame: CGRect
        var owner: String = ""
        var title: String = ""
    }

    /// The ordinary windows sitting on a display, front to back, with their frames moved into that
    /// display's own coordinates so a caller can aim at them without knowing where the display starts.
    /// Overlays, the Dock and wallpaper are not windows anyone means when they say "the windows here".
    static func onDisplay(_ windows: [Window], bounds: CGRect) -> [Window] {
        windows
            .filter { $0.layer == 0 && $0.frame.width > 1 && $0.frame.height > 1 && bounds.intersects($0.frame) }
            .map {
                Window(id: $0.id, pid: $0.pid, layer: $0.layer,
                       frame: $0.frame.offsetBy(dx: -bounds.minX, dy: -bounds.minY),
                       owner: $0.owner, title: $0.title)
            }
    }

    static func windows(onDisplayWithBounds bounds: CGRect) -> [Window] {
        onDisplay(onScreenWindows(), bounds: bounds)
    }

    /// The application owning the frontmost ordinary window at `point`. `windows` must be front-to-back,
    /// which is the order the window server lists them in.
    static func topmostOwner(at point: CGPoint, in windows: [Window], excluding excluded: pid_t) -> pid_t? {
        windows.first { $0.layer == 0 && $0.pid != excluded && $0.frame.contains(point) }?.pid
    }

    /// Gives focus to whatever is at `point` in global screen coordinates, so the display becomes the one
    /// macOS opens new windows on.
    ///
    /// Over a window, Accessibility does it without pressing anything: raising and focusing the specific
    /// window moves the active Space, where merely making its application frontmost does not.
    ///
    /// Over bare desktop there is no window to focus, and making the Finder frontmost is the app-level move
    /// that measurably does not move the Space. A click is what macOS acts on, and on empty desktop there is
    /// nothing it can press, so that is what this sends. It is the same click the user would make by hand.
    static func activate(at point: CGPoint) {
        let own = ProcessInfo.processInfo.processIdentifier
        guard topmostOwner(at: point, in: onScreenWindows(), excluding: own) != nil else {
            click(at: point)
            return
        }
        _ = activateWindow(at: point)
    }

    private static func click(at point: CGPoint) {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
                .post(tap: .cghidEventTap)
        }
    }

    /// Focuses the actual window under the point, not just its application. Making an app frontmost leaves
    /// the active Space where it was, so a display whose window merely belongs to the frontmost app does not
    /// become the display macOS opens new windows on. Raising and focusing the specific window is what moves
    /// the Space. Returns false when nothing focusable is there. This is the one control path that changes
    /// the active app, and it is also what lets cmd shortcuts reach the window afterwards.
    static func activateWindow(at point: CGPoint) -> Bool {
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

    /// What sits at a point on screen, for the fake cursor to report or press. No pointer is involved:
    /// Accessibility hit-tests by coordinate, so this works while the real cursor is somewhere else
    /// entirely and without the target application being activated.
    static func element(at point: CGPoint) -> AXUIElement? {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success else { return nil }
        return hit
    }

    /// A short description of an element, for reporting what the fake cursor is over.
    static func describe(_ element: AXUIElement) -> String {
        let role = string(element, kAXRoleAttribute) ?? "?"
        // A text area's value is its whole document; a report of what is under the cursor wants a glimpse.
        let raw = string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute) ?? string(element, kAXValueAttribute) ?? ""
        let firstLine = raw.split(whereSeparator: \.isNewline).first.map(String.init) ?? raw
        let name = firstLine.count > 60 ? String(firstLine.prefix(57)) + "..." : firstLine
        var actions: CFArray?
        AXUIElementCopyActionNames(element, &actions)
        let available = (actions as? [String]) ?? []
        let app = owner(of: element)?.name ?? "?"
        return "\(app) \(role)\(name.isEmpty ? "" : " \"\(name)\"") actions=[\(available.joined(separator: ","))]"
    }

    /// The process an element belongs to, with a name fit for a report.
    static func owner(of element: AXUIElement) -> (pid: pid_t, name: String)? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else { return nil }
        return (pid, NSRunningApplication(processIdentifier: pid)?.localizedName ?? "pid \(pid)")
    }

    /// Gives an element keyboard focus within its own application, as a click on it would, without making
    /// that application frontmost. False when the element does not take focus; keystrokes then land on
    /// whatever the application already had focused.
    @discardableResult
    static func focus(_ element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable) == .success,
              settable.boolValue
        else { return false }
        return AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    }

    /// An element's text, when it has any. What a script reads back after typing to see whether the
    /// keystrokes arrived.
    static func value(of element: AXUIElement) -> String? {
        string(element, kAXValueAttribute as String)
    }

    /// Puts text at the element's insertion point, replacing any selection, through Accessibility rather
    /// than keystrokes. Text fields and areas accept this even from an application that drops posted key
    /// events. False when the element has no settable selected text, which is what a non-text element
    /// looks like.
    static func insert(_ text: String, into element: AXUIElement) -> Bool {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success,
              settable.boolValue
        else { return false }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success
    }

    /// Performs an element's press action. True when it had one and it succeeded.
    static func press(_ element: AXUIElement) -> Bool {
        var actions: CFArray?
        AXUIElementCopyActionNames(element, &actions)
        guard ((actions as? [String]) ?? []).contains(kAXPressAction as String) else { return false }
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let text = value as? String, !text.isEmpty
        else { return nil }
        return text
    }

    // MARK: Scrolling

    /// The scroll area containing a point, if there is one. Scrolling is a property of the container, not
    /// of whatever small thing the point happens to land on, so this walks up to find it.
    static func scrollArea(at point: CGPoint) -> AXUIElement? {
        guard var current = element(at: point) else { return nil }
        for _ in 0..<12 {
            if string(current, kAXRoleAttribute as String) == (kAXScrollAreaRole as String) { return current }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parent) == .success,
                  let parent, CFGetTypeID(parent) == AXUIElementGetTypeID()
            else { return nil }
            current = parent as! AXUIElement
        }
        return nil
    }

    enum ScrollAxis: String {
        case vertical, horizontal

        var barAttribute: String {
            switch self {
            case .vertical: return kAXVerticalScrollBarAttribute as String
            case .horizontal: return kAXHorizontalScrollBarAttribute as String
            }
        }
    }

    /// How far along a scroll area is on one axis, from 0 to 1, read off that scroll bar. Nil when it has
    /// none, which is what an area with nothing to scroll that way looks like.
    static func scroll(of area: AXUIElement, along axis: ScrollAxis) -> CGFloat? {
        guard let bar = bar(of: area, along: axis) else { return nil }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(bar, kAXValueAttribute as CFString, &value) == .success,
              let number = value as? NSNumber
        else { return nil }
        return CGFloat(number.doubleValue)
    }

    /// Moves a scroll area to a fraction of its length on one axis. This is the scroll bar's own value, so
    /// it is absolute positioning, the equivalent of dragging the bar rather than turning a wheel. Scroll
    /// wheel events cannot serve here: posted to a process they are ignored, exactly as clicks are.
    @discardableResult
    static func setScroll(of area: AXUIElement, along axis: ScrollAxis, to fraction: CGFloat) -> Bool {
        guard let bar = bar(of: area, along: axis) else { return false }
        let clamped = min(max(0, fraction), 1)
        return AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: Double(clamped))) == .success
    }

    private static func bar(of area: AXUIElement, along axis: ScrollAxis) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(area, axis.barAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
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

    /// The Finder owns the desktop, so making it frontmost is the neutral way to stop the canvas starting
    /// out owned by DeskZoom. Launch only: this is app-level and does not move the active Space.
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
            return Window(
                id: entry[kCGWindowNumber as String] as? CGWindowID ?? 0,
                pid: pid, layer: layer,
                frame: CGRect(x: x, y: y, width: width, height: height),
                owner: entry[kCGWindowOwnerName as String] as? String ?? "",
                title: entry[kCGWindowName as String] as? String ?? ""
            )
        }
    }
}
