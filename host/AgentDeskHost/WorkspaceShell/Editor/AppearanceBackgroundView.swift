import AppKit

/// A solid layer-backed bar background. A layer's `backgroundColor` is a static `CGColor`
/// that would not follow a light/dark switch, so we re-resolve the dynamic color whenever
/// the effective appearance changes.
final class AppearanceBackgroundView: NSView {
    private let color: NSColor
    private var isKeyboardFocused = false

    init(color: NSColor) {
        self.color = color
        super.init(frame: .zero)
        wantsLayer = true
        applyColor()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
    }

    func setKeyboardFocused(_ focused: Bool) {
        guard isKeyboardFocused != focused else { return }
        isKeyboardFocused = focused
        applyColor()
    }

    private func applyColor() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = color.cgColor
            layer?.borderColor = isKeyboardFocused ? AppTheme.accent.cgColor : NSColor.clear.cgColor
            layer?.borderWidth = isKeyboardFocused ? 2 : 0
        }
    }
}
