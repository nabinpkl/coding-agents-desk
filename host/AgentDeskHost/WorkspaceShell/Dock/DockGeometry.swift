import AppKit
import ApplicationServices

enum DockOrientation: Equatable {
    case bottom
    case left
    case right

    init(rawValue: String?) {
        switch rawValue {
        case "left":
            self = .left
        case "right":
            self = .right
        default:
            self = .bottom
        }
    }
}

struct DockGeometry: Equatable, Sendable {
    static let fallbackAutoHiddenDockThickness: CGFloat = 72

    let isAutoHidden: Bool
    let orientation: DockOrientation
    let revealedThickness: CGFloat

    var bottomRevealInset: CGFloat {
        isAutoHidden && orientation == .bottom ? revealedThickness : 0
    }

    static func fromPreferences(
        defaults: UserDefaults? = UserDefaults(suiteName: "com.apple.dock"),
        revealedThickness: CGFloat? = nil
    ) -> DockGeometry {
        DockGeometry(
            isAutoHidden: defaults?.bool(forKey: "autohide") ?? false,
            orientation: DockOrientation(rawValue: defaults?.string(forKey: "orientation")),
            revealedThickness: max(0, revealedThickness ?? fallbackAutoHiddenDockThickness)
        )
    }
}

protocol DockGeometryReading: Sendable {
    func currentDockGeometry() -> DockGeometry
}

@MainActor
final class DockGeometryMonitor {
    private let reader: DockGeometryReading
    private let queue: DispatchQueue
    private(set) var current: DockGeometry
    var onChange: (() -> Void)?

    init(
        reader: DockGeometryReading = SystemDockGeometryReader(),
        queue: DispatchQueue = DispatchQueue(label: "com.example.agentdesk.agentdesk.dock-geometry", qos: .utility)
    ) {
        self.reader = reader
        self.queue = queue
        current = DockGeometry.fromPreferences()
    }

    func refresh() {
        queue.async { [reader] in
            let next = reader.currentDockGeometry()
            Task { @MainActor [weak self] in
                guard let self, self.current != next else { return }
                self.current = next
                self.onChange?()
            }
        }
    }
}

struct SystemDockGeometryReader: DockGeometryReading {
    func currentDockGeometry() -> DockGeometry {
        let preferenceGeometry = DockGeometry.fromPreferences()
        guard preferenceGeometry.isAutoHidden else { return preferenceGeometry }
        return DockGeometry.fromPreferences(revealedThickness: dockRevealedThickness(orientation: preferenceGeometry.orientation))
    }

    private func dockRevealedThickness(orientation: DockOrientation) -> CGFloat {
        guard let dock = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.apple.dock" || $0.localizedName == "Dock"
        }) else {
            return DockGeometry.fallbackAutoHiddenDockThickness
        }
        let app = AXUIElementCreateApplication(dock.processIdentifier)
        guard AXUIElementSetMessagingTimeout(app, 0.2) == .success else {
            return DockGeometry.fallbackAutoHiddenDockThickness
        }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement],
              let list = children.first
        else {
            return DockGeometry.fallbackAutoHiddenDockThickness
        }
        AXUIElementSetMessagingTimeout(list, 0.2)
        guard let size = Self.sizeAttribute(list, kAXSizeAttribute) else {
            return DockGeometry.fallbackAutoHiddenDockThickness
        }
        switch orientation {
        case .bottom:
            return max(0, size.height)
        case .left, .right:
            return max(0, size.width)
        }
    }

    private static func sizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let axValue = value,
              CFGetTypeID(axValue) == AXValueGetTypeID()
        else {
            return nil
        }
        var size = CGSize.zero
        guard AXValueGetType(axValue as! AXValue) == .cgSize,
              AXValueGetValue(axValue as! AXValue, .cgSize, &size)
        else {
            return nil
        }
        return size
    }
}
