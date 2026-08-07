import AgentDeskWire
import AgentPanel
import Foundation
import os

/// Owns composer-sync subscriptions for every surface and serializes each write against Claude Desktop.
///
/// ONE coordinator serves all Mac Agents windows and every attached phone lane, because the thing being
/// coordinated is a single external application's windows: two independent writers could move the same
/// window to two Desktops at once, and each would restore it to the home Desktop the other just changed.
/// Every request runs on one serial queue for that reason, and off the main thread because a write blocks
/// on Accessibility round trips and a Space move.
///
/// Surfaces are therefore addressed rather than owned. A sink is one panel's return path -- an Agents
/// window's webview, or one paired device's input lane -- and status and results go only to the sink that
/// asked. Nothing here fans a result out to every listener: a phone must not be told the outcome of a
/// write a Mac window made, because it would adopt that text as its own field's contents.
final class AgentWindowComposerCoordinator: @unchecked Sendable {
    /// Identifies one panel surface's return path. Opaque to this type; the caller mints it (an Agents
    /// window's id, a device fingerprint) and must reuse the same value for the lifetime of that surface.
    typealias SinkID = String

    /// `@unchecked` because subscription state is plain mutable storage confined to `queue`. Everything
    /// mutable below is touched only from a `queue` block; nothing here is safe to read from outside.
    private let queue: DispatchQueue
    private let writer: AgentWindowComposerWriter
    private let audit: WorkspaceDesktopAuditing
    private let processRows: () -> [AgentWindowProcessRow]
    private let resolveInterval: TimeInterval
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    /// sinkID -> that surface's delivery closure.
    private var sinks: [SinkID: @Sendable (String) -> Void] = [:]
    /// sinkID -> subscriptionId -> sessionId.
    private var subscriptions: [SinkID: [String: String]] = [:]
    /// The last status emitted per sink and subscription, so an unchanged poll stays silent.
    private var lastStatus: [SinkID: [String: AgentWindowInputStatus]] = [:]
    private var timer: DispatchSourceTimer?

    init(
        writer: AgentWindowComposerWriter,
        audit: WorkspaceDesktopAuditing,
        processRows: @escaping () -> [AgentWindowProcessRow] = AgentWindowSessionResolver.liveProcessRows,
        resolveInterval: TimeInterval = Config.claudeWindowResolveInterval
    ) {
        self.queue = DispatchQueue(label: Config.dispatchQueuePrefix + ".agent-window-composer")
        self.writer = writer
        self.audit = audit
        self.processRows = processRows
        self.resolveInterval = resolveInterval
    }

    deinit { timer?.cancel() }

    // MARK: - Surfaces

    /// Registers a surface's return path. Callers mint one id per live surface instance (a window, one
    /// input lane) rather than per device or per user, so two lanes for the same phone across a reconnect
    /// are two sinks and the dead one's teardown cannot silence the live one.
    func attachSink(_ id: SinkID, emit: @escaping @Sendable (String) -> Void) {
        queue.async { [self] in sinks[id] = emit }
    }

    /// Drops a surface and everything it was watching. Called when an Agents window closes or an input
    /// lane detaches; without it a dead phone's sessions would keep being re-resolved on every poll.
    func detachSink(_ id: SinkID) {
        queue.async { [self] in
            sinks[id] = nil
            subscriptions[id] = nil
            lastStatus[id] = nil
            stopPollingIfIdle()
        }
    }

    func handle(_ request: AgentPanelRequest, from sink: SinkID) {
        switch request {
        case .windowInputWatch(let subscriptionId, let sessionId):
            queue.async { [self] in
                subscriptions[sink, default: [:]][subscriptionId] = sessionId
                startPollingIfNeeded()
                // Forced for THIS subscription only: a re-watch under an id this sink already knows would
                // otherwise stay silent and leave the panel with no status at all. Forcing globally would
                // let one surface's subscribe rewrite every other panel's field mid-edit.
                refresh(forcing: (sink, subscriptionId))
            }
        case .windowInputUnwatch(let subscriptionId):
            queue.async { [self] in
                subscriptions[sink]?[subscriptionId] = nil
                if subscriptions[sink]?.isEmpty == true { subscriptions[sink] = nil }
                lastStatus[sink]?[subscriptionId] = nil
                stopPollingIfIdle()
            }
        case .windowInputSync(let requestId, let sessionId, let text):
            queue.async { [self] in sync(requestId: requestId, sessionId: sessionId, text: text, to: sink) }
        case .windowInputRead(let requestId, let sessionId):
            queue.async { [self] in read(requestId: requestId, sessionId: sessionId, to: sink) }
        default:
            break
        }
    }

    // MARK: - Resolution

    /// Resolves one session to a writable window, or the reason it is not writable.
    ///
    /// Every caller shares this so the reason the panel disables the field is the same reason a write
    /// would have failed with. Both reads take one process-table scan and one audit.
    private func resolveTarget(
        sessionId: String,
        rows: [AgentWindowProcessRow],
        snapshot: WorkspaceDesktopSnapshot
    ) -> Result<AgentWindowSessionTarget, AgentWindowInputReason> {
        let resolution = AgentWindowSessionResolver.resolve(sessionId: sessionId, in: rows)
        let pid: pid_t
        if let resolved = resolution.claudeMainPid {
            pid = resolved
        } else if resolution.chains.isEmpty,
                  let runtimeOwner = AgentWindowRuntimeResolver.desktopOwner(
                    sessionId: sessionId,
                    rows: rows,
                    claudeMainPath: Config.claudeDesktopMainPath
                  ) {
            // A brand-new (not resumed) Claude Desktop session: no child argv carries its id, but its
            // transcript project + the owning child CLI's working directory identify the window.
            pid = runtimeOwner
        } else {
            return .failure(resolution.unavailableReason ?? .notRunning)
        }
        return AgentWindowSessionTargeting.target(sessionId: sessionId, claudeMainPid: pid, in: snapshot)
    }

    private func startPollingIfNeeded() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + resolveInterval, repeating: resolveInterval)
        source.setEventHandler { [weak self] in self?.refresh() }
        source.resume()
        timer = source
    }

    private func stopPollingIfIdle() {
        guard subscriptions.isEmpty else { return }
        timer?.cancel()
        timer = nil
    }

    /// Re-resolves every watched session and emits only what changed, to the sink that watched it.
    ///
    /// Each DISTINCT session is resolved once per pass even when several surfaces watch it, because the
    /// expensive part is the Accessibility round trip and both surfaces would get the same answer.
    private func refresh(forcing forced: (sink: SinkID, subscriptionId: String)? = nil) {
        guard !subscriptions.isEmpty else { return }
        let rows = processRows()
        let snapshot = audit.snapshot()
        var resolved: [String: Result<AgentWindowSessionTarget, AgentWindowInputReason>] = [:]
        var prefilled: [String: String?] = [:]

        for (sink, watches) in subscriptions {
            guard let emit = sinks[sink] else { continue }
            for (subscriptionId, sessionId) in watches {
                let target = resolved[sessionId] ?? {
                    let result = resolveTarget(sessionId: sessionId, rows: rows, snapshot: snapshot)
                    resolved[sessionId] = result
                    return result
                }()
                let status: AgentWindowInputStatus
                switch target {
                case .success(let target):
                    // Prefill only when the window is already on this Desktop. Reading one that is not
                    // would mean dragging it onto the user's screen and back just to populate a field.
                    let composerText = prefilled[sessionId] ?? {
                        let text = (try? writer.readIfFree(target).get()) ?? nil
                        prefilled[sessionId] = text
                        return text
                    }()
                    status = AgentWindowInputStatus(
                        subscriptionId: subscriptionId,
                        sessionId: sessionId,
                        enabled: true,
                        reason: nil,
                        onActiveDesktop: target.isOnActiveDesktop,
                        composerText: composerText
                    )
                case .failure(let reason):
                    status = AgentWindowInputStatus(
                        subscriptionId: subscriptionId,
                        sessionId: sessionId,
                        enabled: false,
                        reason: reason.rawValue,
                        onActiveDesktop: false,
                        composerText: nil
                    )
                }
                let isForced = forced?.sink == sink && forced?.subscriptionId == subscriptionId
                guard isForced || lastStatus[sink]?[subscriptionId] != status else { continue }
                lastStatus[sink, default: [:]][subscriptionId] = status
                send(status, to: emit)
            }
        }
    }

    // MARK: - Requests

    private func sync(requestId: String, sessionId: String, text: String, to sink: SinkID) {
        // No return path means the surface that asked is gone. Refuse rather than write: a composer fill
        // nobody can be told about is an unobservable edit to another application's window.
        guard let emit = sinks[sink] else {
            logger.notice("composer sync dropped, no sink sink=\(sink, privacy: .public)")
            return
        }
        let result: Result<String, AgentWindowInputReason>
        switch resolveTarget(sessionId: sessionId, rows: processRows(), snapshot: audit.snapshot()) {
        case .success(let target):
            result = writer.write(text, to: target)
        case .failure(let reason):
            result = .failure(reason)
        }
        report(requestId: requestId, sessionId: sessionId, result: result, to: emit)
        // The window's state just changed, and a caller that only sees the result would not learn the
        // new composer text or Desktop. Re-resolving here keeps every watching panel's field and the real
        // window agreeing without waiting out the poll interval -- including the OTHER surface, which
        // never saw the request but is showing the same session. Change-only: the write is what changed
        // the window, so any watcher whose status is now stale emits on its own; a forced pass would also
        // rewrite the fields of panels showing text that did not move.
        refresh()
    }

    private func read(requestId: String, sessionId: String, to sink: SinkID) {
        guard let emit = sinks[sink] else { return }
        let result: Result<String, AgentWindowInputReason>
        switch resolveTarget(sessionId: sessionId, rows: processRows(), snapshot: audit.snapshot()) {
        case .success(let target):
            // An explicit load is the user asking for the round trip, so unlike the poll it is allowed
            // to bring the window here. Writing back what was read is what performs the move.
            switch writer.readIfFree(target) {
            case .success(let text?):
                result = .success(text)
            case .success(nil):
                result = writer.readAcrossDesktops(target)
            case .failure(let reason):
                result = .failure(reason)
            }
        case .failure(let reason):
            result = .failure(reason)
        }
        report(requestId: requestId, sessionId: sessionId, result: result, to: emit)
    }

    private func report(
        requestId: String,
        sessionId: String,
        result: Result<String, AgentWindowInputReason>,
        to emit: @Sendable (String) -> Void
    ) {
        switch result {
        case .success(let text):
            send(AgentWindowInputResult(
                requestId: requestId,
                sessionId: sessionId,
                ok: true,
                reason: nil,
                text: text
            ), to: emit)
        case .failure(let reason):
            logger.error(
                """
                composer request failed session=\(sessionId, privacy: .public) \
                reason=\(reason.rawValue, privacy: .public)
                """
            )
            send(AgentWindowInputResult(
                requestId: requestId,
                sessionId: sessionId,
                ok: false,
                reason: reason.rawValue,
                text: nil
            ), to: emit)
        }
    }

    private func send<Message: Encodable>(_ message: Message, to emit: @Sendable (String) -> Void) {
        guard let data = try? JSONEncoder().encode(message) else {
            logger.error("composer message failed to encode")
            return
        }
        emit(String(decoding: data, as: UTF8.self))
    }
}
