@MainActor
final class AgentSessionTerminalEndpointRegistry<Key: Hashable> {
    struct Binding: Equatable {
        fileprivate let epoch: UInt64
    }

    typealias Factory = @MainActor (Key, UInt64) -> AgentSessionTerminalEndpoint

    private struct PendingShutdown {
        let epoch: UInt64
        let task: Task<Void, Never>
    }

    private let factory: Factory
    private var nextEpoch: UInt64 = 0
    private var bindingEpochs: [Key: UInt64] = [:]
    private var endpoints: [Key: AgentSessionTerminalEndpoint] = [:]
    private var pendingShutdowns: [Key: PendingShutdown] = [:]

    init(factory: @escaping Factory) {
        self.factory = factory
    }

    var activeEndpoints: [AgentSessionTerminalEndpoint] {
        Array(endpoints.values)
    }

    func beginBinding(for key: Key) -> Binding {
        let epoch = makeEpoch()
        bindingEpochs[key] = epoch
        return Binding(epoch: epoch)
    }

    func endpoint(for key: Key, binding: Binding) async -> AgentSessionTerminalEndpoint? {
        while let pending = pendingShutdowns[key] {
            await pending.task.value
            clearPendingShutdown(for: key, epoch: pending.epoch)
        }

        guard bindingEpochs[key] == binding.epoch else { return nil }
        if let endpoint = endpoints[key] {
            return endpoint
        }

        let endpoint = factory(key, makeEpoch())
        endpoints[key] = endpoint
        return endpoint
    }

    func endBinding(for key: Key) {
        bindingEpochs.removeValue(forKey: key)
        guard let endpoint = endpoints.removeValue(forKey: key) else { return }

        let epoch = makeEpoch()
        let task = Task {
            await endpoint.shutdown()
        }
        pendingShutdowns[key] = PendingShutdown(epoch: epoch, task: task)
        Task { @MainActor [weak self] in
            await task.value
            self?.clearPendingShutdown(for: key, epoch: epoch)
        }
    }

    private func clearPendingShutdown(for key: Key, epoch: UInt64) {
        guard pendingShutdowns[key]?.epoch == epoch else { return }
        pendingShutdowns.removeValue(forKey: key)
    }

    private func makeEpoch() -> UInt64 {
        nextEpoch &+= 1
        return nextEpoch
    }
}
