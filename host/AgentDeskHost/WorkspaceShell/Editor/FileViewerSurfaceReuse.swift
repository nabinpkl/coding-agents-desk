import Foundation
import WorkspaceEditorViewer

extension FileViewer {
    func payload(for tab: FileTab) -> WorkspaceFilePayload {
        WorkspaceFilePayload(
            id: tab.url.path,
            name: tab.url.lastPathComponent,
            path: displayPath(for: tab.url),
            workspace: workspace?.name ?? "",
            root: workspace?.root.path ?? "",
            text: tab.text,
            kind: (tab.kind ?? .text).webName,
            mode: tab.mode.rawValue
        )
    }

    func renderEditorSurfaceIfActive(for tab: FileTab) {
        guard tab.identity == activeID else { return }
        reusableEditorSurface?.render(payload(for: tab))
    }

    func editorSurface() -> WorkspaceFileWebSurface {
        if let surface = reusableEditorSurface { return surface }
        let surface = WorkspaceFileWebSurface(viewerRoot: viewerRoot)
        surface.setTextZoom(textZoom.webTextZoom)
        surface.onDirty = { [weak self] url, text in self?.markDirty(url, text: text) }
        surface.onEditRequest = { [weak self] url in self?.setMode(.edit, for: url) }
        reusableEditorSurface = surface
        return surface
    }

    func htmlPreviewSurface() -> HTMLPreviewSurface {
        if let surface = reusableHTMLSurface { return surface }
        let surface = HTMLPreviewSurface()
        surface.onOpenFile = { [weak self] url in self?.onOpenFile?(url) }
        reusableHTMLSurface = surface
        return surface
    }
}

extension FilePreviewKind {
    /// The `kind` string the web SPA understands.
    var webName: String {
        switch self {
        case .html: "html"
        case .markdown: "markdown"
        case .notebook: "notebook"
        case .text: "text"
        }
    }
}

extension WorkspaceTextZoom {
    var webTextZoom: WorkspaceFileTextZoom {
        WorkspaceFileTextZoom(editorCodePointSize: editorCodePointSize, markdownPointSize: markdownPointSize)
    }
}
