import Foundation

public enum KeyboardPage: String, Codable, Equatable, Sendable {
    case alphabet
    case numbers
    case symbols
}

public enum KeyboardShiftState: String, Codable, Equatable, Sendable {
    case off
    case on
    case locked
}

public enum KeyboardTypingTarget: Equatable, Sendable {
    case document
    case draft(recordingID: String)
}

public enum KeyboardFieldKind: String, Codable, Equatable, Sendable {
    case standard
    case email
    case url
}

public enum KeyboardKey: Equatable, Sendable {
    case character(String)
    case shift
    case delete
    case page(KeyboardPage)
    case globe
    case space
    case `return`
}

public struct KeyboardLayoutState: Equatable, Sendable {
    public private(set) var page: KeyboardPage
    public private(set) var shift: KeyboardShiftState
    public var typingTarget: KeyboardTypingTarget
    public var fieldKind: KeyboardFieldKind

    public init(
        page: KeyboardPage = .alphabet,
        shift: KeyboardShiftState = .off,
        typingTarget: KeyboardTypingTarget = .document,
        fieldKind: KeyboardFieldKind = .standard
    ) {
        self.page = page
        self.shift = shift
        self.typingTarget = typingTarget
        self.fieldKind = fieldKind
    }

    public var rows: [[KeyboardKey]] {
        switch page {
        case .alphabet:
            [
                "qwertyuiop".map { .character(String($0)) },
                "asdfghjkl".map { .character(String($0)) },
                [.shift]
                    + "zxcvbnm".map { .character(String($0)) }
                    + [.delete],
                alphabetBottomRow
            ]
        case .numbers:
            [
                "1234567890".map { .character(String($0)) },
                ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""]
                    .map(KeyboardKey.character),
                [.page(.symbols)]
                    + [".", ",", "?", "!", "'"].map(KeyboardKey.character)
                    + [.delete],
                [.page(.alphabet), .globe, .space, .return]
            ]
        case .symbols:
            [
                ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="]
                    .map(KeyboardKey.character),
                ["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"]
                    .map(KeyboardKey.character),
                [.page(.numbers)]
                    + [".", ",", "?", "!", "'"].map(KeyboardKey.character)
                    + [.delete],
                [.page(.alphabet), .globe, .space, .return]
            ]
        }
    }

    private var alphabetBottomRow: [KeyboardKey] {
        switch fieldKind {
        case .standard:
            [.page(.numbers), .globe, .space, .return]
        case .email:
            [
                .page(.numbers),
                .globe,
                .character("@"),
                .space,
                .character("."),
                .return,
            ]
        case .url:
            [
                .page(.numbers),
                .globe,
                .character("/"),
                .space,
                .character("."),
                .return,
            ]
        }
    }

    public mutating func handle(_ key: KeyboardKey) -> String? {
        switch key {
        case .character(let value):
            let output: String
            if page == .alphabet && shift != .off {
                output = value.uppercased()
            } else {
                output = value
            }
            if shift == .on {
                shift = .off
            }
            return output
        case .shift:
            handleShiftTap(isDoubleTap: shift == .on)
            return nil
        case .page(let newPage):
            page = newPage
            if newPage != .alphabet {
                shift = .off
            }
            return nil
        case .space:
            if shift == .on {
                shift = .off
            }
            return " "
        case .return:
            if shift == .on {
                shift = .off
            }
            return "\n"
        case .delete, .globe:
            return nil
        }
    }

    public mutating func setAutomaticShift(_ enabled: Bool) {
        guard page == .alphabet, shift != .locked else { return }
        shift = enabled ? .on : .off
    }

    public mutating func handleShiftTap(isDoubleTap: Bool) {
        switch shift {
        case .off:
            shift = .on
        case .on:
            shift = isDoubleTap ? .locked : .off
        case .locked:
            shift = .off
        }
    }
}

public enum KeyboardAutomaticInsertionGuard {
    public static func allowsInsertion(
        captureContext: KeyboardDocumentContextFingerprint?,
        currentContext: KeyboardDocumentContextFingerprint,
        keyboardControllerIsActive: Bool
    ) -> Bool {
        keyboardControllerIsActive
            && captureContext != nil
            && captureContext == currentContext
    }
}
