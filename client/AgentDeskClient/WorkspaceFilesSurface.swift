import UIKit
import AgentDeskWire
import WorkspaceEditorViewer

/// The iOS Files surface (R28): renders a `WorkspaceFilesBrowser`'s navigation state — a breadcrumb
/// with an up control and a table of directory entries — and forwards taps back to the browser.
/// Directory taps descend; file taps open the in-surface editor overlay (read plus revision-checked
/// save). The view is a thin renderer: all navigation state and transport orchestration live in the
/// browser.
@MainActor
final class WorkspaceFilesSurface: UIView {
    private let browser: WorkspaceFilesBrowser
    /// The workspace picker: shows the selected workspace's name and presents the full list as a menu
    /// so the user can switch among all workspaces (R38). Replaces the old static title, which showed
    /// only the auto-selected first workspace and gave no way to see or reach the others.
    private let workspacePickerButton = UIButton(type: .system)
    private let upButton = UIButton(type: .system)
    private let pathLabel = UILabel()
    private let statusLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .plain)

    // File viewer overlay, shown over the list when a file opens. Renders through the SHARED web
    // surface (Phase G) — the same CodeMirror + markdown-it + mermaid SPA the macOS shell uses — so
    // markdown/mermaid/code render identically on both platforms instead of raw text.
    private let previewContainer = UIView()
    private let previewTitleLabel = UILabel()
    private let previewCloseButton = UIButton(type: .system)
    private let previewSaveButton = UIButton(type: .system)
    private let webSurface = WorkspaceFileWebSurface()
    private let previewStatusLabel = UILabel()
    /// The path whose baseline text is currently rendered, so re-renders don't reload while editing.
    private var previewedPath: String?
    /// The latest text the SPA reported via onDirty, written back on Save.
    private var latestEditedText: String?

    init(browser: WorkspaceFilesBrowser) {
        self.browser = browser
        super.init(frame: .zero)
        setUp()
        browser.onChange = { [weak self] in self?.render() }
        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func setUp() {
        backgroundColor = .systemBackground

        var pickerConfig = UIButton.Configuration.plain()
        pickerConfig.image = UIImage(systemName: "chevron.down")
        pickerConfig.imagePlacement = .trailing
        pickerConfig.imagePadding = 4
        pickerConfig.contentInsets = .zero
        workspacePickerButton.configuration = pickerConfig
        workspacePickerButton.contentHorizontalAlignment = .leading
        workspacePickerButton.accessibilityIdentifier = "workspace-files-picker"
        // The menu is rebuilt on every render() from the current workspace list; a primary-action
        // menu means one tap opens the picker.
        workspacePickerButton.showsMenuAsPrimaryAction = true

        upButton.setImage(UIImage(systemName: "chevron.up"), for: .normal)
        upButton.accessibilityIdentifier = "workspace-files-up"
        upButton.addTarget(self, action: #selector(navigateUpTapped), for: .touchUpInside)

        pathLabel.font = .preferredFont(forTextStyle: .subheadline)
        pathLabel.textColor = .secondaryLabel
        pathLabel.adjustsFontForContentSizeCategory = true

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        let header = UIStackView(arrangedSubviews: [upButton, workspacePickerButton])
        header.axis = .horizontal
        header.spacing = 8
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, pathLabel, statusLabel, tableView])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor),
        ])

        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "entry")
        tableView.accessibilityIdentifier = "workspace-files-table"

        setUpPreviewOverlay()
    }

    private func setUpPreviewOverlay() {
        previewContainer.backgroundColor = .systemBackground
        previewContainer.isHidden = true
        previewContainer.accessibilityIdentifier = "workspace-files-preview"

        previewCloseButton.setImage(UIImage(systemName: "chevron.backward"), for: .normal)
        previewCloseButton.accessibilityIdentifier = "workspace-files-preview-close"
        previewCloseButton.addTarget(self, action: #selector(closePreviewTapped), for: .touchUpInside)

        previewSaveButton.setTitle("Save", for: .normal)
        previewSaveButton.accessibilityIdentifier = "workspace-files-preview-save"
        previewSaveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)

        previewTitleLabel.font = .preferredFont(forTextStyle: .headline)
        previewTitleLabel.adjustsFontForContentSizeCategory = true
        previewTitleLabel.lineBreakMode = .byTruncatingHead

        previewStatusLabel.font = .preferredFont(forTextStyle: .footnote)
        previewStatusLabel.textColor = .secondaryLabel
        previewStatusLabel.textAlignment = .center
        previewStatusLabel.numberOfLines = 0

        // The shared web surface renders the file (markdown/mermaid/code) and reports edits via
        // onDirty so Save can write them back revision-checked over the .files lane.
        webSurface.view.accessibilityIdentifier = "workspace-files-preview-text"
        webSurface.onDirty = { [weak self] _, text in self?.latestEditedText = text }

        let header = UIStackView(arrangedSubviews: [previewCloseButton, previewTitleLabel, previewSaveButton])
        header.axis = .horizontal
        header.spacing = 8
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, previewStatusLabel, webSurface.view])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        previewContainer.addSubview(stack)
        previewContainer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(previewContainer)
        NSLayoutConstraint.activate([
            previewContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
            previewContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            previewContainer.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor),
            previewContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: previewContainer.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: previewContainer.layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: previewContainer.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: previewContainer.safeAreaLayoutGuide.bottomAnchor),
        ])
    }

    private func render() {
        let model = browser.model
        updateWorkspacePicker(model)
        upButton.isEnabled = model.canNavigateUp
        pathLabel.text = model.path.isEmpty ? "/" : "/" + model.path
        switch model.status {
        case .idle:
            statusLabel.text = "Select a workspace to browse its files."
            statusLabel.isHidden = false
        case .loading:
            statusLabel.text = "Loading…"
            statusLabel.isHidden = false
        case .loaded:
            statusLabel.isHidden = !model.entries.isEmpty ? true : false
            statusLabel.text = model.entries.isEmpty ? "This folder is empty." : nil
        case .failed(let message):
            statusLabel.text = message
            statusLabel.isHidden = false
        }
        tableView.reloadData()
        renderPreview(model.preview, saveStatus: model.saveStatus)
    }

    /// Rebuilds the workspace picker from the current model: the button title is the selected
    /// workspace (or a prompt when none is chosen yet), and the menu lists every workspace with the
    /// selected one checked. Selecting one drives the browser, which resets navigation to that
    /// workspace's root. Disabled until the workspace list has loaded.
    private func updateWorkspacePicker(_ model: WorkspaceFilesBrowserModel) {
        let selectedName = model.workspaces.first { $0.id == model.selectedWorkspaceID }?.name
        workspacePickerButton.configuration?.title =
            selectedName ?? (model.workspaces.isEmpty ? "Files" : "Select workspace")
        workspacePickerButton.isEnabled = !model.workspaces.isEmpty
        let actions = model.workspaces.map { workspace in
            UIAction(
                title: workspace.name,
                state: workspace.id == model.selectedWorkspaceID ? .on : .off
            ) { [weak self] _ in
                Task { await self?.browser.selectWorkspace(workspace.id) }
            }
        }
        workspacePickerButton.menu = UIMenu(title: "Workspaces", children: actions)
    }

    private func renderPreview(
        _ preview: WorkspaceFilesBrowserModel.Preview?,
        saveStatus: WorkspaceFilesBrowserModel.SaveStatus
    ) {
        guard let preview else {
            previewContainer.isHidden = true
            previewedPath = nil
            latestEditedText = nil
            return
        }
        previewContainer.isHidden = false
        previewTitleLabel.text = (preview.path as NSString).lastPathComponent
        switch preview {
        case .loading:
            previewSaveButton.isHidden = true
            previewStatusLabel.text = "Loading…"
            previewStatusLabel.isHidden = false
            previewedPath = nil
        case .loaded(let path, let text, _):
            previewSaveButton.isHidden = false
            // Render the baseline into the web surface only when the file changes, so re-renders
            // while the user edits (or a save/conflict result) never reload and clobber edits.
            if previewedPath != path {
                previewedPath = path
                latestEditedText = nil
                webSurface.render(payload(path: path, text: text))
            }
            renderSaveStatus(saveStatus)
        case .failed(_, let message):
            previewSaveButton.isHidden = true
            previewStatusLabel.text = message
            previewStatusLabel.isHidden = false
            previewedPath = nil
        }
    }

    private func payload(path: String, text: String) -> WorkspaceFilePayload {
        let kind = Self.webKind(forPath: path)
        let workspace = browser.model.workspaces.first { $0.id == browser.model.selectedWorkspaceID }?.name ?? ""
        return WorkspaceFilePayload(
            id: path, name: (path as NSString).lastPathComponent, path: path,
            workspace: workspace, root: "", text: text, kind: kind,
            // Markdown/HTML open rendered; code/text open in the editor.
            mode: (kind == "markdown" || kind == "html") ? "preview" : "edit"
        )
    }

    private static func webKind(forPath path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "md", "markdown": "markdown"
        case "html", "htm": "html"
        case "ipynb": "notebook"
        default: "text"
        }
    }

    private func renderSaveStatus(_ saveStatus: WorkspaceFilesBrowserModel.SaveStatus) {
        switch saveStatus {
        case .idle:
            previewStatusLabel.isHidden = true
            previewSaveButton.isEnabled = true
        case .saving:
            previewStatusLabel.text = "Saving…"
            previewStatusLabel.isHidden = false
            previewSaveButton.isEnabled = false
        case .conflict:
            previewStatusLabel.text = "This file changed on the host. Your edits were not saved."
            previewStatusLabel.isHidden = false
            previewSaveButton.isEnabled = true
        case .failed(let message):
            previewStatusLabel.text = message
            previewStatusLabel.isHidden = false
            previewSaveButton.isEnabled = true
        }
    }

    @objc private func navigateUpTapped() {
        Task { await browser.navigateUp() }
    }

    @objc private func closePreviewTapped() {
        browser.closePreview()
    }

    @objc private func saveTapped() {
        // Prefer the SPA's latest edited text; fall back to the loaded baseline if untouched.
        let text: String
        if let latestEditedText {
            text = latestEditedText
        } else if case .loaded(_, let loaded, _)? = browser.model.preview {
            text = loaded
        } else {
            return
        }
        Task { await browser.saveFile(text) }
    }

    /// Drops the model binding so a torn-down surface stops rendering. The owning controller closes
    /// the transport and removes the view; this just severs the callback.
    func teardown() {
        browser.onChange = nil
    }
}

extension WorkspaceFilesSurface: UITableViewDataSource, UITableViewDelegate {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        browser.model.entries.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "entry", for: indexPath)
        let entry = browser.model.entries[indexPath.row]
        var content = cell.defaultContentConfiguration()
        content.text = entry.name
        content.image = UIImage(systemName: entry.isDirectory ? "folder" : "doc.text")
        cell.contentConfiguration = content
        cell.accessoryType = entry.isDirectory ? .disclosureIndicator : .none
        cell.accessibilityIdentifier = "workspace-files-entry-\(entry.name)"
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let entry = browser.model.entries[indexPath.row]
        if entry.isDirectory {
            Task { await browser.enter(entry) }
        } else {
            Task { await browser.openFile(entry) }
        }
    }
}
