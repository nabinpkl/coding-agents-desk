import UIKit

@MainActor
final class WorkspaceWorkbenchSurface: UIView {
    private static let dividerThickness: CGFloat = 44
    private static let resizeStep = 0.05

    private let browser: WorkspaceFilesBrowser
    private let stateStore: WorkspaceWorkbenchStateStoring
    private let explorer: WorkspaceFilesExplorerView
    private let editor: WorkspaceFileEditorView
    private let topBar = UIStackView()
    private let sidebarButton = UIButton(type: .system)
    private let workspacePickerButton = UIButton(type: .system)
    private let terminalButton = UIButton(type: .system)
    private let sidebarDivider = WorkspaceWorkbenchDivider(
        axis: .vertical,
        accessibilityLabel: "Resize workspace sidebar"
    )
    private let terminalDivider = WorkspaceWorkbenchDivider(
        axis: .horizontal,
        accessibilityLabel: "Resize workspace terminal"
    )
    private let rightColumn = UIView()
    private let terminalContainer = UIView()
    private var terminalSessionController: WorkspaceTerminalSessionController!

    private var workspaceID: String?
    private var state = WorkspaceWorkbenchState()
    private var explorerWidthConstraint: NSLayoutConstraint?
    private var sidebarDividerWidthConstraint: NSLayoutConstraint?
    private var terminalHeightConstraint: NSLayoutConstraint?
    private var terminalDividerHeightConstraint: NSLayoutConstraint?

    init(
        browser: WorkspaceFilesBrowser,
        stateStore: WorkspaceWorkbenchStateStoring = WorkspaceWorkbenchStateStore.shared,
        terminalCoordinator: (any WorkspaceTerminalCoordinating)? = nil,
        terminalSessionOpener: (any WorkspaceTerminalSessionOpening)? = nil
    ) {
        self.browser = browser
        self.stateStore = stateStore
        self.explorer = WorkspaceFilesExplorerView(browser: browser)
        self.editor = WorkspaceFileEditorView(browser: browser)
        super.init(frame: .zero)
        setUp()
        terminalSessionController = WorkspaceTerminalSessionController(
            container: terminalContainer,
            coordinator: terminalCoordinator,
            sessionOpener: terminalSessionOpener,
            stateStore: stateStore
        )
        browser.onChange = { [weak self] in self?.render() }
        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func teardown() {
        browser.onChange = nil
        terminalSessionController.teardown()
    }

    private func setUp() {
        backgroundColor = .systemBackground
        accessibilityIdentifier = "workspace-workbench"
        setUpToolbar()

        [explorer, sidebarDivider, rightColumn].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            addSubview($0)
        }
        [editor, terminalDivider, terminalContainer].forEach {
            $0.translatesAutoresizingMaskIntoConstraints = false
            rightColumn.addSubview($0)
        }

        terminalContainer.backgroundColor = .black
        terminalContainer.accessibilityIdentifier = "workspace-terminal"

        explorerWidthConstraint = explorer.widthAnchor.constraint(
            equalTo: widthAnchor,
            multiplier: state.sidebarFraction
        )
        sidebarDividerWidthConstraint = sidebarDivider.widthAnchor.constraint(
            equalToConstant: Self.dividerThickness
        )
        terminalHeightConstraint = terminalContainer.heightAnchor.constraint(
            equalTo: rightColumn.heightAnchor,
            multiplier: state.terminalFraction
        )
        terminalDividerHeightConstraint = terminalDivider.heightAnchor.constraint(
            equalToConstant: Self.dividerThickness
        )

        NSLayoutConstraint.activate([
            explorer.leadingAnchor.constraint(equalTo: leadingAnchor),
            explorer.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            explorer.bottomAnchor.constraint(equalTo: bottomAnchor),
            explorerWidthConstraint!,

            sidebarDivider.leadingAnchor.constraint(equalTo: explorer.trailingAnchor),
            sidebarDivider.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            sidebarDivider.bottomAnchor.constraint(equalTo: bottomAnchor),
            sidebarDividerWidthConstraint!,

            rightColumn.leadingAnchor.constraint(equalTo: sidebarDivider.trailingAnchor),
            rightColumn.trailingAnchor.constraint(equalTo: trailingAnchor),
            rightColumn.topAnchor.constraint(equalTo: topBar.bottomAnchor),
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

    private func setUpToolbar() {
        sidebarButton.setImage(UIImage(systemName: "sidebar.left"), for: .normal)
        sidebarButton.accessibilityLabel = "Toggle workspace sidebar"
        sidebarButton.accessibilityIdentifier = "workspace-sidebar-toggle"
        sidebarButton.addTarget(self, action: #selector(toggleSidebarTapped), for: .touchUpInside)

        var pickerConfig = UIButton.Configuration.plain()
        pickerConfig.image = UIImage(systemName: "chevron.down")
        pickerConfig.imagePlacement = .trailing
        pickerConfig.imagePadding = 4
        pickerConfig.contentInsets = .zero
        workspacePickerButton.configuration = pickerConfig
        workspacePickerButton.contentHorizontalAlignment = .leading
        workspacePickerButton.accessibilityIdentifier = "workspace-picker"
        workspacePickerButton.showsMenuAsPrimaryAction = true
        workspacePickerButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        terminalButton.setImage(UIImage(systemName: "terminal"), for: .normal)
        terminalButton.accessibilityLabel = "Toggle workspace terminal"
        terminalButton.accessibilityIdentifier = "workspace-terminal-toggle"
        terminalButton.addTarget(self, action: #selector(toggleTerminalTapped), for: .touchUpInside)

        topBar.addArrangedSubview(sidebarButton)
        topBar.addArrangedSubview(workspacePickerButton)
        topBar.addArrangedSubview(UIView())
        topBar.addArrangedSubview(terminalButton)
        topBar.axis = .horizontal
        topBar.alignment = .center
        topBar.spacing = 12
        topBar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(topBar)
        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 44),
        ])
    }

    private func render() {
        let model = browser.model
        if workspaceID != model.selectedWorkspaceID {
            workspaceID = model.selectedWorkspaceID
            state = model.selectedWorkspaceID.map(stateStore.state(for:))
                ?? WorkspaceWorkbenchState()
            applyLayoutState()
        }
        updateWorkspacePicker(model)
        explorer.render(model)
        editor.render(model)
        let selectedName = model.workspaces.first { $0.id == model.selectedWorkspaceID }?.name
        terminalSessionController.selectWorkspace(id: model.selectedWorkspaceID, name: selectedName)
    }

    private func updateWorkspacePicker(_ model: WorkspaceFilesBrowserModel) {
        let selectedName = model.workspaces.first { $0.id == model.selectedWorkspaceID }?.name
        workspacePickerButton.configuration?.title =
            selectedName ?? (model.workspaces.isEmpty ? "Workspace" : "Select workspace")
        workspacePickerButton.isEnabled = !model.workspaces.isEmpty
        workspacePickerButton.menu = UIMenu(
            title: "Workspaces",
            children: model.workspaces.map { workspace in
                UIAction(
                    title: workspace.name,
                    state: workspace.id == model.selectedWorkspaceID ? .on : .off
                ) { [weak self] _ in
                    Task { await self?.browser.selectWorkspace(workspace.id) }
                }
            }
        )
    }

    private func applyLayoutState() {
        explorer.isHidden = !state.sidebarVisible
        sidebarDivider.isHidden = !state.sidebarVisible
        replaceExplorerWidthConstraint(
            state.sidebarVisible
                ? explorer.widthAnchor.constraint(equalTo: widthAnchor, multiplier: state.sidebarFraction)
                : explorer.widthAnchor.constraint(equalToConstant: 0)
        )
        sidebarDividerWidthConstraint?.constant = state.sidebarVisible ? Self.dividerThickness : 0

        terminalContainer.isHidden = !state.terminalVisible
        terminalDivider.isHidden = !state.terminalVisible
        terminalSessionController?.setPresented(state.terminalVisible)
        replaceTerminalHeightConstraint(
            state.terminalVisible
                ? terminalContainer.heightAnchor.constraint(
                    equalTo: rightColumn.heightAnchor,
                    multiplier: state.terminalFraction
                )
                : terminalContainer.heightAnchor.constraint(equalToConstant: 0)
        )
        terminalDividerHeightConstraint?.constant = state.terminalVisible ? Self.dividerThickness : 0
        sidebarButton.tintColor = state.sidebarVisible ? .systemBlue : .secondaryLabel
        terminalButton.tintColor = state.terminalVisible ? .systemBlue : .secondaryLabel
    }

    private func replaceExplorerWidthConstraint(_ constraint: NSLayoutConstraint) {
        explorerWidthConstraint?.isActive = false
        explorerWidthConstraint = constraint
        explorerWidthConstraint?.isActive = true
    }

    private func replaceTerminalHeightConstraint(_ constraint: NSLayoutConstraint) {
        terminalHeightConstraint?.isActive = false
        terminalHeightConstraint = constraint
        terminalHeightConstraint?.isActive = true
    }

    private func resizeSidebar(by delta: CGFloat) {
        guard state.sidebarVisible, bounds.width > 0 else { return }
        adjustSidebar(by: Double(delta / bounds.width))
    }

    private func resizeTerminal(by delta: CGFloat) {
        guard state.terminalVisible, rightColumn.bounds.height > 0 else { return }
        adjustTerminal(by: Double(-delta / rightColumn.bounds.height))
    }

    private func adjustSidebar(by delta: Double) {
        state.setSidebarFraction(state.sidebarFraction + delta)
        replaceExplorerWidthConstraint(explorer.widthAnchor.constraint(
            equalTo: widthAnchor,
            multiplier: state.sidebarFraction
        ))
        persistState()
    }

    private func adjustTerminal(by delta: Double) {
        state.setTerminalFraction(state.terminalFraction + delta)
        replaceTerminalHeightConstraint(terminalContainer.heightAnchor.constraint(
            equalTo: rightColumn.heightAnchor,
            multiplier: state.terminalFraction
        ))
        persistState()
    }

    private func persistState() {
        guard let workspaceID else { return }
        stateStore.setState(state, for: workspaceID)
    }

    @objc private func toggleSidebarTapped() {
        state.sidebarVisible.toggle()
        applyLayoutState()
        persistState()
    }

    @objc private func toggleTerminalTapped() {
        state.terminalVisible.toggle()
        applyLayoutState()
        persistState()
    }
}
