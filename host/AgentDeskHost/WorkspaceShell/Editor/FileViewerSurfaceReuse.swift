import Foundation
import WorkspaceFileViewer

extension FileViewer {
    func payload(for tab: FileTab) -> WorkspaceFilePayload {
        let kind = tab.kind ?? .text
        let content: WorkspaceFileContent
        if kind == .docx {
            content = .documentFile(tab.documentURL ?? tab.url, maximumBytes: Config.workspaceDocumentMaxBytes)
        } else {
            content = .text(tab.text)
        }
        return WorkspaceFilePayload(
            id: tab.url.path,
            name: tab.url.lastPathComponent,
            path: displayPath(for: tab.url),
            workspace: workspace?.name ?? "",
            root: workspace?.root.path ?? "",
            content: content,
            kind: kind,
            mode: WorkspaceFileMode(rawValue: tab.mode.rawValue) ?? .preview
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

extension WorkspaceTextZoom {
    var webTextZoom: WorkspaceFileTextZoom {
        WorkspaceFileTextZoom(editorCodePointSize: editorCodePointSize, markdownPointSize: markdownPointSize)
    }
}
