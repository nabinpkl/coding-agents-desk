actor AsyncKeyedGate<Key: Hashable & Sendable> {
    private var activeKeys: Set<Key> = []
    private var waiters: [Key: [CheckedContinuation<Void, Never>]] = [:]

    func acquire(_ key: Key) async {
        guard activeKeys.contains(key) else {
            activeKeys.insert(key)
            return
        }
        await withCheckedContinuation { continuation in
            waiters[key, default: []].append(continuation)
        }
    }

    func release(_ key: Key) {
        guard var queued = waiters[key], !queued.isEmpty else {
            activeKeys.remove(key)
            waiters.removeValue(forKey: key)
            return
        }
        let next = queued.removeFirst()
        if queued.isEmpty {
            waiters.removeValue(forKey: key)
        } else {
            waiters[key] = queued
        }
        next.resume()
    }
}
