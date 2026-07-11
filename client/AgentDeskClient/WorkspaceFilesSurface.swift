import UIKit
import AgentDeskWire

/// The iOS Files surface (R28): renders a `WorkspaceFilesBrowser`'s navigation state — a breadcrumb
/// with an up control and a table of directory entries — and forwards taps back to the browser.
/// Directory taps descend; file taps are reported to `onSelectFile` for the preview surface. The
/// view is a thin renderer: all navigation state and transport orchestration live in the browser.
@MainActor
final class WorkspaceFilesSurface: UIView {
    private let browser: WorkspaceFilesBrowser
    private let titleLabel = UILabel()
    private let upButton = UIButton(type: .system)
    private let pathLabel = UILabel()
    private let statusLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .plain)

    /// Called when the user taps a file entry (not a directory), so a preview can be presented.
    var onSelectFile: ((WorkspaceDirectoryEntry) -> Void)?

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
    }

    @objc private func navigateUpTapped() {
        Task { await browser.navigateUp() }
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
            onSelectFile?(entry)
        }
    }
}
