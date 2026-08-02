import AppKit
import PtyTerminalWebView
import WorkspaceIDE

@MainActor
final class WorkspaceIDEWindowContentView: NSView {
    private static let dividerThickness: CGFloat = 8
    private static let resizeStep = 0.05

    let controller: WorkspaceIDEController
    let terminalController: WorkspaceIDEMacTerminalController

    private let sidebarDivider = WorkspaceIDEPaneDivider(
        axis: .vertical,
        identifier: "workspace-ide-sidebar-divider",
        label: "Resize IDE sidebar"
    )
    private let terminalDivider = WorkspaceIDEPaneDivider(
        axis: .horizontal,
        identifier: "workspace-ide-terminal-divider",
        label: "Resize IDE terminal"
    )
    private let rightColumn = NSView()
    private let terminalContainer = NSView()
    private var sidebarWidthConstraint: NSLayoutConstraint?
    private var dividerWidthConstraint: NSLayoutConstraint?
    private var terminalHeightConstraint: NSLayoutConstraint?
    private var dividerHeightConstraint: NSLayoutConstraint?

    init(controller: WorkspaceIDEController, terminalController: WorkspaceIDEMacTerminalController) {
        self.controller = controller
        self.terminalController = terminalController
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Workspace IDE")
        setUpViews()
        applyLayoutState()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("WorkspaceIDEWindowContentView is code-only") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyTerminalContainerBackground()
    }

    /// The terminal web surface follows the system appearance itself; this is the backdrop it sits
    /// on. A `CALayer` colour does not re-resolve on an appearance change, so it is reapplied here
    /// rather than assigned once at setup.
    private func applyTerminalContainerBackground() {
        terminalContainer.layer?.backgroundColor = PtyTerminalSurfaceAppearance.resolved(
            PtyTerminalSurfaceAppearance.surface,
            for: effectiveAppearance
        )
    }

    func applyLayoutState() {
        let state = controller.currentLocalState
        controller.sidebarView.isHidden = !state.sidebarVisible
        sidebarDivider.isHidden = !state.sidebarVisible
        replaceSidebarWidth(state.sidebarVisible
            ? controller.sidebarView.widthAnchor.constraint(
                equalTo: widthAnchor,
                multiplier: CGFloat(state.sidebarFraction)
            )
            : controller.sidebarView.widthAnchor.constraint(equalToConstant: 0))
        dividerWidthConstraint?.constant = state.sidebarVisible ? Self.dividerThickness : 0

        terminalContainer.isHidden = !state.terminalVisible
        terminalDivider.isHidden = !state.terminalVisible
        replaceTerminalHeight(state.terminalVisible
            ? terminalContainer.heightAnchor.constraint(
                equalTo: rightColumn.heightAnchor,
                multiplier: CGFloat(state.terminalFraction)
            )
            : terminalContainer.heightAnchor.constraint(equalToConstant: 0))
        dividerHeightConstraint?.constant = state.terminalVisible ? Self.dividerThickness : 0
        terminalController.setPanePresented(state.terminalVisible)
    }

    private func setUpViews() {
        let sidebar = controller.sidebarView
        let editor = controller.editorView
        let terminal = terminalController.contentView
        [sidebar, sidebarDivider, rightColumn].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            addSubview($0)
        }
        [editor, terminalDivider, terminalContainer].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            rightColumn.addSubview($0)
        }
        terminal.translatesAutoresizingMaskIntoConstraints = false
        terminalContainer.addSubview(terminal)
        sidebar.setAccessibilityIdentifier("workspace-ide-sidebar")
        editor.setAccessibilityIdentifier("workspace-ide-editor")
        terminalContainer.wantsLayer = true
        applyTerminalContainerBackground()

        sidebarWidthConstraint = sidebar.widthAnchor.constraint(
            equalTo: widthAnchor,
            multiplier: CGFloat(controller.currentLocalState.sidebarFraction)
        )
        dividerWidthConstraint = sidebarDivider.widthAnchor.constraint(equalToConstant: Self.dividerThickness)
        terminalHeightConstraint = terminalContainer.heightAnchor.constraint(
            equalTo: rightColumn.heightAnchor,
            multiplier: CGFloat(controller.currentLocalState.terminalFraction)
        )
        dividerHeightConstraint = terminalDivider.heightAnchor.constraint(equalToConstant: Self.dividerThickness)

        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: leadingAnchor),
            sidebar.topAnchor.constraint(equalTo: topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebarWidthConstraint!,
            sidebarDivider.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            sidebarDivider.topAnchor.constraint(equalTo: topAnchor),
            sidebarDivider.bottomAnchor.constraint(equalTo: bottomAnchor),
            dividerWidthConstraint!,
            rightColumn.leadingAnchor.constraint(equalTo: sidebarDivider.trailingAnchor),
            rightColumn.trailingAnchor.constraint(equalTo: trailingAnchor),
            rightColumn.topAnchor.constraint(equalTo: topAnchor),
            rightColumn.bottomAnchor.constraint(equalTo: bottomAnchor),
            editor.leadingAnchor.constraint(equalTo: rightColumn.leadingAnchor),
            editor.trailingAnchor.constraint(equalTo: rightColumn.trailingAnchor),
            editor.topAnchor.constraint(equalTo: rightColumn.topAnchor),
            editor.bottomAnchor.constraint(equalTo: terminalDivider.topAnchor),
            terminalDivider.leadingAnchor.constraint(equalTo: rightColumn.leadingAnchor),
            terminalDivider.trailingAnchor.constraint(equalTo: rightColumn.trailingAnchor),
            terminalDivider.bottomAnchor.constraint(equalTo: terminalContainer.topAnchor),
            dividerHeightConstraint!,
            terminalContainer.leadingAnchor.constraint(equalTo: rightColumn.leadingAnchor),
            terminalContainer.trailingAnchor.constraint(equalTo: rightColumn.trailingAnchor),
            terminalContainer.bottomAnchor.constraint(equalTo: rightColumn.bottomAnchor),
            terminalHeightConstraint!,
            terminal.leadingAnchor.constraint(equalTo: terminalContainer.leadingAnchor),
            terminal.trailingAnchor.constraint(equalTo: terminalContainer.trailingAnchor),
            terminal.topAnchor.constraint(equalTo: terminalContainer.topAnchor),
            terminal.bottomAnchor.constraint(equalTo: terminalContainer.bottomAnchor),
        ])

        sidebarDivider.onDrag = { [weak self] delta in self?.resizeSidebar(by: delta) }
        sidebarDivider.onIncrement = { [weak self] in self?.adjustSidebar(by: Self.resizeStep) }
        sidebarDivider.onDecrement = { [weak self] in self?.adjustSidebar(by: -Self.resizeStep) }
        terminalDivider.onDrag = { [weak self] delta in self?.resizeTerminal(by: delta) }
        terminalDivider.onIncrement = { [weak self] in self?.adjustTerminal(by: Self.resizeStep) }
        terminalDivider.onDecrement = { [weak self] in self?.adjustTerminal(by: -Self.resizeStep) }
    }

    private func resizeSidebar(by delta: CGFloat) {
        guard bounds.width > 0 else { return }
        adjustSidebar(by: Double(delta / bounds.width))
    }

    private func resizeTerminal(by delta: CGFloat) {
        guard rightColumn.bounds.height > 0 else { return }
        adjustTerminal(by: Double(-delta / rightColumn.bounds.height))
    }

    private func adjustSidebar(by delta: Double) {
        let state = controller.currentLocalState
        controller.setPaneLayout(
            sidebarVisible: state.sidebarVisible,
            terminalVisible: state.terminalVisible,
            sidebarFraction: state.sidebarFraction + delta,
            terminalFraction: state.terminalFraction
        )
        applyLayoutState()
    }

    private func adjustTerminal(by delta: Double) {
        let state = controller.currentLocalState
        controller.setPaneLayout(
            sidebarVisible: state.sidebarVisible,
            terminalVisible: state.terminalVisible,
            sidebarFraction: state.sidebarFraction,
            terminalFraction: state.terminalFraction + delta
        )
        applyLayoutState()
    }

    private func replaceSidebarWidth(_ next: NSLayoutConstraint) {
        sidebarWidthConstraint?.isActive = false
        sidebarWidthConstraint = next
        next.isActive = true
    }

    private func replaceTerminalHeight(_ next: NSLayoutConstraint) {
        terminalHeightConstraint?.isActive = false
        terminalHeightConstraint = next
        next.isActive = true
    }
}
