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
        windowSpaceID: UInt64 = 1,
        resolveInterval: TimeInterval = 60
    ) -> AgentWindowComposerCoordinator {
        AgentWindowComposerCoordinator(
            writer: AgentWindowComposerWriter(access: access, placement: access),
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
}
