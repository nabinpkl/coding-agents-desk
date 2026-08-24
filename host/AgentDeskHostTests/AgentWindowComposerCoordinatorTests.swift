import AgentDeskWire
import AgentPanel
import ApplicationServices
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

/// The coordinator is the one place both panel surfaces meet, so what is under test here is the
/// ADDRESSING: which surface hears about what. The Accessibility sequencing itself is covered by
/// `AgentWindowComposerWriterTests` against the same seams.
struct AgentWindowComposerCoordinatorTests {
    private let claudeMain = "/Applications/Claude.app/Contents/MacOS/Claude"
    private let session = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"
    private let terminalSession = "3e1b7a90-55cc-4d10-9f88-2b0c7d6a1e44"

    // MARK: - Doubles

    /// Collects one surface's messages and lets a test await a count, because every coordinator reply
    /// crosses its serial queue.
    private final class Sink: @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [String] = []
        private var waiter: (count: Int, continuation: CheckedContinuation<[String], Never>)?

        var emit: @Sendable (String) -> Void {
            { [self] message in
                var resume: (CheckedContinuation<[String], Never>, [String])?
                lock.lock()
                messages.append(message)
                if let pending = waiter, messages.count >= pending.count {
                    resume = (pending.continuation, messages)
                    waiter = nil
                }
                lock.unlock()
                resume?.0.resume(returning: resume?.1 ?? [])
            }
        }

        var current: [String] {
            lock.lock()
            defer { lock.unlock() }
            return messages
        }

        func wait(count: Int) async -> [String] {
            await withCheckedContinuation { continuation in
                lock.lock()
                if messages.count >= count {
                    let snapshot = messages
                    lock.unlock()
                    continuation.resume(returning: snapshot)
                    return
                }
                waiter = (count, continuation)
                lock.unlock()
            }
        }
    }

    private final class Access: AgentWindowComposerAccessing, AgentWindowDesktopMoving, @unchecked Sendable {
        private let lock = NSLock()
        private var _writes: [String] = []
        private var _reads = 0
        var composerText = "existing draft"
        var readError: AgentWindowInputReason?
        var questionState = AgentWindowQuestionState(
            present: true,
            selectedIndices: [],
            otherText: nil,
            submitEnabled: false
        )
        var questionActionError: AgentWindowInputReason?

        var writes: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _writes
        }

        var readCount: Int {
            lock.lock()
            defer { lock.unlock() }
            return _reads
        }

        func frontmostApplicationPID() -> pid_t? { 100 }
        func latchManualAccessibility(pid: pid_t) throws {}
        func awaitComposer(for target: AgentWindowSessionTarget) throws {}
        func readComposer(for target: AgentWindowSessionTarget) throws -> String {
            lock.lock()
            _reads += 1
            let error = readError
            let text = composerText
            lock.unlock()
            if let error { throw error }
            return text
        }
        // A real element reference is created without any Accessibility permission; the coordinator
        // only hands it to the observer seam, which the tests fake.
        func composerElementIfAvailable(for target: AgentWindowSessionTarget) -> AXUIElement? {
            AXUIElementCreateApplication(target.claudeMainPid)
        }

        func writeComposer(_ text: String, for target: AgentWindowSessionTarget) throws -> String {
            lock.lock()
            _writes.append(text)
            composerText = text
            lock.unlock()
            return text
        }

        func submitComposer(for target: AgentWindowSessionTarget) throws -> String {
            lock.lock()
            let submitted = composerText
            composerText = ""
            lock.unlock()
            return submitted
        }

        func readQuestionState(for target: AgentWindowSessionTarget) throws -> AgentWindowQuestionState {
            lock.lock()
            let state = questionState
            let error = questionActionError
            lock.unlock()
            if let error { throw error }
            return state
        }

        func pressQuestionOption(index: Int, desired: Bool, for target: AgentWindowSessionTarget) throws {
            lock.lock()
            let error = questionActionError
            if error == nil {
                let current = questionState.selectedIndices
                let next = desired
                    ? (current.contains(index) ? current : current + [index])
                    : current.filter { $0 != index }
                questionState = AgentWindowQuestionState(
                    present: true,
                    selectedIndices: next,
                    otherText: questionState.otherText,
                    submitEnabled: !next.isEmpty
                )
            }
            lock.unlock()
            if let error { throw error }
        }

        func setQuestionOther(_ text: String, for target: AgentWindowSessionTarget) throws {
            lock.lock()
            let error = questionActionError
            if error == nil {
                questionState = AgentWindowQuestionState(
                    present: true,
                    selectedIndices: questionState.selectedIndices,
                    otherText: text,
                    submitEnabled: true
                )
            }
            lock.unlock()
            if let error { throw error }
        }

        func pressQuestionSubmit(for target: AgentWindowSessionTarget) throws {
            lock.lock()
            let error = questionActionError
            if error == nil {
                questionState = .absent
            }
            lock.unlock()
            if let error { throw error }
        }

        func pressQuestionSkip(for target: AgentWindowSessionTarget) throws {
            lock.lock()
            let error = questionActionError
            if error == nil {
                questionState = .absent
            }
            lock.unlock()
            if let error { throw error }
        }

        func pressQuestionDismiss(for target: AgentWindowSessionTarget) throws {
            lock.lock()
            let error = questionActionError
            if error == nil {
                questionState = .absent
            }
            lock.unlock()
            if let error { throw error }
        }

        func pressQuestionViewOptions(for target: AgentWindowSessionTarget) throws {
            lock.lock()
            let error = questionActionError
            lock.unlock()
            if let error { throw error }
        }

        func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {}
    }

    /// The Codex Desktop side of the same seams: a writer access plus the state/summary readers the
    /// codex resolution path consumes.
    private final class CodexAccess: CodexWindowAccessing, CodexWindowSummarizing, CodexWindowStateReading, AgentWindowDesktopMoving, @unchecked Sendable {
        private let lock = NSLock()
        var record: CodexThreadRecord?
        var threadNameValue: String?
        var summaries: [CodexWindowSummary] = []
        var composerText = "existing codex draft"
        private var _writes: [String] = []

        var writes: [String] {
            lock.lock()
            defer { lock.unlock() }
            return _writes
        }

        // CodexWindowStateReading
        func threadRecord(_ threadId: String) -> CodexThreadRecord? {
            lock.lock()
            defer { lock.unlock() }
            return record
        }

        func threadName(_ threadId: String) -> String? {
            lock.lock()
            defer { lock.unlock() }
            return threadNameValue
        }

        // CodexWindowSummarizing
        func windowSummaries(mainPid: pid_t) -> [CodexWindowSummary] {
            lock.lock()
            defer { lock.unlock() }
            return summaries
        }

        // CodexWindowAccessing
        func frontmostApplicationPID() -> pid_t? { 100 }
        func awaitComposer(windowID: CGWindowID, mainPid: pid_t) throws {}
        func readComposer(windowID: CGWindowID, mainPid: pid_t) throws -> String {
            lock.lock()
            defer { lock.unlock() }
            return composerText
        }

        func composerElementIfAvailable(windowID: CGWindowID, mainPid: pid_t) -> AXUIElement? {
            AXUIElementCreateApplication(mainPid)
        }

        func writeComposer(_ text: String, windowID: CGWindowID, mainPid: pid_t) throws -> String {
            lock.lock()
            _writes.append(text)
            composerText = text
            lock.unlock()
            return text
        }

        func submitComposer(windowID: CGWindowID, mainPid: pid_t) throws -> String {
            lock.lock()
            let submitted = composerText
            composerText = ""
            lock.unlock()
            return submitted
        }

        func move(windowID: UInt32, toSpaceID targetSpaceID: UInt64) throws {}
    }

    /// The observer seam, recording registrations and letting tests fire value-changed events.
    private final class FakeValueObserver: AgentWindowComposerValueObserving, @unchecked Sendable {
        private let lock = NSLock()
        private var _observed: [pid_t] = []
        private var _handlers: [pid_t: @Sendable () -> Void] = [:]

        var observed: [pid_t] {
            lock.lock()
            defer { lock.unlock() }
            return _observed
        }

        var observedPids: [pid_t] { observed }

        func isObserving(claudeMainPid: pid_t) -> Bool { observed.contains(claudeMainPid) }

        func ensureObserving(
            target: AgentWindowSessionTarget,
            composer: AXUIElement,
            onValueChanged: @escaping @Sendable () -> Void
        ) {
            lock.lock()
            if !_observed.contains(target.claudeMainPid) {
                _observed.append(target.claudeMainPid)
                _handlers[target.claudeMainPid] = onValueChanged
            }
            lock.unlock()
        }

        func stopObserving(claudeMainPid: pid_t) {
            lock.lock()
            _observed.removeAll { $0 == claudeMainPid }
            _handlers[claudeMainPid] = nil
            lock.unlock()
        }

        /// Fires the registered value-changed handler for the pid, as Chromium would.
        func fireValueChanged(claudeMainPid: pid_t) {
            lock.lock()
            let handler = _handlers[claudeMainPid]
            lock.unlock()
            handler?()
        }
    }

    // MARK: - Fixtures

    /// A Desktop-owned session and a terminal-only one, so the disabled path has a real reason rather
    /// than a synthesized code.
    private var processRows: [AgentWindowProcessRow] {
        AgentWindowSessionResolver.parseProcessTable("""
            1     0 /sbin/launchd
          400     1 \(claudeMain)
          420   400 /Users/dev/.local/bin/claude --resume=\(session)
          500     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
          520   500 /Users/dev/.local/bin/claude --resume \(terminalSession)
        """)
    }

    private func snapshot(activeSpaceID: UInt64 = 1, windowSpaceID: UInt64 = 1) -> WorkspaceDesktopSnapshot {
        WorkspaceDesktopSnapshot(
            activeSpaceID: activeSpaceID,
            desktops: [],
            windows: [
                WorkspaceDesktopWindow(
                    windowID: 42,
                    ownerPID: 400,
                    ownerName: "Claude",
                    title: "Claude",
                    spaceIDs: [windowSpaceID],
                    layer: 0,
                    bounds: CGRect(x: 0, y: 0, width: 1200, height: 800),
                    expectation: .otherApp
                )
            ],
            diagnostic: nil
        )
    }

    private func makeCoordinator(
        access: Access,
        observer: FakeValueObserver,
        codexAccess: CodexAccess = CodexAccess(),
        windowSpaceID: UInt64 = 1,
        resolveInterval: TimeInterval = 60
    ) -> AgentWindowComposerCoordinator {
        AgentWindowComposerCoordinator(
            writer: AgentWindowComposerWriter(access: access, placement: access),
            // Always fake: the codex resolution path must never touch the developer's real
            // ~/.codex state or the live ChatGPT.app window headers during unit tests.
            codexWriter: CodexWindowComposerWriter(access: codexAccess, placement: codexAccess),
            codexState: codexAccess,
            codexSummaries: codexAccess,
            audit: StaticWorkspaceDesktopAudit(snapshot(windowSpaceID: windowSpaceID)),
            processRows: { processRows },
            // Long by default so a timer tick never races an assertion about a request-driven emit.
            resolveInterval: resolveInterval,
            observer: observer
        )
    }

    private func decodeStatus(_ json: String) throws -> AgentWindowInputStatus {
        try JSONDecoder().decode(AgentWindowInputStatus.self, from: Data(json.utf8))
    }

    private func decodeResult(_ json: String) throws -> AgentWindowInputResult {
        try JSONDecoder().decode(AgentWindowInputResult.self, from: Data(json.utf8))
    }

    // MARK: - Tests

    @Test func aWatchAnswersOnlyTheSurfaceThatAskedForIt() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let mac = Sink()
        let phone = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.attachSink("phone", emit: phone.emit)

        coordinator.handle(
            .windowInputWatch(subscriptionId: "sub-mac", sessionId: session),
            from: "mac"
        )

        let status = try decodeStatus(await mac.wait(count: 1)[0])
        #expect(status.subscriptionId == "sub-mac")
        #expect(status.sessionId == session)
        #expect(status.enabled)
        #expect(status.onActiveDesktop)
        // Free prefill: the window is already on the active Desktop, so reading it moved nothing.
        #expect(status.composerText == "existing draft")
        // The phone never subscribed. A status addressed to another surface would be adopted as this
        // panel's own field contents, which is the whole reason sinks are addressed rather than fanned.
        #expect(phone.current.isEmpty)

        // The phone subscribes to the SAME session. That re-resolves the window, but the Mac's status did
        // not change, so the Mac must hear nothing: a re-send would rewrite its field under someone typing.
        coordinator.handle(
            .windowInputWatch(subscriptionId: "sub-phone", sessionId: session),
            from: "phone"
        )
        _ = await phone.wait(count: 1)
        // A second Mac watch is the barrier: it is queued behind the phone's, so whatever the Mac's next
        // message is settles whether a spurious duplicate slipped in ahead of it.
        coordinator.handle(
            .windowInputWatch(subscriptionId: "sub-mac-2", sessionId: terminalSession),
            from: "mac"
        )
        let next = try decodeStatus(await mac.wait(count: 2)[1])
        #expect(next.subscriptionId == "sub-mac-2")
    }

    @Test func aTerminalSessionIsReportedUnavailableWithItsOwnReason() async throws {
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: Access(), observer: observer)
        let phone = Sink()
        coordinator.attachSink("phone", emit: phone.emit)

        coordinator.handle(
            .windowInputWatch(subscriptionId: "sub-phone", sessionId: terminalSession),
            from: "phone"
        )

        let status = try decodeStatus(await phone.wait(count: 1)[0])
        #expect(!status.enabled)
        #expect(status.reason == AgentWindowInputReason.terminalOnly.rawValue)
        #expect(status.composerText == nil)
    }

    @Test func aWriteAnswersItsRequesterAndRefreshesEveryOtherWatcherOfTheSameSession() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let mac = Sink()
        let phone = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.attachSink("phone", emit: phone.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-phone", sessionId: session), from: "phone")
        _ = await mac.wait(count: 1)
        _ = await phone.wait(count: 1)

        coordinator.handle(
            .windowInputSync(requestId: "sync-1", sessionId: session, text: "review the diff"),
            from: "phone"
        )

        // The requester gets the result, carrying the read-back that proves the write landed.
        let result = try decodeResult(await phone.wait(count: 2)[1])
        #expect(result.requestId == "sync-1")
        #expect(result.ok)
        #expect(result.text == "review the diff")
        #expect(access.writes == ["review the diff"])
        // The write itself fired the value-changed event in Chromium; the coordinator's event-driven
        // refresh is what tells the Mac, which never saw the request but is showing the same window.
        observer.fireValueChanged(claudeMainPid: 400)
        let refreshed = try decodeStatus(await mac.wait(count: 2)[1])
        #expect(refreshed.composerText == "review the diff")
        // No result was addressed to the Mac: it did not ask, and a result would resolve a request id
        // it never issued.
        #expect(mac.current.allSatisfy { $0.contains("agent-window-input-status") })
    }

    @Test func aDetachedSurfaceCannotStillWriteIntoAnotherApplicationsWindow() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let phone = Sink()
        coordinator.attachSink("phone", emit: phone.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-phone", sessionId: session), from: "phone")
        _ = await phone.wait(count: 1)

        coordinator.detachSink("phone")
        coordinator.handle(
            .windowInputSync(requestId: "sync-2", sessionId: session, text: "should not land"),
            from: "phone"
        )
        // A watch from a live surface, queued behind the sync on the same serial queue, is what proves
        // the sync had already been processed rather than merely not arrived yet.
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)

        // The phone's panel is gone, so a fill nobody can be told about is an unobservable edit to
        // another application's window. Refusing beats writing blind.
        #expect(access.writes.isEmpty)
        #expect(phone.current.count == 1)
    }

    @Test func aSubmitAnswersItsRequesterAndClearsItsComposer() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let phone = Sink()
        coordinator.attachSink("phone", emit: phone.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-phone", sessionId: session), from: "phone")
        _ = await phone.wait(count: 1)

        coordinator.handle(
            .windowInputSubmit(requestId: "submit-1", sessionId: session, text: "run the tests"),
            from: "phone"
        )

        // A successful commit clears the composer, so the result's read-back is the emptied field.
        let result = try decodeResult(await phone.wait(count: 2)[1])
        #expect(result.requestId == "submit-1")
        #expect(result.ok)
        #expect(result.text == "run the tests")
        #expect(access.writes == ["run the tests"])
        #expect(access.composerText == "")
        // The cleared field arrives as the value-changed event, exactly as in the real window.
        observer.fireValueChanged(claudeMainPid: 400)
        let refreshed = try decodeStatus(await phone.wait(count: 3)[2])
        #expect(refreshed.composerText == "")
    }

    @Test func anUnchangedPollStaysSilentButARealChangeIsAnnounced() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer, resolveInterval: 0.02)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)
        #expect(observer.observed == [400])

        // Many polls over an unchanged window. Every one of them re-resolves, and every one must stay
        // silent: a status that repeats itself would keep rewriting the panel's field from the window
        // while the viewer is typing into it. The observer carries the text, so the poll reads nothing.
        try await Task.sleep(for: .milliseconds(150))
        #expect(mac.current.count == 1)

        // Someone types in the real Claude window. The value-changed event has to say so, or the panel
        // would go on showing text the window no longer holds.
        access.composerText = "typed in the real window"
        observer.fireValueChanged(claudeMainPid: 400)
        let messages = await mac.wait(count: 2)
        let updated = try decodeStatus(messages[1])
        #expect(updated.composerText == "typed in the real window")
    }

    @Test func anObservedPassReadsNothingBecauseTheObserverCarriesText() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer, resolveInterval: 0.02)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)
        let readsAfterRegistration = access.readCount

        // Poll passes keep re-resolving, but with the observer live they read nothing: the events
        // carry the text, and a poll read would be exactly the continuous AX traffic focus gating
        // exists to remove.
        try await Task.sleep(for: .milliseconds(150))
        #expect(access.readCount == readsAfterRegistration)
    }

    @Test func anUnwatchThatEmptiesSubscriptionsStopsObserving() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)
        #expect(observer.observed == [400])

        // A blur unwatches everything; the AX events must stop with it, or the host keeps Chromium's
        // observer alive with no panel listening.
        coordinator.handle(.windowInputUnwatch(subscriptionId: "sub-mac"), from: "mac")
        try await Task.sleep(for: .milliseconds(50))
        #expect(observer.observed.isEmpty)
    }

    @Test func aTransientReadFailureKeepsTheLastTextAndDropsTheDeadObserver() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer, resolveInterval: 0.02)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)

        // The window's web contents rebuilds its tree, so the event's read fails. The field must not
        // flicker to nil: the window is still there, and a nil text is adopted by the panel as its own
        // contents. The last known text keeps the field stable -- and the registration on the dead
        // element is dropped so the next poll re-registers on the respawned one.
        access.readError = .composerMissing
        access.composerText = "changed in the real window"
        observer.fireValueChanged(claudeMainPid: 400)
        try await Task.sleep(for: .milliseconds(100))
        #expect(mac.current.count == 1)
        #expect(observer.observed.isEmpty)

        // The tree is back; the poll pass re-registers and announces the real change.
        access.readError = nil
        let messages = await mac.wait(count: 2)
        let updated = try decodeStatus(messages[1])
        #expect(updated.composerText == "changed in the real window")
        #expect(observer.observed == [400])
    }

    // MARK: - AskUserQuestion mirror addressing

    private func decodeQuestionStatus(_ json: String) throws -> AgentWindowQuestionStatus {
        try JSONDecoder().decode(AgentWindowQuestionStatus.self, from: Data(json.utf8))
    }

    private func decodeQuestionResult(_ json: String) throws -> AgentWindowQuestionResult {
        try JSONDecoder().decode(AgentWindowQuestionResult.self, from: Data(json.utf8))
    }

    @Test func aQuestionWatchAnswersOnlyTheSurfaceThatAskedForIt() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let mac = Sink()
        let phone = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.attachSink("phone", emit: phone.emit)

        coordinator.handle(
            .questionWatch(subscriptionId: "q-mac", sessionId: session),
            from: "mac"
        )

        let status = try decodeQuestionStatus(await mac.wait(count: 1)[0])
        #expect(status.subscriptionId == "q-mac")
        #expect(status.sessionId == session)
        #expect(status.enabled)
        #expect(status.onActiveDesktop)
        // The augmentation, never content: presence and live state only.
        #expect(status.present == true)
        #expect(status.selected == [])
        #expect(status.submitEnabled == false)
        // The phone never subscribed; nothing fans out to it.
        #expect(phone.current.isEmpty)
    }

    @Test func aQuestionWatchOnAnotherDesktopReportsPresentNilRatherThanAbsence() async throws {
        // The window's AX tree does not exist off the active Desktop, so the mirror cannot be told the
        // panel is absent -- it keeps its JSON content and learns nothing about presence.
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: Access(), observer: observer, windowSpaceID: 4)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(
            .questionWatch(subscriptionId: "q-mac", sessionId: session),
            from: "mac"
        )

        let status = try decodeQuestionStatus(await mac.wait(count: 1)[0])
        #expect(status.enabled)
        #expect(!status.onActiveDesktop)
        #expect(status.present == nil)
    }

    @Test func aQuestionWatchForATerminalSessionIsReportedUnavailable() async throws {
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: Access(), observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(
            .questionWatch(subscriptionId: "q-mac", sessionId: terminalSession),
            from: "mac"
        )

        let status = try decodeQuestionStatus(await mac.wait(count: 1)[0])
        #expect(!status.enabled)
        #expect(status.reason == AgentWindowInputReason.terminalOnly.rawValue)
    }

    @Test func aQuestionStatusChangesEmitButAnUnchangedPollStaysSilent() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer, resolveInterval: 0.02)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.questionWatch(subscriptionId: "q-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)

        // The panel disappears from the window (answered or dismissed in the real window). The next
        // poll emits the change; an unchanged state after that stays silent.
        access.questionState = .absent
        let first = try decodeQuestionStatus(await mac.wait(count: 2)[1])
        #expect(first.present == false)
        try await Task.sleep(for: .milliseconds(100))
        #expect(mac.current.count == 2)
    }

    @Test func aQuestionActionAnswersItsRequesterWithThePostActionState() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let mac = Sink()
        let phone = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.attachSink("phone", emit: phone.emit)

        coordinator.handle(
            .questionAction(
                requestId: "q-1",
                sessionId: session,
                kind: .select,
                optionIndex: 1,
                desired: true,
                otherText: nil
            ),
            from: "mac"
        )

        let result = try decodeQuestionResult(await mac.wait(count: 1)[0])
        #expect(result.ok)
        #expect(result.selected == [1])
        #expect(result.submitEnabled == true)
        #expect(result.present == true)
        // The phone never asked; nothing is fanned out to it.
        #expect(phone.current.isEmpty)
    }

    @Test func aQuestionActionThatFindsNoPanelReportsTheReason() async throws {
        let access = Access()
        access.questionActionError = .questionMissing
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(
            .questionAction(
                requestId: "q-1",
                sessionId: session,
                kind: .dismiss,
                optionIndex: nil,
                desired: nil,
                otherText: nil
            ),
            from: "mac"
        )

        let result = try decodeQuestionResult(await mac.wait(count: 1)[0])
        #expect(!result.ok)
        #expect(result.reason == AgentWindowInputReason.questionMissing.rawValue)
    }

    @Test func aQuestionActionWithoutASinkIsDropped() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer)

        // No surface attached: nothing answers, so the panel's request times out rather than being
        // answered by a stale sink (the same rule the composer submit path applies).
        coordinator.handle(
            .questionAction(
                requestId: "q-1",
                sessionId: session,
                kind: .submit,
                optionIndex: nil,
                desired: nil,
                otherText: nil
            ),
            from: "mac"
        )
        try await Task.sleep(for: .milliseconds(50))
    }

    @Test func unwatchingAQuestionStopsItsPollButNotAnUnrelatedComposerWatch() async throws {
        let access = Access()
        let observer = FakeValueObserver()
        let coordinator = makeCoordinator(access: access, observer: observer, resolveInterval: 0.02)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)
        coordinator.handle(.questionWatch(subscriptionId: "q-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 1)
        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: session), from: "mac")
        _ = await mac.wait(count: 2)

        // Unwatching the question leaves the composer watch polling; the poll timer must survive.
        coordinator.handle(.questionUnwatch(subscriptionId: "q-mac"), from: "mac")
        try await Task.sleep(for: .milliseconds(100))
        // Only the composer status was emitted by the still-live poll; the question stays silent.
        let last = try decodeStatus(mac.current.last!)
        #expect(last.subscriptionId == "sub-mac")
    }

    // MARK: - Codex Desktop addressing

    private let codexSession = "019fe292-5466-7393-b931-8bf0c2cece82"
    private let codexMain = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
    private let codexFrame = CGRect(x: 100, y: 100, width: 830, height: 877)

    private func codexRecord(
        title: String = "find stream details",
        cwd: String = "/Users/dev/Documents/Codex/2026-08-08/str"
    ) -> CodexThreadRecord {
        CodexThreadRecord(threadId: codexSession, title: title, cwd: cwd)
    }

    private func codexSummary(
        windowID: CGWindowID = 77,
        title: String = "Find stream details",
        project: String = "",
        recentsFirstRow: String? = "Find stream details",
        frame: CGRect? = nil
    ) -> CodexWindowSummary {
        CodexWindowSummary(
            windowID: windowID,
            threadTitle: title,
            projectName: project,
            recentsFirstRow: recentsFirstRow,
            frame: frame ?? codexFrame
        )
    }

    private func codexSnapshot(activeSpaceID: UInt64 = 1, windowSpaceID: UInt64 = 1) -> WorkspaceDesktopSnapshot {
        WorkspaceDesktopSnapshot(
            activeSpaceID: activeSpaceID,
            desktops: [],
            windows: [
                WorkspaceDesktopWindow(
                    windowID: 42,
                    ownerPID: 400,
                    ownerName: "Claude",
                    title: "Claude",
                    spaceIDs: [windowSpaceID],
                    layer: 0,
                    bounds: CGRect(x: 0, y: 0, width: 1200, height: 800),
                    expectation: .otherApp
                ),
                WorkspaceDesktopWindow(
                    windowID: 77,
                    ownerPID: 700,
                    ownerName: "ChatGPT",
                    title: "ChatGPT",
                    spaceIDs: [windowSpaceID],
                    layer: 0,
                    bounds: codexFrame,
                    expectation: .otherApp
                )
            ],
            diagnostic: nil
        )
    }

    private func makeCodexCoordinator(
        codexAccess: CodexAccess,
        observer: FakeValueObserver,
        windowSpaceID: UInt64 = 1
    ) -> AgentWindowComposerCoordinator {
        AgentWindowComposerCoordinator(
            writer: AgentWindowComposerWriter(access: Access(), placement: Access()),
            codexWriter: CodexWindowComposerWriter(access: codexAccess, placement: codexAccess),
            codexState: codexAccess,
            codexSummaries: codexAccess,
            audit: StaticWorkspaceDesktopAudit(codexSnapshot(windowSpaceID: windowSpaceID)),
            processRows: { codexProcessRows },
            resolveInterval: 60,
            observer: observer
        )
    }

    /// A codex thread id never appears in a `--resume=` argv, so the claude resolver reports
    /// not-running and the coordinator falls through to the Codex Desktop resolution path.
    private var codexProcessRows: [AgentWindowProcessRow] {
        AgentWindowSessionResolver.parseProcessTable("""
            1     0 /sbin/launchd
            700     1 \(codexMain)
        """)
    }

    @Test func aCodexSessionResolvesThroughTheCodexWriterAndReadsFree() async throws {
        let codex = CodexAccess()
        codex.record = codexRecord()
        codex.threadNameValue = "Find stream details"
        // A Recents-opened thread: no header project, the window's Recents first row is the identity.
        codex.summaries = [codexSummary()]
        let observer = FakeValueObserver()
        let coordinator = makeCodexCoordinator(codexAccess: codex, observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: codexSession), from: "mac")

        let status = try decodeStatus(await mac.wait(count: 1)[0])
        #expect(status.enabled)
        // The codex tree is readable on any Desktop, so the free read prefills without a move.
        #expect(status.composerText == "existing codex draft")
        #expect(observer.observed == [700])

        // A sync dispatches to the codex writer, not the claude one.
        coordinator.handle(.windowInputSync(requestId: "r-1", sessionId: codexSession, text: "typed here"), from: "mac")
        let result = try decodeResult(await mac.wait(count: 2)[1])
        #expect(result.ok)
        #expect(result.text == "typed here")
        #expect(codex.writes == ["typed here"])
    }

    @Test func aCodexThreadShownInTwoWindowsIsRefusedRatherThanGuessed() async throws {
        let codex = CodexAccess()
        codex.record = codexRecord()
        codex.threadNameValue = "New chat"
        // Two windows, same generic Recents first row: the write cannot be addressed.
        codex.summaries = [
            codexSummary(title: "New chat", recentsFirstRow: "New chat"),
            codexSummary(windowID: 78, title: "New chat", recentsFirstRow: "New chat", frame: CGRect(x: 1000, y: 100, width: 830, height: 877)),
        ]
        let observer = FakeValueObserver()
        let coordinator = makeCodexCoordinator(codexAccess: codex, observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: codexSession), from: "mac")

        let status = try decodeStatus(await mac.wait(count: 1)[0])
        #expect(!status.enabled)
        #expect(status.reason == AgentWindowInputReason.ambiguousWindow.rawValue)
    }

    @Test func aCodexSessionFallsThroughToNotRunningWhenTheAppDoesNotKnowTheThread() async throws {
        let codex = CodexAccess()
        // No registry row: the app does not know this thread, so it is not open anywhere.
        codex.record = nil
        let observer = FakeValueObserver()
        let coordinator = makeCodexCoordinator(codexAccess: codex, observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(.windowInputWatch(subscriptionId: "sub-mac", sessionId: codexSession), from: "mac")

        let status = try decodeStatus(await mac.wait(count: 1)[0])
        #expect(!status.enabled)
        #expect(status.reason == AgentWindowInputReason.notRunning.rawValue)
    }

    @Test func aCodexQuestionWatchIsReportedUnavailable() async throws {
        // The AskUserQuestion mirror is Claude Desktop-only; a codex session's question watch must
        // resolve to a disabled status rather than reaching a claude writer with a codex target.
        let codex = CodexAccess()
        codex.record = codexRecord()
        codex.summaries = [codexSummary()]
        let observer = FakeValueObserver()
        let coordinator = makeCodexCoordinator(codexAccess: codex, observer: observer)
        let mac = Sink()
        coordinator.attachSink("mac", emit: mac.emit)

        coordinator.handle(.questionWatch(subscriptionId: "q-mac", sessionId: codexSession), from: "mac")

        let status = try decodeQuestionStatus(await mac.wait(count: 1)[0])
        #expect(!status.enabled)
        #expect(status.reason == AgentWindowInputReason.questionMissing.rawValue)
    }
}
