import AppKit
import ApplicationServices
import Foundation
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
    private static let ordinaryNonEditableRoles: Set<String> = [
        "AXButton",
        "AXCheckBox",
        "AXImage",
        "AXLink",
        "AXMenu",
        "AXMenuBar",
        "AXMenuButton",
        "AXMenuItem",
        "AXPopUpButton",
        "AXRadioButton",
        "AXSlider",
        "AXStaticText",
        "AXSwitch",
        "AXToolbar"
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
        let editability: HostTextInputEditability
        if roleIsEditable || subroleIsEditable {
            editability = .editable
        } else if role.map({ ordinaryNonEditableRoles.contains($0) }) == true {
            editability = .nonEditable
        } else {
            editability = .ambiguous
        }
        return HostTextInputFocusPush(
            editability: editability,
            secure: secure,
            source: source,
            role: role,
            subrole: subrole,
            cursorKind: cursorKind
        )
    }
}

final class HostTextInputFocusResolver {
    private let query: () -> HostTextInputFocusPush

    init(
        query: @escaping () -> HostTextInputFocusPush = HostTextInputFocusResolver.queryFrontmostFocusedElement
    ) {
        self.query = query
    }

    func sampleCurrentFocus(cursorKind: CursorKind? = nil) -> HostTextInputFocusPush {
        let queried = query()
        return HostTextInputFocusPush(
            editability: queried.editability,
            secure: queried.secure,
            source: queried.source,
            role: queried.role,
            subrole: queried.subrole,
            cursorKind: cursorKind ?? queried.cursorKind
        )
    }

    private static func queryFrontmostFocusedElement() -> HostTextInputFocusPush {
        guard AXIsProcessTrusted() else {
            return HostTextInputFocusPush(editability: .ambiguous, secure: false, source: .none)
        }
        if let app = NSWorkspace.shared.frontmostApplication {
            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            if let focus = focusedElement(from: appElement) {
                return classifyFocusedElement(focus)
            }
        }
        let systemElement = AXUIElementCreateSystemWide()
        guard let focused = focusedElement(from: systemElement) else {
            return HostTextInputFocusPush(editability: .ambiguous, secure: false, source: .none)
        }
        return classifyFocusedElement(focused)
    }

    private static func focusedElement(from root: AXUIElement) -> AXUIElement? {
        var focusedValue: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(
            root,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )
        guard error == .success,
              let focused = focusedValue,
              CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            return nil
        }
        return (focused as! AXUIElement)
    }

    private static func classifyFocusedElement(_ element: AXUIElement) -> HostTextInputFocusPush {
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
