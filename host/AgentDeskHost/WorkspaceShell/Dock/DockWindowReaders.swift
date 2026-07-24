import ApplicationServices
import CoreGraphics

struct AXDockWindowReader: DockAXWindowReading {
    static let messagingTimeout: Float = 0.15

    func windows(for pid: pid_t) -> DockAXWindowResult {
        let app = AXUIElementCreateApplication(pid)
        let timeoutResult = AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        guard timeoutResult == .success else { return .error(Int32(timeoutResult.rawValue)) }
        var rawWindows: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows)
        guard result == .success else { return .error(Int32(result.rawValue)) }
        guard let windows = rawWindows as? [AXUIElement] else { return .windows([]) }
        return .windows(windows.map(Self.windowFacts))
    }

    static func windowFacts(_ window: AXUIElement) -> DockAXWindowFacts {
        AXUIElementSetMessagingTimeout(window, messagingTimeout)
        return DockAXWindowFacts(
            title: stringAttribute(window, kAXTitleAttribute),
            role: stringAttribute(window, kAXRoleAttribute),
            subrole: stringAttribute(window, kAXSubroleAttribute),
            isFocused: boolAttribute(window, kAXFocusedAttribute),
            isMinimized: boolAttribute(window, kAXMinimizedAttribute),
            bounds: bounds(window)
        )
    }

    private static func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return "" }
        return value as? String ?? ""
    }

    private static func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return false }
        return (value as? NSNumber)?.boolValue ?? false
    }

    private static func bounds(_ element: AXUIElement) -> CGRect? {
        guard let position = pointAttribute(element, kAXPositionAttribute),
              let size = sizeAttribute(element, kAXSizeAttribute)
        else { return nil }
        return CGRect(origin: position, size: size)
    }

    private static func pointAttribute(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let axValue = value,
              CFGetTypeID(axValue) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        guard AXValueGetType(axValue as! AXValue) == .cgPoint,
              AXValueGetValue(axValue as! AXValue, .cgPoint, &point)
        else { return nil }
        return point
    }

    private static func sizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let axValue = value,
              CFGetTypeID(axValue) == AXValueGetTypeID()
        else { return nil }
        var size = CGSize.zero
        guard AXValueGetType(axValue as! AXValue) == .cgSize,
              AXValueGetValue(axValue as! AXValue, .cgSize, &size)
        else { return nil }
        return size
    }
}

struct CGDockWindowReader: DockCGWindowReading {
    func windows() -> [DockCGWindowFacts] {
        let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return raw.compactMap { info in
            guard let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let bounds = Self.bounds(from: info[kCGWindowBounds as String])
            else { return nil }
            let title = info[kCGWindowName as String] as? String ?? ""
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? Int.max
            let alpha = (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            return DockCGWindowFacts(
                pid: pid,
                windowID: id,
                title: title,
                layer: layer,
                alpha: alpha,
                bounds: bounds
            )
        }
    }

    private static func bounds(from raw: Any?) -> CGRect? {
        guard let dict = raw as? [String: Any] else { return nil }
        let x = (dict["X"] as? NSNumber)?.doubleValue ?? 0
        let y = (dict["Y"] as? NSNumber)?.doubleValue ?? 0
        let width = (dict["Width"] as? NSNumber)?.doubleValue ?? 0
        let height = (dict["Height"] as? NSNumber)?.doubleValue ?? 0
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
