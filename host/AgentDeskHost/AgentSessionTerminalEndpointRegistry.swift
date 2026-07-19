@MainActor
final class TerminalEndpointRegistry<Key: Hashable, Endpoint> {
    struct Binding: Equatable {
        fileprivate let epoch: UInt64
    }

    typealias Factory = @MainActor (Key, UInt64) -> Endpoint

    private struct PendingShutdown {
        let epoch: UInt64
        let task: Task<Void, Never>
    }

    private let factory: Factory
    private let shutdownEndpoint: @MainActor (Endpoint) async -> Void
    private var nextEpoch: UInt64 = 0
    private var bindingEpochs: [Key: UInt64] = [:]
    private var endpoints: [Key: Endpoint] = [:]
    private var pendingShutdowns: [Key: PendingShutdown] = [:]

    init(
        factory: @escaping Factory,
        shutdown: @escaping @MainActor (Endpoint) async -> Void
    ) {
        self.factory = factory
        self.shutdownEndpoint = shutdown
    }

    var activeEndpoints: [Endpoint] {
        Array(endpoints.values)
    }

    func beginBinding(for key: Key) -> Binding {
        let epoch = makeEpoch()
        bindingEpochs[key] = epoch
        return Binding(epoch: epoch)
    }

    func endpoint(for key: Key, binding: Binding) async -> Endpoint? {
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
        let shutdownEndpoint = shutdownEndpoint
        let task = Task { @MainActor in
            await shutdownEndpoint(endpoint)
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

typealias AgentSessionTerminalEndpointRegistry<Key: Hashable> =
    TerminalEndpointRegistry<Key, AgentSessionTerminalEndpoint>

extension TerminalEndpointRegistry where Endpoint == AgentSessionTerminalEndpoint {
    convenience init(factory: @escaping Factory) {
        self.init(factory: factory, shutdown: { await $0.shutdown() })
    }
}

extension TerminalEndpointRegistry where Endpoint == WorkspaceTerminalEndpoint {
    convenience init(factory: @escaping Factory) {
        self.init(factory: factory, shutdown: { await $0.shutdown() })
    }
}
