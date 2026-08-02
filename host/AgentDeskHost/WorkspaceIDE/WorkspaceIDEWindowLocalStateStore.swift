import WorkspaceIDE

final class WorkspaceIDEWindowLocalStateStore: WorkspaceIDELocalStateStoring {
    private var state: WorkspaceIDELocalState
    var onSave: ((WorkspaceIDELocalState) -> Void)?

    init(state: WorkspaceIDELocalState) {
        self.state = state
    }

    func load() -> WorkspaceIDELocalState { state }

    func save(_ state: WorkspaceIDELocalState) {
        self.state = state
        onSave?(state)
    }
}
