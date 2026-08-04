import AgentDeskWire
import AgentPanel
import Foundation
import os

/// Owns composer-sync subscriptions for both surfaces and serializes every write against Claude Desktop.
///
/// One coordinator serves the Mac Agents window and the phone's authenticated lane, because the thing
/// being coordinated is a single external application's windows: two independent writers could move the
/// same window to two Desktops at once. Every request runs on one serial queue for that reason, and off
/// the main thread because a write blocks on Accessibility round trips and a Space move.
final class AgentWindowComposerCoordinator: @unchecked Sendable {
    /// `@unchecked` because subscription state is plain mutable storage confined to `queue`. Everything
    /// mutable below is touched only from a `queue` block; nothing here is safe to read from outside.
    private let queue: DispatchQueue
    private let writer: AgentWindowComposerWriter
    private let audit: WorkspaceDesktopAuditing
    private let processRows: () -> [AgentWindowProcessRow]
    private let emit: @Sendable (String) -> Void
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    /// subscriptionId -> sessionId.
    private var subscriptions: [String: String] = [:]
    /// The last status emitted per subscription, so an unchanged poll stays silent.
    private var lastStatus: [String: AgentWindowInputStatus] = [:]
    private var timer: DispatchSourceTimer?

    init(
        writer: AgentWindowComposerWriter,
        audit: WorkspaceDesktopAuditing,
        processRows: @escaping () -> [AgentWindowProcessRow] = AgentWindowSessionResolver.liveProcessRows,
        emit: @escaping @Sendable (String) -> Void
    ) {
        self.queue = DispatchQueue(label: Config.dispatchQueuePrefix + ".agent-window-composer")
        self.writer = writer
        self.audit = audit
        self.processRows = processRows
        self.emit = emit
    }

    deinit { timer?.cancel() }

    func handle(_ request: AgentPanelRequest) {
        switch request {
        case .windowInputWatch(let subscriptionId, let sessionId):
            queue.async { [self] in
                subscriptions[subscriptionId] = sessionId
                startPollingIfNeeded()
                refresh(force: true)
            }
        case .windowInputUnwatch(let subscriptionId):
            queue.async { [self] in
                subscriptions[subscriptionId] = nil
                lastStatus[subscriptionId] = nil
                if subscriptions.isEmpty {
                    timer?.cancel()
                    timer = nil
                }
            }
        case .windowInputSync(let requestId, let sessionId, let text):
            queue.async { [self] in sync(requestId: requestId, sessionId: sessionId, text: text) }
        case .windowInputRead(let requestId, let sessionId):
            queue.async { [self] in read(requestId: requestId, sessionId: sessionId) }
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
        if let reason = resolution.unavailableReason { return .failure(reason) }
        guard let pid = resolution.claudeMainPid else { return .failure(.notRunning) }
        return AgentWindowSessionTargeting.target(sessionId: sessionId, claudeMainPid: pid, in: snapshot)
    }

    private func startPollingIfNeeded() {
        guard timer == nil else { return }
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(
            deadline: .now() + Config.claudeWindowResolveInterval,
            repeating: Config.claudeWindowResolveInterval
        )
        source.setEventHandler { [weak self] in self?.refresh(force: false) }
        source.resume()
        timer = source
    }

    /// Re-resolves every watched session and emits only what changed.
    private func refresh(force: Bool) {
        guard !subscriptions.isEmpty else { return }
        let rows = processRows()
        let snapshot = audit.snapshot()
        for (subscriptionId, sessionId) in subscriptions {
            let status: AgentWindowInputStatus
            switch resolveTarget(sessionId: sessionId, rows: rows, snapshot: snapshot) {
            case .success(let target):
                // Prefill only when the window is already on this Desktop. Reading one that is not would
                // mean dragging it onto the user's screen and back just to populate a field.
                let composerText = (try? writer.readIfFree(target).get()) ?? nil
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
            guard force || lastStatus[subscriptionId] != status else { continue }
            lastStatus[subscriptionId] = status
            send(status)
        }
    }

    // MARK: - Requests

    private func sync(requestId: String, sessionId: String, text: String) {
        let result: Result<String, AgentWindowInputReason>
        switch resolveTarget(sessionId: sessionId, rows: processRows(), snapshot: audit.snapshot()) {
        case .success(let target):
            result = writer.write(text, to: target)
        case .failure(let reason):
            result = .failure(reason)
        }
        report(requestId: requestId, sessionId: sessionId, result: result)
        // The window's state just changed, and a caller that only sees the result would not learn the
        // new composer text or Desktop. Re-resolving here keeps the panel's field and the real window
        // agreeing without waiting out the poll interval.
        refresh(force: true)
    }

    private func read(requestId: String, sessionId: String) {
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
        report(requestId: requestId, sessionId: sessionId, result: result)
    }

    private func report(
        requestId: String,
        sessionId: String,
        result: Result<String, AgentWindowInputReason>
    ) {
        switch result {
        case .success(let text):
            send(AgentWindowInputResult(
                requestId: requestId,
                sessionId: sessionId,
                ok: true,
                reason: nil,
                text: text
            ))
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
            ))
        }
    }

    private func send<Message: Encodable>(_ message: Message) {
        guard let data = try? JSONEncoder().encode(message) else {
            logger.error("composer message failed to encode")
            return
        }
        emit(String(decoding: data, as: UTF8.self))
    }
}
