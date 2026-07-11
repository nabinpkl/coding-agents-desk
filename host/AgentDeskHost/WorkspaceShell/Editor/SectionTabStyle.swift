import AppKit

/// Shared visual language for section-like tabs that merge into the content below.
enum SectionTabStyle {
    static let activeBackground = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(white: dark ? 0.11 : 0.92, alpha: 1)
    }

    static let divider = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(white: dark ? 1 : 0, alpha: dark ? 0.12 : 0.14)
    }

    static func pixel(for view: NSView) -> CGFloat {
        1 / (view.window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2)
    }
}
