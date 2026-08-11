import Foundation
import os
import AgentDeskWire

/// Relays agent-feed requests from a panel to the sidecar, and the responses back.
///
/// This replaces a bridge that knew every endpoint the feed had and every field in
/// every payload. It knows neither. A request names a path; the relay checks that
/// path against `AgentFeedRelay.PathPolicy`, attaches the control token, and copies
/// bytes in both directions. A new field, a new endpoint, or a new message type is a
/// change to the sidecar and the panel with nothing to rebuild in between.
///
/// What it does own is the token. The sidecar's control token is a capability the
/// host mints per spawn and the sidecar deletes from its own environment so that
/// model-authored bash cannot reach the control API; a page that renders
/// agent-authored markdown must never hold it. So the relay attaches the header and
/// the webview never sees the value -- which is the whole reason Swift is still in
/// this path at all.
final class AgentFeedHTTPRelay: @unchecked Sendable {
    private let client: any AgentFeedRelayClient
    private let send: @Sendable (Data) -> Void
    private let logger: Logger
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).agent-feed-relay")
    /// In-flight transfers by request id. A transfer is removed when it ends, fails,
    /// or is cancelled, so this is also the concurrency count.
    private var transfers: [String: SidecarStreamHandle] = [:]

    init(client: any AgentFeedRelayClient, send: @escaping @Sendable (Data) -> Void) {
        self.client = client
        self.send = send
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-relay")
    }

    /// Abandons every in-flight transfer. Called when the panel goes away or the
    /// session is torn down: the panel re-issues what it still wants.
    func reset() {
        let handles = queue.sync { () -> [SidecarStreamHandle] in
            let values = Array(transfers.values)
            transfers.removeAll()
            return values
        }
        for handle in handles { handle.cancel() }
    }

    func handleRequest(_ request: AgentFeedRelayRequest) {
        guard AgentFeedRelay.PathPolicy.allows(method: request.method) else {
            fail(rid: request.rid, reason: "method \(request.method) is not relayed")
            return
        }
        guard AgentFeedRelay.PathPolicy.allows(path: request.path) else {
            // Logged, because a rejected path is either a panel bug or something
            // trying to use the relay as a general-purpose proxy. Both are worth
            // seeing; neither should be answered.
            logger.error("relay refused path \(request.path, privacy: .public)")
            fail(rid: request.rid, reason: "path is not a sidecar API path")
            return
        }
        let body = request.body.map { Data($0.utf8) }
        if let body, body.count > AgentFeedRelay.PathPolicy.maximumBodyBytes {
            fail(rid: request.rid, reason: "request body exceeds \(AgentFeedRelay.PathPolicy.maximumBodyBytes) bytes")
            return
        }

        let admitted: Bool = queue.sync {
            guard transfers[request.rid] == nil else { return false }
            guard transfers.count < AgentFeedRelay.maximumConcurrentTransfers else { return false }
            // Reserved before the transfer exists so two requests arriving together
            // cannot both see room for the last slot.
            transfers[request.rid] = .reservation
            return true
        }
        guard admitted else {
            fail(rid: request.rid, reason: "too many agent-feed transfers in flight")
            return
        }

        let rid = request.rid
        // A subscription numbers its chunks across the whole stream, not per message,
        // so a reader that drops one can tell.
        let streamSequence = Counter()
        let handle = request.stream
            ? client.subscribe(
                path: request.path,
                onOpen: { [weak self] status in self?.emit(AgentFeedRelayHead(rid: rid, status: status)) },
                onMessage: { [weak self] payload in
                    guard let self else { return }
                    streamSequence.set(self.emitBody(rid: rid, data: Data(payload.utf8), startingAt: streamSequence.value))
                },
                onError: { [weak self] error in self?.finish(rid: rid, with: error) }
            )
            : client.perform(
                method: request.method,
                path: request.path,
                body: body,
                onResponse: { [weak self] status, data in
                    guard let self else { return }
                    self.emit(AgentFeedRelayHead(rid: rid, status: status))
                    self.emitBody(rid: rid, data: data, startingAt: 0)
                    self.emit(AgentFeedRelayEnd(rid: rid))
                    self.forget(rid: rid)
                },
                onError: { [weak self] error in self?.finish(rid: rid, with: error) }
            )
        // A transfer that already finished synchronously left no slot to replace, so
        // its handle is dropped rather than resurrecting a completed request.
        queue.sync {
            guard transfers[rid] != nil else {
                handle.cancel()
                return
            }
            transfers[rid] = handle
        }
    }

    func handleCancel(_ cancel: AgentFeedRelayCancel) {
        let handle = queue.sync { transfers.removeValue(forKey: cancel.rid) }
        handle?.cancel()
    }

    private func finish(rid: String, with error: Error) {
        forget(rid: rid)
        fail(rid: rid, reason: error.localizedDescription)
    }

    private func forget(rid: String) {
        _ = queue.sync { transfers.removeValue(forKey: rid) }
    }

    private func fail(rid: String, reason: String) {
        emit(AgentFeedRelayError(rid: rid, reason: reason))
    }

    /// Splits a response body into frames the lane can carry.
    ///
    /// The split walks back to a UTF-8 character boundary rather than cutting at an
    /// arbitrary byte: a chunk that ended mid-character would decode to a replacement
    /// character on the far side, silently corrupting one character of a transcript
    /// per megabyte.
    @discardableResult
    private func emitBody(rid: String, data: Data, startingAt sequence: Int) -> Int {
        var sequence = sequence
        var start = data.startIndex
        while start < data.endIndex {
            var end = data.index(start, offsetBy: AgentFeedRelay.chunkBytes, limitedBy: data.endIndex) ?? data.endIndex
            if end < data.endIndex {
                // A continuation byte is 0b10xxxxxx; back up to the byte that starts
                // the character. At most three steps, so this cannot run away.
                var candidate = end
                var steps = 0
                while candidate > start, steps < 3, data[candidate] & 0xC0 == 0x80 {
                    candidate = data.index(before: candidate)
                    steps += 1
                }
                if candidate > start { end = candidate }
            }
            let slice = data[start..<end]
            guard let text = String(data: slice, encoding: .utf8) else {
                fail(rid: rid, reason: "sidecar response is not UTF-8")
                return sequence
            }
            emit(AgentFeedRelayChunk(rid: rid, seq: sequence, data: text, complete: end >= data.endIndex))
            sequence += 1
            start = end
        }
        return sequence
    }

    private func emit<T: Encodable>(_ frame: T) {
        do {
            send(try JSONEncoder().encode(frame))
        } catch {
            logger.error("agent-feed relay encode failed: \(String(describing: error), privacy: .public)")
        }
    }
}

private extension SidecarStreamHandle {
    /// Marks a slot claimed between admitting a request and having its transfer, so
    /// two requests arriving together cannot both take the last one. Cancelling it is
    /// a no-op, which is what makes it safe to hand to the ordinary cancel path.
    static var reservation: SidecarStreamHandle { SidecarStreamHandle(task: Task {}) }
}

/// A chunk counter shared with an escaping stream callback.
///
/// The callback fires once per server-sent message and has to keep numbering where
/// the last one stopped; the sidecar client serializes those callbacks, so this only
/// needs to carry the value across them, not to arbitrate concurrent writers.
private final class Counter: @unchecked Sendable {
    private(set) var value = 0
    func set(_ next: Int) { value = next }
}

/// The transport the relay drives: one request, or one subscription, against the
/// sidecar. Deliberately the whole surface -- there is no per-endpoint method here,
/// because naming an endpoint is what put the schema in Swift.
protocol AgentFeedRelayClient: Sendable {
    /// Performs one request and delivers the complete response.
    func perform(
        method: String,
        path: String,
        body: Data?,
        onResponse: @escaping @Sendable (Int, Data) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle

    /// Follows a server-sent event stream, delivering each message's payload.
    func subscribe(
        path: String,
        onOpen: @escaping @Sendable (Int) -> Void,
        onMessage: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
}
