import AppKit

enum SystemColorScheme: Hashable {
    case light
    case dark

    init(appearance: NSAppearance) {
        let match = appearance.bestMatch(from: [
            .accessibilityHighContrastDarkAqua,
            .darkAqua,
            .accessibilityHighContrastAqua,
            .aqua
        ])
        switch match {
        case .darkAqua, .accessibilityHighContrastDarkAqua:
            self = .dark
        default:
            self = .light
        }
    }

    var placeholderBackgroundColor: NSColor {
        switch self {
        case .light:
            return NSColor(calibratedWhite: 0.98, alpha: 1)
        case .dark:
            return NSColor(calibratedWhite: 0.07, alpha: 1)
        }
    }
}
