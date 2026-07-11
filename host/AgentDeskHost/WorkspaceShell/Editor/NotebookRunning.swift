import Foundation

public protocol NotebookRunning {
    func runCell(
        _ request: NotebookRunRequest,
        onEvent: @escaping (NotebookRunEvent) -> Void
    )

    func shutdown() async
}
