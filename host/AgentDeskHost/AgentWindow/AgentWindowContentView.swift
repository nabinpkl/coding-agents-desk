import AppKit

/// The Agents window's content view: whatever the window is showing, plus the window-level key
/// equivalents.
///
/// It exists because the window comes in two classes -- a nonactivating `AgentPanelWindow` normally,
/// a plain `NSWindow` under AX automation -- so an override on either would cover only half the
/// launches. `NSWindow` walks its content view's hierarchy for key equivalents before the responder
/// chain sees the key, so owning them one level down covers both without a second subclass.
@MainActor
final class AgentWindowContentView: NSView {
    var onZoomCommand: ((AgentWindowZoomCommand) -> Void)?
    let titlebarDragRegionForTesting: NSView

    init(content: NSView, titlebarLayout: AgentWindowTitlebarLayout) {
        let titlebarDragRegion = AgentWindowTitlebarDragView()
        self.titlebarDragRegionForTesting = titlebarDragRegion
        super.init(frame: .zero)
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        titlebarDragRegion.translatesAutoresizingMaskIntoConstraints = false
        titlebarDragRegion.toolTip = "Drag Agents window"
        titlebarDragRegion.setAccessibilityElement(false)
        addSubview(titlebarDragRegion)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor),
            content.trailingAnchor.constraint(equalTo: trailingAnchor),
            content.topAnchor.constraint(equalTo: topAnchor),
            content.bottomAnchor.constraint(equalTo: bottomAnchor),
            titlebarDragRegion.leadingAnchor.constraint(
                equalTo: leadingAnchor,
                constant: titlebarLayout.dragRegionLeading
            ),
            titlebarDragRegion.topAnchor.constraint(equalTo: topAnchor),
            titlebarDragRegion.widthAnchor.constraint(equalToConstant: titlebarLayout.dragRegionWidth),
            titlebarDragRegion.heightAnchor.constraint(equalToConstant: titlebarLayout.dragRegionHeight),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("AgentWindowContentView does not support Interface Builder")
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Checked before `super`, which walks the subviews: the webview would otherwise see the
        // chord first and scroll or insert on it.
        guard let command = AgentWindowZoomShortcut.command(for: event) else {
            return super.performKeyEquivalent(with: event)
        }
        onZoomCommand?(command)
        return true
    }
}
