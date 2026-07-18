import Foundation

@MainActor
final class AgentWindowApplicationLifecycle {
    private var stopTask: Task<Void, Never>?

    @discardableResult
    func beginStop(
        _ begin: @MainActor () -> Task<Void, Never>
    ) -> Task<Void, Never> {
        if let stopTask { return stopTask }
        let task = begin()
        stopTask = task
        return task
    }
}
