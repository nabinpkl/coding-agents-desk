import AppKit

/// A panel's content view plus its window-level zoom key equivalents.
///
/// `NSWindow` walks its content view hierarchy for key equivalents before the responder chain sees
/// the webview. Owning the chords one level below the window makes the behavior independent of the
/// panel's concrete window class.
@MainActor
final class PanelWindowContentView: NSView {
    var onZoomCommand: ((PanelWindowZoomCommand) -> Void)?

    init(content: NSView) {
        super.init(frame: .zero)
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PanelWindowContentView does not support Interface Builder")
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Checked before `super`, which walks the subviews: the webview would otherwise see the
        // chord first and scroll or insert on it.
        guard let command = PanelWindowZoomShortcut.command(for: event) else {
            return super.performKeyEquivalent(with: event)
        }
        onZoomCommand?(command)
        return true
    }
}
