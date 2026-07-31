import Foundation

/// Resumes one waiter exactly once, whichever of ready-or-give-up wins.
private final class ReadyGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<URL?, Never>?

    init(_ continuation: CheckedContinuation<URL?, Never>) {
        self.continuation = continuation
    }

    func finish(_ url: URL?) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: url)
    }
}

/// A sidecar's base URL, published as an event rather than a value callers sample.
///
/// The host starts its sidecars in parallel with the windows and lanes that read
/// them, so a consumer arriving before its sidecar is up is ordinary rather than
/// exceptional. Sampling a plain `URL?` at the instant of a request turns that
/// overlap into a failure: on 2026-07-30 the restored Agents window asked at
/// 16:04:24.200 and the agent-feed sidecar published at 16:04:25.251, and because
/// a stream that reports an error is torn down, one second of overlap cost the
/// window its whole session.
///
/// Waiting is always bounded. A sidecar that is genuinely down must still surface
/// as an error a caller can show and retry, never as a request that hangs.
final class SidecarReadinessSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var url: URL?
    private var waiters: [UUID: (URL?) -> Void] = [:]
    private var shutDown = false
    private let timers: DispatchQueue

    init(label: String) {
        self.timers = DispatchQueue(label: label)
    }

    /// The URL if the sidecar is up right now, without waiting.
    var current: URL? {
        lock.lock()
        defer { lock.unlock() }
        return url
    }

    /// The sidecar answered: publish, and wake everyone waiting on it.
    func publish(_ ready: URL) {
        lock.lock()
        url = ready
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending.values { waiter(ready) }
    }

    /// The sidecar died and a restart is coming.
    ///
    /// Waiters are deliberately left waiting: the restart is exactly what they are
    /// waiting for, and failing them here would recreate the bug this type exists
    /// to remove, one supervisor layer down.
    func clear() {
        lock.lock()
        url = nil
        lock.unlock()
    }

    /// The sidecar is being torn down for good; release waiters rather than leaving
    /// them parked on something that is never coming back.
    func stop() {
        lock.lock()
        shutDown = true
        url = nil
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending.values { waiter(nil) }
    }

    /// The URL, waiting up to `timeout` seconds for a sidecar still coming up.
    /// Nil once the wait elapses or the sidecar has been stopped.
    func value(waitingUpTo timeout: TimeInterval) async -> URL? {
        await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            let gate = ReadyGate(continuation)
            lock.lock()
            if let url {
                lock.unlock()
                return gate.finish(url)
            }
            if shutDown {
                lock.unlock()
                return gate.finish(nil)
            }
            let token = UUID()
            waiters[token] = { gate.finish($0) }
            lock.unlock()
            timers.asyncAfter(deadline: .now() + timeout) { [weak self] in
                if let self {
                    self.lock.lock()
                    self.waiters.removeValue(forKey: token)
                    self.lock.unlock()
                }
                gate.finish(nil)
            }
        }
    }
}
