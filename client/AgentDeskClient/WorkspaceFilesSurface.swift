import UIKit
import AgentDeskWire

/// The iOS Files surface (R28): renders a `WorkspaceFilesBrowser`'s navigation state — a breadcrumb
/// with an up control and a table of directory entries — and forwards taps back to the browser.
/// Directory taps descend; file taps open the in-surface read-only preview overlay. The view is a
/// thin renderer: all navigation state and transport orchestration live in the browser.
@MainActor
final class WorkspaceFilesSurface: UIView {
    private let browser: WorkspaceFilesBrowser
    private let titleLabel = UILabel()
    private let upButton = UIButton(type: .system)
    private let pathLabel = UILabel()
    private let statusLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .plain)

    // Read-only file preview overlay, shown over the list when a file is opened.
    private let previewContainer = UIView()
    private let previewTitleLabel = UILabel()
    private let previewCloseButton = UIButton(type: .system)
    private let previewSaveButton = UIButton(type: .system)
    private let previewTextView = UITextView()
    private let previewStatusLabel = UILabel()
    /// The path whose baseline text is currently loaded into the editor, so re-renders don't clobber
    /// in-progress edits.
    private var previewedPath: String?

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

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true

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

        let header = UIStackView(arrangedSubviews: [upButton, titleLabel])
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

        // Editable: R29 turns the preview into an editor. Text is written back revision-checked.
        previewTextView.isEditable = true
        previewTextView.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        previewTextView.accessibilityIdentifier = "workspace-files-preview-text"

        let header = UIStackView(arrangedSubviews: [previewCloseButton, previewTitleLabel, previewSaveButton])
        header.axis = .horizontal
        header.spacing = 8
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, previewStatusLabel, previewTextView])
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
        titleLabel.text = model.workspaces.first { $0.id == model.selectedWorkspaceID }?.name ?? "Files"
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

    private func renderPreview(
        _ preview: WorkspaceFilesBrowserModel.Preview?,
        saveStatus: WorkspaceFilesBrowserModel.SaveStatus
    ) {
        guard let preview else {
            previewContainer.isHidden = true
            previewTextView.text = nil
            previewedPath = nil
            return
        }
        previewContainer.isHidden = false
        previewTitleLabel.text = (preview.path as NSString).lastPathComponent
        switch preview {
        case .loading:
            previewSaveButton.isHidden = true
            previewTextView.isEditable = false
            previewStatusLabel.text = "Loading…"
            previewStatusLabel.isHidden = false
            previewTextView.text = nil
            previewedPath = nil
        case .loaded(let path, let text, _):
            previewSaveButton.isHidden = false
            previewTextView.isEditable = true
            // Only load the baseline text into the editor when the file changes, so re-renders while
            // the user types (or a save/conflict result) never clobber in-progress edits.
            if previewedPath != path {
                previewTextView.text = text
                previewedPath = path
            }
            renderSaveStatus(saveStatus)
        case .failed(_, let message):
            previewSaveButton.isHidden = true
            previewTextView.isEditable = false
            previewStatusLabel.text = message
            previewStatusLabel.isHidden = false
            previewTextView.text = nil
            previewedPath = nil
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
        let text = previewTextView.text ?? ""
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
