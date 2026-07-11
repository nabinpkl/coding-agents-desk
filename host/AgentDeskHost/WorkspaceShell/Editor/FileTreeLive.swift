import Foundation

/// Keeps the sidebar file pane live for the active workspace: roots the tree, watches the
/// folder for changes, and reads git status — so editing, adding, or removing files (in a
/// terminal, an editor, anywhere) reflects in the tree and its decorations without a manual
/// refresh. The coordinator that holds the I/O (FSEvents + `git`) so `FilePane` stays a
/// renderer and `AppDelegate` stays wiring. Main-thread only.
@MainActor
public final class FileTreeLive {
    private let filePane: FilePane
    private let reader: GitStatusReader
    private lazy var watch = FolderWatch { [weak self] in self?.onFolderChanged() }
    private var root: URL?

    /// Fired with each git-status read (initial + every refresh) for the active workspace,
    /// so other consumers (the Source Control panel) reflect the same status the tree does.
    public var onGitStatus: ((GitStatus, URL) -> Void)?

    /// Fired on every folder change (the raw FSEvents signal, after the tree + git refresh),
    /// so the open-file viewer can reconcile its tabs with disk off the same single watcher.
    public var onChange: (() -> Void)?

    public init(filePane: FilePane, reader: GitStatusReader = GitStatusReader()) {
        self.filePane = filePane
        self.reader = reader
    }

    /// Show `root` in the pane, start watching it, and kick the first git read.
    public func show(root: URL) {
        self.root = root
        filePane.show(root: FileNode(url: root, isDirectory: true))
        watch.start(root: root)
        readGitStatus()
    }

    /// Stop watching and clear the pane (no workspace open).
    public func clear() {
        root = nil
        watch.stop()
        filePane.clear()
    }

    /// A filesystem change: reconcile the tree (new/removed files) and re-read git status.
    private func onFolderChanged() {
        filePane.refreshPreservingState()
        readGitStatus()
        onChange?()
    }

    /// Read git status off the main thread (porcelain can take a beat on a big repo) and
    /// overlay it, dropping the result if the workspace changed while it ran.
    private func readGitStatus() {
        guard let root else { return }
        // Read git porcelain off the main actor (it can take a beat on a big repo). The reader is
        // Sendable and the result GitStatus is Sendable, so only those cross the actor boundary; the
        // MainActor Task re-checks the workspace hasn't changed before applying.
        let reader = self.reader
        Task { [weak self] in
            let status = await Task.detached(priority: .userInitiated) {
                reader.read(workspaceRoot: root)
            }.value
            guard let self, self.root == root else { return }
            self.filePane.applyGitStatus(status)
            self.onGitStatus?(status, root)
        }
    }
}
