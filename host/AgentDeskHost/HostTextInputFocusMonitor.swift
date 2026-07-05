import AppKit
import ApplicationServices
import Foundation
import os
import AgentDeskWire

enum HostTextInputFocusClassifier {
    private static let editableRoles: Set<String> = [
        "AXTextField",
        "AXTextArea",
        "AXComboBox",
        "AXSearchField",
        "AXSecureTextField"
    ]
    private static let editableSubroles: Set<String> = [
        "AXSearchField",
        "AXSecureTextField"
    ]

    static func classify(
        role: String?,
        subrole: String?,
        source: HostTextInputFocusSource,
        cursorKind: CursorKind? = nil
    ) -> HostTextInputFocusPush {
        let roleIsEditable = role.map { editableRoles.contains($0) } ?? false
        let subroleIsEditable = subrole.map { editableSubroles.contains($0) } ?? false
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        return HostTextInputFocusPush(
            editable: roleIsEditable || subroleIsEditable,
            secure: secure,
            source: source,
            role: role,
            subrole: subrole,
            cursorKind: cursorKind
        )
    }
}

final class HostTextInputFocusMonitor {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "text-input-focus")
    private let interval: TimeInterval
    private let query: () -> HostTextInputFocusPush
    private var timer: DispatchSourceTimer?
    private(set) var latest: HostTextInputFocusPush?

    var onChange: ((HostTextInputFocusPush) -> Void)?

    init(
        interval: TimeInterval = 0.25,
        query: @escaping () -> HostTextInputFocusPush = HostTextInputFocusMonitor.queryFrontmostFocusedElement
    ) {
        self.interval = interval
        self.query = query
    }

    func start() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now(), repeating: interval)
        source.setEventHandler { [weak self] in self?.tick() }
        timer = source
        source.resume()
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    @discardableResult
    func tick() -> HostTextInputFocusPush? {
        let push = query()
        guard push != latest else { return nil }
        latest = push
        logger.debug("text input focus editable=\(push.editable, privacy: .public) secure=\(push.secure, privacy: .public) source=\(push.source.rawValue, privacy: .public) role=\(push.role ?? "nil", privacy: .public) subrole=\(push.subrole ?? "nil", privacy: .public)")
        onChange?(push)
        return push
    }

    private static func queryFrontmostFocusedElement() -> HostTextInputFocusPush {
        guard AXIsProcessTrusted(),
              let app = NSWorkspace.shared.frontmostApplication else {
            return HostTextInputFocusPush(editable: false, secure: false, source: .none)
        }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var focusedValue: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )
        guard error == .success,
              let focused = focusedValue,
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            return HostTextInputFocusPush(editable: false, secure: false, source: .none)
        }
        let element = focused as! AXUIElement
        let role = stringAttribute(kAXRoleAttribute as CFString, from: element)
        let subrole = stringAttribute(kAXSubroleAttribute as CFString, from: element)
        return HostTextInputFocusClassifier.classify(
            role: role,
            subrole: subrole,
            source: .accessibility
        )
    }

    private static func stringAttribute(_ attribute: CFString, from element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
            return nil
        }
        return value as? String
    }
}
