import AgentDeskWire
import UIKit
import WorkspaceEditorViewer
import WorkspaceKit

@MainActor
final class WorkspaceFileEditorView: UIView {
    private let browser: WorkspaceFilesBrowser
    private let header = UIStackView()
    private let titleLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    private let zoomOutButton = UIButton(type: .system)
    private let zoomInButton = UIButton(type: .system)
    private let modeButton = UIButton(type: .system)
    private let saveButton = UIButton(type: .system)
    private let webSurface = WorkspaceFileWebSurface()
    private let statusLabel = UILabel()
    private let emptyLabel = UILabel()

    private var previewedPath: String?
    private var latestEditedText: String?
    private var previewMode = WorkspaceFileMode.preview

    init(browser: WorkspaceFilesBrowser) {
        self.browser = browser
        super.init(frame: .zero)
        setUp()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func render(_ model: WorkspaceFilesBrowserModel) {
        guard let preview = model.preview else {
            header.isHidden = true
            webSurface.view.isHidden = true
            statusLabel.isHidden = true
            emptyLabel.isHidden = false
            previewedPath = nil
            latestEditedText = nil
            return
        }

        header.isHidden = false
        emptyLabel.isHidden = true
        titleLabel.text = (preview.path as NSString).lastPathComponent
        switch preview {
        case .loading:
            webSurface.view.isHidden = true
            saveButton.isHidden = true
            modeButton.isHidden = true
            updateZoomButtons(for: nil)
            statusLabel.text = "Loading…"
            statusLabel.isHidden = false
            previewedPath = nil
        case .loaded(let path, let content, _):
            webSurface.view.isHidden = false
            let kind = WorkspaceFileKind(path: path)
            saveButton.isHidden = kind.isReadOnly
            if previewedPath != path {
                previewedPath = path
                latestEditedText = nil
                previewMode = Self.defaultMode(for: kind)
                webSurface.render(payload(path: path, content: content, mode: previewMode))
            }
            updateModeButton(for: kind)
            updateZoomButtons(for: kind)
            renderSaveStatus(model.saveStatus)
        case .failed(_, let message):
            webSurface.view.isHidden = true
            saveButton.isHidden = true
            modeButton.isHidden = true
            updateZoomButtons(for: nil)
            statusLabel.text = message
            statusLabel.isHidden = false
            previewedPath = nil
        }
    }

    private func setUp() {
        backgroundColor = .systemBackground
        accessibilityIdentifier = "workspace-file-editor"

        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.accessibilityLabel = "Close file"
        closeButton.accessibilityIdentifier = "workspace-preview-close"
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        zoomOutButton.setImage(UIImage(systemName: "minus.magnifyingglass"), for: .normal)
        zoomOutButton.accessibilityLabel = "Zoom Out"
        zoomOutButton.accessibilityIdentifier = "workspace-preview-zoom-out"
        zoomOutButton.addTarget(self, action: #selector(zoomOutTapped), for: .touchUpInside)

        zoomInButton.setImage(UIImage(systemName: "plus.magnifyingglass"), for: .normal)
        zoomInButton.accessibilityLabel = "Zoom In"
        zoomInButton.accessibilityIdentifier = "workspace-preview-zoom-in"
        zoomInButton.addTarget(self, action: #selector(zoomInTapped), for: .touchUpInside)

        modeButton.accessibilityIdentifier = "workspace-preview-mode"
        modeButton.addTarget(self, action: #selector(toggleModeTapped), for: .touchUpInside)

        saveButton.setTitle("Save", for: .normal)
        saveButton.accessibilityIdentifier = "workspace-preview-save"
        saveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.lineBreakMode = .byTruncatingHead
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        emptyLabel.text = "Open a file from the sidebar."
        emptyLabel.font = .preferredFont(forTextStyle: .body)
        emptyLabel.textColor = .secondaryLabel
        emptyLabel.textAlignment = .center
        emptyLabel.numberOfLines = 0
        emptyLabel.accessibilityIdentifier = "workspace-editor-empty"

        webSurface.view.accessibilityIdentifier = "workspace-preview-text"
        webSurface.onDirty = { [weak self] _, text in self?.latestEditedText = text }

        header.addArrangedSubview(titleLabel)
        header.addArrangedSubview(zoomOutButton)
        header.addArrangedSubview(zoomInButton)
        header.addArrangedSubview(modeButton)
        header.addArrangedSubview(saveButton)
        header.addArrangedSubview(closeButton)
        header.axis = .horizontal
        header.spacing = 8
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, statusLabel, webSurface.view])
        stack.axis = .vertical
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(emptyLabel)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            emptyLabel.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor),
            emptyLabel.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor),
            emptyLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    private func payload(
        path: String,
        content: WorkspaceFileReadContent,
        mode: WorkspaceFileMode
    ) -> WorkspaceFilePayload {
        let kind = WorkspaceFileKind(path: path)
        let viewerContent: WorkspaceFileContent
        switch content {
        case .text(let text): viewerContent = .text(text)
        case .document(let data): viewerContent = .documentData(data)
        }
        let workspace = browser.model.workspaces.first {
            $0.id == browser.model.selectedWorkspaceID
        }?.name ?? ""
        return WorkspaceFilePayload(
            id: path,
            name: (path as NSString).lastPathComponent,
            path: path,
            workspace: workspace,
            root: "",
            content: viewerContent,
            kind: kind,
            mode: mode
        )
    }

    private static func defaultMode(for kind: WorkspaceFileKind) -> WorkspaceFileMode {
        switch kind {
        case .docx, .markdown, .notebook: .preview
        default: .edit
        }
    }

    private func updateModeButton(for kind: WorkspaceFileKind) {
        modeButton.isHidden = kind.isReadOnly
        modeButton.setTitle(previewMode == .edit ? "Preview" : "Edit", for: .normal)
    }

    private func updateZoomButtons(for kind: WorkspaceFileKind?) {
        let hasOpenFile = kind != nil
        zoomOutButton.isHidden = !hasOpenFile
        zoomInButton.isHidden = !hasOpenFile
    }

    private func renderSaveStatus(_ saveStatus: WorkspaceFilesBrowserModel.SaveStatus) {
        switch saveStatus {
        case .idle:
            statusLabel.isHidden = true
            saveButton.isEnabled = true
        case .saving:
            statusLabel.text = "Saving…"
            statusLabel.isHidden = false
            saveButton.isEnabled = false
        case .conflict:
            statusLabel.text = "This file changed on the host. Your edits were not saved."
            statusLabel.isHidden = false
            saveButton.isEnabled = true
        case .failed(let message):
            statusLabel.text = message
            statusLabel.isHidden = false
            saveButton.isEnabled = true
        }
    }

    @objc private func closeTapped() { browser.closePreview() }
    @objc private func zoomOutTapped() { webSurface.zoomOut() }
    @objc private func zoomInTapped() { webSurface.zoomIn() }

    @objc private func toggleModeTapped() {
        guard case .loaded(let path, .text(let baseline), _)? = browser.model.preview else { return }
        previewMode = previewMode == .edit ? .preview : .edit
        webSurface.render(payload(
            path: path,
            content: .text(latestEditedText ?? baseline),
            mode: previewMode
        ))
        updateModeButton(for: WorkspaceFileKind(path: path))
    }

    @objc private func saveTapped() {
        let text: String
        if let latestEditedText {
            text = latestEditedText
        } else if case .loaded(_, .text(let loaded), _)? = browser.model.preview {
            text = loaded
        } else {
            return
        }
        Task { await browser.saveFile(text) }
    }
}
