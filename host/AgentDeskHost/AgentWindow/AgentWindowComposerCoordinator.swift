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
    private let observer: AgentWindowComposerValueObserving
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window-composer")

    /// sinkID -> that surface's delivery closure.
    private var sinks: [SinkID: @Sendable (String) -> Void] = [:]
    /// sinkID -> subscriptionId -> sessionId.
    private var subscriptions: [SinkID: [String: String]] = [:]
    /// The last status emitted per sink and subscription, so an unchanged poll stays silent.
    private var lastStatus: [SinkID: [String: AgentWindowInputStatus]] = [:]
    /// sinkID -> subscriptionId -> sessionId, for the AskUserQuestion mirror. Kept apart from the
    /// composer watches because the two are independent surfaces: blurring the composer must not stop
    /// the question mirror's status, and answering a question must not touch the composer watch.
    private var questionSubscriptions: [SinkID: [String: String]] = [:]
    private var lastQuestionStatus: [SinkID: [String: AgentWindowQuestionStatus]] = [:]
    /// sessionId -> the last successfully resolved target, reused by the event-driven refresh so a
    /// value-changed event costs no process-table scan.
    private var lastTargets: [String: AgentWindowSessionTarget] = [:]
    private var timer: DispatchSourceTimer?

    init(
        writer: AgentWindowComposerWriter,
        audit: WorkspaceDesktopAuditing,
        processRows: @escaping () -> [AgentWindowProcessRow] = AgentWindowSessionResolver.liveProcessRows,
        resolveInterval: TimeInterval = Config.claudeWindowResolveInterval,
        observer: AgentWindowComposerValueObserving = AgentWindowComposerValueObserver()
    ) {
        self.queue = DispatchQueue(label: Config.dispatchQueuePrefix + ".agent-window-composer")
        self.writer = writer
        self.audit = audit
        self.processRows = processRows
        self.resolveInterval = resolveInterval
        self.observer = observer
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
            questionSubscriptions[id] = nil
            lastQuestionStatus[id] = nil
            stopPollingIfIdle()
            if subscriptions.isEmpty, questionSubscriptions.isEmpty {
                for pid in observer.observedPids { observer.stopObserving(claudeMainPid: pid) }
                lastTargets = [:]
            }
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
                // A blur that unwatched everything must also stop the AX events: nobody is listening,
                // and keeping Chromium's observer alive is exactly the continuous traffic focus gating
                // exists to save.
                if subscriptions.isEmpty {
                    for pid in observer.observedPids { observer.stopObserving(claudeMainPid: pid) }
                    lastTargets = [:]
                }
            }
        case .windowInputSync(let requestId, let sessionId, let text):
            queue.async { [self] in sync(requestId: requestId, sessionId: sessionId, text: text, to: sink) }
        case .windowInputRead(let requestId, let sessionId):
            queue.async { [self] in read(requestId: requestId, sessionId: sessionId, to: sink) }
        case .windowInputSubmit(let requestId, let sessionId, let text):
            queue.async { [self] in submit(requestId: requestId, sessionId: sessionId, text: text, to: sink) }
        case .questionWatch(let subscriptionId, let sessionId):
            queue.async { [self] in
                questionSubscriptions[sink, default: [:]][subscriptionId] = sessionId
                startPollingIfNeeded()
                // Forced for THIS subscription only, exactly like the composer watch: a re-watch under
                // an id this sink already knows would otherwise stay silent.
                refreshQuestion(forcing: (sink, subscriptionId))
            }
        case .questionUnwatch(let subscriptionId):
            queue.async { [self] in
                questionSubscriptions[sink]?[subscriptionId] = nil
                if questionSubscriptions[sink]?.isEmpty == true { questionSubscriptions[sink] = nil }
                lastQuestionStatus[sink]?[subscriptionId] = nil
                stopPollingIfIdle()
            }
        case .questionAction(let requestId, let sessionId, let kind, let optionIndex, let desired, let otherText):
            queue.async { [self] in
                questionAction(
                    requestId: requestId,
                    sessionId: sessionId,
                    kind: kind,
                    optionIndex: optionIndex,
                    desired: desired,
                    otherText: otherText,
                    to: sink
                )
            }
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
            // `~/.claude/sessions/<pid>.json` registry row names it and its CLI's pid under Claude.app.
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
        guard subscriptions.isEmpty, questionSubscriptions.isEmpty else { return }
        timer?.cancel()
        timer = nil
    }

    /// Re-resolves every watched session and emits only what changed, to the sink that watched it.
    ///
    /// Each DISTINCT session is resolved once per pass even when several surfaces watch it, because the
    /// expensive part is the Accessibility round trip and both surfaces would get the same answer.
    ///
    /// The question mirror shares this poll, so an empty composer table must NOT short-circuit the
    /// pass: a panel whose question is open with nobody typing in the composer still needs its status
    /// re-read and change-emitted on the timer.
    private func refresh(forcing forced: (sink: SinkID, subscriptionId: String)? = nil) {
        guard !subscriptions.isEmpty else {
            refreshQuestion()
            return
        }
        let rows = processRows()
        let snapshot = audit.snapshot()
        var resolved: [String: Result<AgentWindowSessionTarget, AgentWindowInputReason>] = [:]
        var prefilled: [String: String?] = [:]
        var neededPids: Set<pid_t> = []

        for (sink, watches) in subscriptions {
            guard let emit = sinks[sink] else { continue }
            for (subscriptionId, sessionId) in watches {
                let target = resolved[sessionId] ?? {
                    let result = resolveTarget(sessionId: sessionId, rows: rows, snapshot: snapshot)
                    resolved[sessionId] = result
                    return result
                }()
                let status: AgentWindowInputStatus
                let isForced = forced?.sink == sink && forced?.subscriptionId == subscriptionId
                switch target {
                case .success(let target):
                    neededPids.insert(target.claudeMainPid)
                    lastTargets[sessionId] = target
                    let composerText: String?
                    if isForced || !observer.isObserving(claudeMainPid: target.claudeMainPid) {
                        // Read: a forced pass is a fresh watcher that needs the value, and a missing
                        // observer means registration needs (re)establishing -- a revived web contents
                        // has a new composer element whose changes the old registration cannot see.
                        // The read both prefills and proves the composer is reachable; the observer is
                        // then registered on the element the scan found.
                        composerText = prefilled[sessionId] ?? {
                            let text: String?
                            if let value = try? writer.readIfFree(target).get() {
                                text = value
                                if let element = writer.composerElementIfAvailable(for: target) {
                                    observer.ensureObserving(
                                        target: target,
                                        composer: element,
                                        onValueChanged: { [weak self] in
                                            self?.queue.async { self?.refreshSession(sessionId) }
                                        }
                                    )
                                }
                            } else {
                                // A transient read failure -- a web contents rebuilding its tree -- must not
                                // wipe the field with nil: the window is still there, and the panel adopts a
                                // nil text as its own field contents. Keep the last known text until a read
                                // succeeds again, so a flapping tree renders no flicker.
                                text = lastStatus[sink]?[subscriptionId]?.composerText
                            }
                            prefilled[sessionId] = text
                            return text
                        }()
                    } else {
                        // The value-changed observer carries text updates, so the poll pass reads nothing:
                        // the last known text is what the window last reported, and every change since has
                        // already been pushed by the event handler.
                        composerText = prefilled[sessionId] ?? lastStatus[sink]?[subscriptionId]?.composerText
                        prefilled[sessionId] = composerText
                    }
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
                guard isForced || lastStatus[sink]?[subscriptionId] != status else { continue }
                lastStatus[sink, default: [:]][subscriptionId] = status
                send(status, to: emit)
            }
        }

        // Drop observers and target caches no watched session needs: a blur that unwatched everything
        // must also stop the AX events, or the host would keep Chromium's observer alive with no panel.
        for pid in observer.observedPids where !neededPids.contains(pid) {
            observer.stopObserving(claudeMainPid: pid)
        }
        let watchedSessions = Set(subscriptions.values.flatMap { $0.values })
            .union(questionSubscriptions.values.flatMap { $0.values })
        lastTargets = lastTargets.filter { watchedSessions.contains($0.key) }
        // The question mirror rides the same poll: while any question watch is live, its status is
        // re-read and change-emitted on the timer like the composer statuses.
        refreshQuestion()
    }

    /// The question-mirror status pass. Like the composer pass it resolves each DISTINCT session once,
    /// reusing the composer pass's resolution when both surfaces watch the same session, and emits only
    /// what changed -- the state read is an AX scan, so a silent poll is what makes the poll cheap.
    private func refreshQuestion(forcing forced: (sink: SinkID, subscriptionId: String)? = nil) {
        guard !questionSubscriptions.isEmpty else { return }
        let rows = processRows()
        let snapshot = audit.snapshot()
        var resolved: [String: Result<AgentWindowSessionTarget, AgentWindowInputReason>] = [:]
        for (sink, watches) in questionSubscriptions {
            guard let emit = sinks[sink] else { continue }
            for (subscriptionId, sessionId) in watches {
                let target = resolved[sessionId] ?? {
                    let result = resolveTarget(sessionId: sessionId, rows: rows, snapshot: snapshot)
                    resolved[sessionId] = result
                    return result
                }()
                let status: AgentWindowQuestionStatus
                let isForced = forced?.sink == sink && forced?.subscriptionId == subscriptionId
                switch target {
                case .success(let target):
                    lastTargets[sessionId] = target
                    // A forced pass (fresh watch) reads fresh: the panel may have changed while
                    // unwatched. A poll pass keeps the last known status through a transient read
                    // failure -- a web contents rebuilding its tree must not flip the mirror, exactly
                    // like the composer's last-known-text rule.
                    let fallback = isForced ? nil : lastQuestionStatus[sink]?[subscriptionId]
                    status = questionStatus(
                        from: writer.readQuestionIfFree(target),
                        target: target,
                        subscriptionId: subscriptionId,
                        sessionId: sessionId,
                        fallback: fallback
                    )
                case .failure(let reason):
                    status = AgentWindowQuestionStatus(
                        subscriptionId: subscriptionId,
                        sessionId: sessionId,
                        enabled: false,
                        reason: reason.rawValue,
                        onActiveDesktop: false,
                        present: nil
                    )
                }
                guard isForced || lastQuestionStatus[sink]?[subscriptionId] != status else { continue }
                lastQuestionStatus[sink, default: [:]][subscriptionId] = status
                send(status, to: emit)
            }
        }
    }

    /// Maps a question-state read onto the wire status.
    ///
    /// A nil read means the window is on another Desktop -- there is no tree to read, so the panel
    /// keeps its JSON-driven content and learns nothing about presence; `present` stays nil rather
    /// than falsely claiming the panel is absent.
    private func questionStatus(
        from result: Result<AgentWindowQuestionState?, AgentWindowInputReason>,
        target: AgentWindowSessionTarget,
        subscriptionId: String,
        sessionId: String,
        fallback: AgentWindowQuestionStatus? = nil
    ) -> AgentWindowQuestionStatus {
        switch result {
        case .success(let state?):
            return AgentWindowQuestionStatus(
                subscriptionId: subscriptionId,
                sessionId: sessionId,
                enabled: true,
                reason: nil,
                onActiveDesktop: target.isOnActiveDesktop,
                present: state.present,
                selected: state.selectedIndices,
                otherText: state.otherText,
                submitEnabled: state.submitEnabled
            )
        case .success(nil):
            return AgentWindowQuestionStatus(
                subscriptionId: subscriptionId,
                sessionId: sessionId,
                enabled: true,
                reason: nil,
                onActiveDesktop: target.isOnActiveDesktop,
                present: nil
            )
        case .failure:
            // A transient failure keeps the last known status rather than flipping the mirror; with no
            // previous status the panel learns nothing and stays on its JSON content.
            return fallback ?? AgentWindowQuestionStatus(
                subscriptionId: subscriptionId,
                sessionId: sessionId,
                enabled: true,
                reason: nil,
                onActiveDesktop: target.isOnActiveDesktop,
                present: nil
            )
        }
    }

    /// The event-driven refresh: one watched session's composer value changed, so re-read it and emit
    /// change-only to that session's watchers. No process-table scan: the last resolved target is what
    /// the event is about, and resolution changes still surface on the next poll pass.
    private func refreshSession(_ sessionId: String) {
        guard !subscriptions.isEmpty, let target = lastTargets[sessionId] else { return }
        let text: String?
        if let value = try? writer.readIfFree(target).get() {
            text = value
        } else {
            text = nil
            // The tree is gone; the registration on the old element is dead. Drop the observer so the
            // next poll pass re-registers on the respawned element instead of trusting a silent one.
            observer.stopObserving(claudeMainPid: target.claudeMainPid)
        }
        for (sink, watches) in subscriptions {
            guard let emit = sinks[sink] else { continue }
            for (subscriptionId, watchedSession) in watches where watchedSession == sessionId {
                let status = AgentWindowInputStatus(
                    subscriptionId: subscriptionId,
                    sessionId: sessionId,
                    enabled: true,
                    reason: nil,
                    onActiveDesktop: target.isOnActiveDesktop,
                    composerText: text ?? lastStatus[sink]?[subscriptionId]?.composerText
                )
                guard lastStatus[sink]?[subscriptionId] != status else { continue }
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

    private func submit(requestId: String, sessionId: String, text: String, to sink: SinkID) {
        // No return path means the surface that asked is gone. Refuse rather than commit a prompt
        // nobody can be told the outcome of.
        guard let emit = sinks[sink] else {
            logger.notice("composer submit dropped, no sink sink=\(sink, privacy: .public)")
            return
        }
        let result: Result<String, AgentWindowInputReason>
        switch resolveTarget(sessionId: sessionId, rows: processRows(), snapshot: audit.snapshot()) {
        case .success(let target):
            // Commits the prompt: fills and presses Return. Unlike sync this fronts the owning window.
            result = writer.writeAndSubmit(text, to: target)
        case .failure(let reason):
            result = .failure(reason)
        }
        report(requestId: requestId, sessionId: sessionId, result: result, to: emit)
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

    /// Performs one AskUserQuestion interaction on the session's window and reports the post-action
    /// state.
    ///
    /// The payload was already validated per kind at both doors, so a missing field here is an
    /// unreachable state: the frame is dropped with a log rather than answered with a failure result,
    /// matching the lane's own rejection philosophy.
    private func questionAction(
        requestId: String,
        sessionId: String,
        kind: AgentPanelQuestionActionKind,
        optionIndex: Int?,
        desired: Bool?,
        otherText: String?,
        to sink: SinkID
    ) {
        guard let emit = sinks[sink] else {
            logger.notice("question action dropped, no sink sink=\(sink, privacy: .public)")
            return
        }
        let action: AgentWindowQuestionOperation
        switch kind {
        case .select:
            guard let optionIndex, let desired else {
                logger.error("question action select missing payload session=\(sessionId, privacy: .public)")
                return
            }
            action = .select(option: optionIndex, desired: desired)
        case .other:
            guard let otherText else {
                logger.error("question action other missing payload session=\(sessionId, privacy: .public)")
                return
            }
            action = .other(otherText)
        case .submit:
            action = .submit
        case .skip:
            action = .skip
        case .dismiss:
            action = .dismiss
        case .viewOptions:
            action = .viewOptions
        }
        let result: Result<AgentWindowQuestionState, AgentWindowInputReason>
        switch resolveTarget(sessionId: sessionId, rows: processRows(), snapshot: audit.snapshot()) {
        case .success(let target):
            result = writer.performQuestionAction(action, to: target)
        case .failure(let reason):
            result = .failure(reason)
        }
        reportQuestion(requestId: requestId, sessionId: sessionId, result: result, to: emit)
        // The window's state just changed -- an option was pressed, a panel dismissed -- so every
        // watching surface must learn it without waiting out the poll interval. Change-only: both
        // passes emit only what differs from their last status.
        refresh()
    }

    private func reportQuestion(
        requestId: String,
        sessionId: String,
        result: Result<AgentWindowQuestionState, AgentWindowInputReason>,
        to emit: @Sendable (String) -> Void
    ) {
        switch result {
        case .success(let state):
            send(AgentWindowQuestionResult(
                requestId: requestId,
                sessionId: sessionId,
                ok: true,
                reason: nil,
                present: state.present,
                selected: state.selectedIndices,
                otherText: state.otherText,
                submitEnabled: state.submitEnabled
            ), to: emit)
        case .failure(let reason):
            logger.error(
                """
                question action failed session=\(sessionId, privacy: .public) \
                reason=\(reason.rawValue, privacy: .public)
                """
            )
            send(AgentWindowQuestionResult(
                requestId: requestId,
                sessionId: sessionId,
                ok: false,
                reason: reason.rawValue,
                present: nil,
                selected: [],
                otherText: nil,
                submitEnabled: nil
            ), to: emit)
        }
    }

    private func report(
        requestId: String,
        sessionId: String,
        result: Result<String, AgentWindowInputReason>,
        to emit: @Sendable (String) -> Void
    ) {        switch result {
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
