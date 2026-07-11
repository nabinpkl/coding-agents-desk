import Foundation

extension FileViewer {
    func payload(for tab: FileTab) -> FileEditorSurface.Payload {
        FileEditorSurface.Payload(
            id: tab.url.path,
            name: tab.url.lastPathComponent,
            path: displayPath(for: tab.url),
            workspace: workspace?.name ?? "",
            root: workspace?.root.path ?? "",
            text: tab.text,
            kind: tab.kind ?? .text,
            mode: tab.mode
        )
    }

    func renderEditorSurfaceIfActive(for tab: FileTab) {
        guard tab.identity == activeID else { return }
        reusableEditorSurface?.render(payload(for: tab))
    }

    func applyNotebookRunEventIfActive(_ event: NotebookRunEvent, to tab: FileTab) {
        guard tab.identity == activeID else { return }
        reusableEditorSurface?.applyNotebookRunEvent(event)
    }

    func editorSurface() -> FileEditorSurface {
        if let surface = reusableEditorSurface { return surface }
        let surface = FileEditorSurface(viewerRoot: viewerRoot)
        surface.setTextZoom(textZoom)
        surface.onDirty = { [weak self] url, text in self?.markDirty(url, text: text) }
        surface.onEditRequest = { [weak self] url in self?.setMode(.edit, for: url) }
        // Notebook cell execution is out of scope for the AgentDesk port; the runtime hook is left
        // unwired (notebooks still render read-only through the SPA).
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
