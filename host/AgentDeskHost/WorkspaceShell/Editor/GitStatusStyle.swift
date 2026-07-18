import AppKit

/// How a git status looks in the sidebar — the single home for the colour + one-letter
/// badge, shared by the file tree and the source-control panel (both decorate the same
/// statuses, so the mapping lives once). Presentation only, kept out of the pure
/// `GitStatus` model, which never imports AppKit.
///
/// Colours follow VS Code's explorer palette: green for new content, amber for edits, red
/// for removal, orange for a conflict. The edit amber is appearance-aware: system yellow is
/// too pale on the light sidebar, but a darker amber would get muddy in dark mode.
extension GitFileStatus {
    var tint: NSColor {
        switch self {
        case .added, .untracked: return .systemGreen
        case .modified: return GitStatusPalette.modified
        case .deleted: return .systemRed
        case .conflicted: return .systemOrange
        case .ignored: return GitStatusPalette.ignored
        }
    }

    var selectedTint: NSColor {
        switch self {
        case .modified: return GitStatusPalette.selectedModified
        case .ignored: return GitStatusPalette.selectedIgnored
        default: return tint
        }
    }

    var badgeLetter: String {
        switch self {
        case .modified: return "M"
        case .added: return "A"
        case .deleted: return "D"
        case .untracked: return "U"
        case .conflicted: return "!"
        case .ignored: return "·"
        }
    }

    var accessibilityName: String {
        switch self {
        case .conflicted: return "Conflicted"
        case .modified: return "Modified"
        case .added: return "Added"
        case .deleted: return "Deleted"
        case .untracked: return "Untracked"
        case .ignored: return "Ignored"
        }
    }
}

private enum GitStatusPalette {
    static let modified = NSColor(name: nil) { appearance in
        switch SystemColorScheme(appearance: appearance) {
        case .light:
            return NSColor(srgbRed: 0.70, green: 0.42, blue: 0.00, alpha: 1)
        case .dark:
            return NSColor(srgbRed: 1.00, green: 0.82, blue: 0.40, alpha: 1)
        }
    }

    static let selectedModified = NSColor(srgbRed: 1.00, green: 0.92, blue: 0.55, alpha: 1)

    static let selectedIgnored = NSColor(srgbRed: 0.76, green: 0.84, blue: 0.84, alpha: 1)

    static let ignored = NSColor(name: nil) { appearance in
        switch SystemColorScheme(appearance: appearance) {
        case .light:
            return NSColor(srgbRed: 0.48, green: 0.48, blue: 0.48, alpha: 1)
        case .dark:
            return NSColor(srgbRed: 0.56, green: 0.56, blue: 0.56, alpha: 1)
        }
    }
}
