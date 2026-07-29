import UIKit

enum KeyboardKeyRole {
    case regular
    case special
}

struct KeyboardKeyVisualTokens: Equatable {
    let restingWhite: CGFloat
    let pressedWhite: CGFloat
    let shadowOpacity: Float
}

enum KeyboardKeyAppearance {
    static let cornerRadius: CGFloat = 8
    static let restingShadowOffset = CGSize(width: 0, height: 1.5)
    static let restingShadowRadius: CGFloat = 0.75
    static let pressedShadowOffset = CGSize(width: 0, height: 0.5)
    static let pressedShadowRadius: CGFloat = 0.25

    static func tokens(
        for role: KeyboardKeyRole,
        style: UIUserInterfaceStyle
    ) -> KeyboardKeyVisualTokens {
        switch (role, style) {
        case (.regular, .dark):
            KeyboardKeyVisualTokens(
                restingWhite: 0.45,
                pressedWhite: 0.58,
                shadowOpacity: 0.62
            )
        case (.special, .dark):
            KeyboardKeyVisualTokens(
                restingWhite: 0.28,
                pressedWhite: 0.40,
                shadowOpacity: 0.68
            )
        case (.regular, _):
            KeyboardKeyVisualTokens(
                restingWhite: 1,
                pressedWhite: 0.82,
                shadowOpacity: 0.28
            )
        case (.special, _):
            KeyboardKeyVisualTokens(
                restingWhite: 0.73,
                pressedWhite: 0.62,
                shadowOpacity: 0.30
            )
        }
    }

    static func restingFill(for role: KeyboardKeyRole) -> UIColor {
        dynamicFill(for: role, isPressed: false)
    }

    static func pressedFill(for role: KeyboardKeyRole) -> UIColor {
        dynamicFill(for: role, isPressed: true)
    }

    private static func dynamicFill(
        for role: KeyboardKeyRole,
        isPressed: Bool
    ) -> UIColor {
        UIColor { traits in
            let values = tokens(for: role, style: traits.userInterfaceStyle)
            return UIColor(
                white: isPressed
                    ? values.pressedWhite
                    : values.restingWhite,
                alpha: 1
            )
        }
    }
}
