import AgentDeskWire
import UIKit

@MainActor
final class WorkspaceFilesExplorerView: UIView {
    private let browser: WorkspaceFilesBrowser
    private let upButton = UIButton(type: .system)
    private let pathLabel = UILabel()
    private let statusLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .plain)

    init(browser: WorkspaceFilesBrowser) {
        self.browser = browser
        super.init(frame: .zero)
        setUp()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func render(_ model: WorkspaceFilesBrowserModel) {
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
            statusLabel.text = model.entries.isEmpty ? "This folder is empty." : nil
            statusLabel.isHidden = !model.entries.isEmpty
        case .failed(let message):
            statusLabel.text = message
            statusLabel.isHidden = false
        }
        tableView.reloadData()
    }

    private func setUp() {
        backgroundColor = .secondarySystemBackground
        accessibilityIdentifier = "workspace-files-sidebar"

        upButton.setImage(UIImage(systemName: "chevron.up"), for: .normal)
        upButton.accessibilityLabel = "Parent folder"
        upButton.accessibilityIdentifier = "workspace-files-up"
        upButton.addTarget(self, action: #selector(navigateUpTapped), for: .touchUpInside)

        pathLabel.font = .preferredFont(forTextStyle: .subheadline)
        pathLabel.textColor = .secondaryLabel
        pathLabel.adjustsFontForContentSizeCategory = true
        pathLabel.lineBreakMode = .byTruncatingHead

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        let header = UIStackView(arrangedSubviews: [upButton, pathLabel])
        header.axis = .horizontal
        header.spacing = 8
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, statusLabel, tableView])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "entry")
        tableView.accessibilityIdentifier = "workspace-files-table"
    }

    @objc private func navigateUpTapped() {
        Task { await browser.navigateUp() }
    }
}

extension WorkspaceFilesExplorerView: UITableViewDataSource, UITableViewDelegate {
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
