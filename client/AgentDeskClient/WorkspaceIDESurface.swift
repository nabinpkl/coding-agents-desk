import UIKit
import WorkspaceIDE

@MainActor
final class WorkspaceIDESurface: UIView, WorkspaceIDEDelegate {
    private static let dividerThickness: CGFloat = 32
    private static let resizeStep = 0.05

    let controller: WorkspaceIDEController
    private let sidebarDivider = WorkspaceWorkbenchDivider(
        axis: .vertical,
        accessibilityLabel: "Resize IDE sidebar"
    )
    private let terminalDivider = WorkspaceWorkbenchDivider(
        axis: .horizontal,
        accessibilityLabel: "Resize IDE terminal"
    )
    private let rightColumn = UIView()
    private let terminalContainer = UIView()
    private var terminalSessionController: WorkspaceTerminalSessionController!
    private var sidebarWidthConstraint: NSLayoutConstraint?
    private var sidebarDividerWidthConstraint: NSLayoutConstraint?
    private var terminalHeightConstraint: NSLayoutConstraint?
    private var terminalDividerHeightConstraint: NSLayoutConstraint?

    init(
        controller: WorkspaceIDEController,
        terminalCoordinator: (any WorkspaceTerminalCoordinating)?,
        terminalSessionOpener: (any WorkspaceTerminalSessionOpening)?,
        terminalStateStore: WorkspaceWorkbenchStateStoring = WorkspaceWorkbenchStateStore.shared
    ) {
        self.controller = controller
        super.init(frame: .zero)
        controller.delegate = self
        setUp()
        terminalSessionController = WorkspaceTerminalSessionController(
            container: terminalContainer,
            coordinator: terminalCoordinator,
            sessionOpener: terminalSessionOpener,
            stateStore: terminalStateStore
        )
        terminalSessionController.setZoomScale(controller.currentLocalState.zoomScale)
        applyLayoutState()
        controller.start()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func teardown() {
        controller.stop()
        controller.delegate = nil
        terminalSessionController.teardown()
    }

    var sidebarWebViewForTesting: UIView { controller.sidebarView }
    var editorWebViewForTesting: UIView { controller.editorView }
    var terminalContainerForTesting: UIView { terminalContainer }
    var terminalZoomScaleForTesting: Double { terminalSessionController.zoomScaleForTesting }

    private func setUp() {
        backgroundColor = .systemBackground
        accessibilityIdentifier = "workspace-ide"
        let sidebar = controller.sidebarView
        let editor = controller.editorView
        [sidebar, sidebarDivider, rightColumn].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            addSubview($0)
        }
        [editor, terminalDivider, terminalContainer].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            rightColumn.addSubview($0)
        }
        sidebar.accessibilityIdentifier = "workspace-ide-sidebar"
        editor.accessibilityIdentifier = "workspace-ide-editor"
        terminalContainer.accessibilityIdentifier = "workspace-ide-terminal"
        terminalContainer.backgroundColor = .black

        let state = controller.currentLocalState
        sidebarWidthConstraint = sidebar.widthAnchor.constraint(equalTo: widthAnchor, multiplier: state.sidebarFraction)
        sidebarDividerWidthConstraint = sidebarDivider.widthAnchor.constraint(equalToConstant: Self.dividerThickness)
        terminalHeightConstraint = terminalContainer.heightAnchor.constraint(
            equalTo: rightColumn.heightAnchor,
            multiplier: state.terminalFraction
        )
        terminalDividerHeightConstraint = terminalDivider.heightAnchor.constraint(equalToConstant: Self.dividerThickness)

        NSLayoutConstraint.activate([
            sidebar.leadingAnchor.constraint(equalTo: leadingAnchor),
            sidebar.topAnchor.constraint(equalTo: topAnchor),
            sidebar.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebarWidthConstraint!,

            sidebarDivider.leadingAnchor.constraint(equalTo: sidebar.trailingAnchor),
            sidebarDivider.topAnchor.constraint(equalTo: topAnchor),
            sidebarDivider.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebarDividerWidthConstraint!,

            rightColumn.leadingAnchor.constraint(equalTo: sidebarDivider.trailingAnchor),
            rightColumn.trailingAnchor.constraint(equalTo: trailingAnchor),
            rightColumn.topAnchor.constraint(equalTo: topAnchor),
            rightColumn.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),

            editor.leadingAnchor.constraint(equalTo: rightColumn.leadingAnchor),
            editor.trailingAnchor.constraint(equalTo: rightColumn.trailingAnchor),
            editor.topAnchor.constraint(equalTo: rightColumn.topAnchor),
            editor.bottomAnchor.constraint(equalTo: terminalDivider.topAnchor),

            terminalDivider.leadingAnchor.constraint(equalTo: rightColumn.leadingAnchor),
            terminalDivider.trailingAnchor.constraint(equalTo: rightColumn.trailingAnchor),
            terminalDivider.bottomAnchor.constraint(equalTo: terminalContainer.topAnchor),
            terminalDividerHeightConstraint!,

            terminalContainer.leadingAnchor.constraint(equalTo: rightColumn.leadingAnchor),
            terminalContainer.trailingAnchor.constraint(equalTo: rightColumn.trailingAnchor),
            terminalContainer.bottomAnchor.constraint(equalTo: rightColumn.bottomAnchor),
            terminalHeightConstraint!,
        ])

        sidebarDivider.onPan = { [weak self] delta in self?.resizeSidebar(by: delta) }
        sidebarDivider.onIncrement = { [weak self] in self?.adjustSidebar(by: Self.resizeStep) }
        sidebarDivider.onDecrement = { [weak self] in self?.adjustSidebar(by: -Self.resizeStep) }
        terminalDivider.onPan = { [weak self] delta in self?.resizeTerminal(by: delta) }
        terminalDivider.onIncrement = { [weak self] in self?.adjustTerminal(by: Self.resizeStep) }
        terminalDivider.onDecrement = { [weak self] in self?.adjustTerminal(by: -Self.resizeStep) }
    }

    private func applyLayoutState() {
        let state = controller.currentLocalState
        let sidebar = controller.sidebarView
        sidebar.isHidden = !state.sidebarVisible
        sidebarDivider.isHidden = !state.sidebarVisible
        replaceSidebarWidth(state.sidebarVisible
            ? sidebar.widthAnchor.constraint(equalTo: widthAnchor, multiplier: state.sidebarFraction)
            : sidebar.widthAnchor.constraint(equalToConstant: 0))
        sidebarDividerWidthConstraint?.constant = state.sidebarVisible ? Self.dividerThickness : 0

        terminalContainer.isHidden = !state.terminalVisible
        terminalDivider.isHidden = !state.terminalVisible
        terminalSessionController?.setPresented(state.terminalVisible)
        replaceTerminalHeight(state.terminalVisible
            ? terminalContainer.heightAnchor.constraint(
                equalTo: rightColumn.heightAnchor,
                multiplier: state.terminalFraction
            )
            : terminalContainer.heightAnchor.constraint(equalToConstant: 0))
        terminalDividerHeightConstraint?.constant = state.terminalVisible ? Self.dividerThickness : 0
    }

    private func resizeSidebar(by delta: CGFloat) {
        guard bounds.width > 0, controller.currentLocalState.sidebarVisible else { return }
        adjustSidebar(by: Double(delta / bounds.width))
    }

    private func resizeTerminal(by delta: CGFloat) {
        guard rightColumn.bounds.height > 0, controller.currentLocalState.terminalVisible else { return }
        adjustTerminal(by: Double(-delta / rightColumn.bounds.height))
    }

    private func adjustSidebar(by delta: Double) {
        var state = controller.currentLocalState
        state.setSidebarFraction(state.sidebarFraction + delta)
        controller.setPaneLayout(
            sidebarVisible: state.sidebarVisible,
            terminalVisible: state.terminalVisible,
            sidebarFraction: state.sidebarFraction,
            terminalFraction: state.terminalFraction
        )
        applyLayoutState()
    }

    private func adjustTerminal(by delta: Double) {
        var state = controller.currentLocalState
        state.setTerminalFraction(state.terminalFraction + delta)
        controller.setPaneLayout(
            sidebarVisible: state.sidebarVisible,
            terminalVisible: state.terminalVisible,
            sidebarFraction: state.sidebarFraction,
            terminalFraction: state.terminalFraction
        )
        applyLayoutState()
    }

    private func replaceSidebarWidth(_ constraint: NSLayoutConstraint) {
        sidebarWidthConstraint?.isActive = false
        sidebarWidthConstraint = constraint
        constraint.isActive = true
    }

    private func replaceTerminalHeight(_ constraint: NSLayoutConstraint) {
        terminalHeightConstraint?.isActive = false
        terminalHeightConstraint = constraint
        constraint.isActive = true
    }

    func workspaceIDEController(_ controller: WorkspaceIDEController, didSelectWorkspace id: String?) {
        let name = id.flatMap { controller.workspaceName(for: $0) }
        terminalSessionController.selectWorkspace(id: id, name: name)
    }

    func workspaceIDEController(_ controller: WorkspaceIDEController, handle intent: WorkspaceIDEPlatformIntent) {
        switch intent {
        case .setSidebarVisible, .setTerminalVisible:
            applyLayoutState()
        case .setZoomScale(let scale):
            terminalSessionController.setZoomScale(scale)
        case .addWorkspace, .removeWorkspace, .reorderWorkspaces, .assignDesktop, .setAutoAssignDesktop:
            break
        }
    }

}
