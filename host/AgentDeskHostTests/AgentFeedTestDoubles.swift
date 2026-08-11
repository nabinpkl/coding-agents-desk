import Foundation
@testable import AgentDeskHost

/// Counts the frames a relay emitted, for tests that only care that it stayed quiet.
///
/// Shared rather than per-file because "the relay sent nothing" is the assertion most of the
/// non-relay tests make about it, and three copies of a counter would be three chances to count
/// something different.
final class CapturingSink: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Data] = []

    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return frames.count
    }

    func accept(_ data: Data) {
        lock.lock()
        frames.append(data)
        lock.unlock()
    }

    func frame<T: Decodable>(_ type: T.Type, at index: Int) throws -> T {
        lock.lock(); let snapshot = frames; lock.unlock()
        return try JSONDecoder().decode(type, from: snapshot[index])
    }
}

/// A sidecar transport that answers nothing, for tests that construct a window or a transport and
/// never exercise the feed.
final class InertRelayClient: AgentFeedRelayClient, @unchecked Sendable {
    func perform(
        method: String,
        path: String,
        body: Data?,
        onResponse: @escaping @Sendable (Int, Data) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }

    func subscribe(
        path: String,
        onOpen: @escaping @Sendable (Int) -> Void,
        onMessage: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }
}
