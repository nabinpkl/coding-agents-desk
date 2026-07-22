import AppKit
import ApplicationServices
import Foundation
import PtyClientSwift
import TerminalEmulator

private enum HarnessPhase: String { case initial, restore }

private struct HarnessArguments {
    let socketPath: String
    let artifactDirectory: URL
    let phase: HarnessPhase

    init() throws {
        var values = Array(CommandLine.arguments.dropFirst())
        func value(after flag: String) throws -> String {
            guard let index = values.firstIndex(of: flag), values.indices.contains(index + 1) else {
                throw HarnessError.message("missing \(flag)")
            }
            let value = values[index + 1]
            values.removeSubrange(index...(index + 1))
            return value
        }
        socketPath = try value(after: "--socket")
        artifactDirectory = URL(fileURLWithPath: try value(after: "--artifacts"), isDirectory: true)
        guard let phase = HarnessPhase(rawValue: try value(after: "--phase")) else {
            throw HarnessError.message("invalid --phase")
        }
        self.phase = phase
    }
}

private enum HarnessError: Error, CustomStringConvertible {
    case message(String)
    var description: String {
        switch self { case .message(let message): return message }
    }
}

private struct InitialState: Codable {
    let sessionName: String
    let ptyPID: UInt32
    let columns: UInt32
    let rows: UInt32
    let revision: UInt64
    let screenshots: [String]
    let slowClientResynchronized: Bool
    let narrowWindowBelowFormerMinimum: Bool
    let narrowViewportCroppedAtReadableScale: Bool
    let ownershipEpoch: UInt64
    let passiveResizePreservedSource: Bool
    let ownerResizeAdvancedOnce: Bool
    let inactiveInputClaimedBeforeOutput: Bool
}

private struct FinalResult: Codable {
    let passed: Bool
    let sessionName: String
    let ptyPIDBefore: UInt32
    let ptyPIDAfter: UInt32
    let columns: UInt32
    let rows: UInt32
    let revisionBeforeRestart: UInt64
    let revisionAfterRestart: UInt64
    let restoredWindowCount: Int
    let restoredWithoutFocusTheft: Bool
    let slowClientResynchronizedWithoutReconnect: Bool
    let narrowWindowBelowFormerMinimum: Bool
    let narrowViewportCroppedAtReadableScale: Bool
    let ownershipEpochBeforeRestart: UInt64
    let ownerClientIDAfterRestore: UInt64
    let passiveResizePreservedSource: Bool
    let ownerResizeAdvancedOnce: Bool
    let inactiveInputClaimedBeforeOutput: Bool
    let screenshots: [String]
    let cleanup: String
}

private actor EventProbe {
    struct Snapshot {
        var checkpointCount = 0
        var checkpointRevision: UInt64 = 0
        var lastOutputRevision: UInt64 = 0
        var consecutive = true
    }

    private var snapshot = Snapshot()

    func consume(_ connection: PtySessionConnection) async {
        do {
            for try await event in connection.events() {
                switch event {
                case .checkpointEnded(_, let revision):
                    snapshot.checkpointCount += 1
                    snapshot.checkpointRevision = revision
                    snapshot.lastOutputRevision = revision
                    snapshot.consecutive = true
                case .output(_, let revision):
                    if snapshot.lastOutputRevision > 0,
                       revision != snapshot.lastOutputRevision + 1 {
                        snapshot.consecutive = false
                    }
                    snapshot.lastOutputRevision = revision
                default:
                    break
                }
            }
        } catch {
            snapshot.consecutive = false
        }
    }

    func current() -> Snapshot { snapshot }
}

@MainActor
private final class HarnessDelegate: NSObject, NSApplicationDelegate {
    private let arguments: HarnessArguments
    private let client: PtyClient
    private let store: TerminalWindowPresentationStore
    private let spawner: SwiftTermPtyManagerTerminalSpawn
    private var registry: TerminalWindowRegistry?
    private var retainedWindows: [TerminalEmulatorWindow] = []
    private var retainedConnections: [PtySessionConnection] = []
    private var eventTasks: [Task<Void, Never>] = []

    init(arguments: HarnessArguments) {
        self.arguments = arguments
        client = PtyClient(socketPath: arguments.socketPath)
        store = TerminalWindowPresentationStore(
            url: arguments.artifactDirectory.appendingPathComponent("presentations.json")
        )
        spawner = SwiftTermPtyManagerTerminalSpawn(
            client: PtyClient(socketPath: arguments.socketPath),
            shell: "/bin/bash"
        )
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task { @MainActor in
            do {
                try preflight()
                switch arguments.phase {
                case .initial: try await runInitial()
                case .restore: try await runRestore()
                }
                NSApplication.shared.terminate(nil)
            } catch {
                let line = "terminal-replay-harness: FAIL: \(error)\n"
                FileHandle.standardError.write(Data(line.utf8))
                try? Data("{\"passed\":false,\"error\":\"\(jsonEscaped(String(describing: error)))\"}\n".utf8)
                    .write(to: arguments.artifactDirectory.appendingPathComponent("result.json"), options: .atomic)
                exit(1)
            }
        }
    }

    private func preflight() throws {
        guard AXIsProcessTrusted() else {
            throw HarnessError.message("Accessibility permission is not provisioned")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw HarnessError.message("Screen Recording permission is not provisioned")
        }
        try FileManager.default.createDirectory(
            at: arguments.artifactDirectory,
            withIntermediateDirectories: true
        )
    }

    private func runInitial() async throws {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
        let sessionName = "terminal-replay-e2e"
        let controller = try await client.openSession(
            name: sessionName,
            launch: .command(
                cwd: FileManager.default.currentDirectoryPath,
                executable: "/bin/bash",
                arguments: ["--noprofile", "--norc"]
            ),
            lifetime: .persistent,
            columns: 100,
            rows: 30,
            createIfMissing: true,
            clientTitle: "E2E Controller"
        )
        retainAndConsume(controller)

        let windowRegistry = TerminalWindowRegistry(
            store: store,
            client: client,
            spawn: spawner,
            loggerSubsystem: "com.example.agentdesk.AgentDeskTerminalReplayE2E"
        )
        registry = windowRegistry
        var summary = try await requireSession(named: sessionName)
        let wide = try await spawn(summary, frame: CGRect(x: 80, y: 160, width: 920, height: 620))
        retainedWindows.append(wide)
        windowRegistry.register(
            wide,
            sessionName: sessionName,
            workspaceID: nil,
            workspaceLabel: "Harness Wide",
            cascadeOrdinal: 0
        )
        try await send(
            "printf '\\033[2J\\033[H\\033[38;2;80;180;255mHEADLESS-PRIMARY\\033[0m\\n'; " +
            "for i in {1..60}; do printf 'history-%03d unicode-λ-界\\n' \"$i\"; done; " +
            "printf '\\033[4;10Hcursor-marker\\n'",
            through: controller
        )
        wide.raise()
        try await waitForWindows([wide], session: sessionName)
        let wideOwner = try await waitForOwner(wide, session: sessionName)
        guard wideOwner.sourceColumns == wideOwner.viewColumns,
              wideOwner.sourceRows == wideOwner.viewRows else {
            throw HarnessError.message("selected first window did not size the PTY to its viewport")
        }
        try await controller.updateViewerState(
            sequence: 1,
            active: false,
            claim: false,
            columns: 100,
            rows: 30
        )
        var screenshots = [try capture(wide, named: "01-before")]

        try send(
            "printf '\\033[?1049h\\033[2J\\033[H\\033[1;35mALTERNATE-SCREEN\\033[0m\\nlate-join-marker\\n'",
            through: wide
        )
        summary = try await requireSession(named: sessionName)
        let narrow = try await spawn(summary, frame: CGRect(x: 1020, y: 220, width: 360, height: 240))
        retainedWindows.append(narrow)
        windowRegistry.register(
            narrow,
            sessionName: sessionName,
            workspaceID: nil,
            workspaceLabel: "Harness Narrow",
            cascadeOrdinal: 1
        )
        (narrow as? any TerminalWindowPresentationTrackable)?.orderWithoutFocus()
        try await waitForWindows([wide, narrow], session: sessionName)
        let diagnostics = try requireMatchingDiagnostics([wide, narrow])
        guard diagnostics[0].isOwner, !diagnostics[1].isOwner else {
            throw HarnessError.message("late attachment changed terminal ownership")
        }
        guard diagnostics[0].fitScale != diagnostics[1].fitScale else {
            throw HarnessError.message("differently sized clients did not use different fit scales")
        }
        guard diagnostics[1].viewportCropped,
              abs(diagnostics[1].fitScale - 0.75) < 0.001 else {
            throw HarnessError.message("narrow client did not crop at the readable scale floor")
        }
        guard let narrowFrame = (narrow as? any TerminalWindowPresentationTrackable)?.currentFrame,
              narrowFrame.width < 480,
              narrowFrame.height < 320 else {
            throw HarnessError.message("narrow terminal retained the former 480x320 minimum")
        }
        screenshots.append(try capture(wide, named: "02-late-join-wide"))
        screenshots.append(try capture(narrow, named: "02-late-join-narrow"))

        guard let narrowInspectable = narrow as? any TerminalWindowReplayInspectable,
              let wideInspectable = wide as? any TerminalWindowReplayInspectable else {
            throw HarnessError.message("terminal windows do not expose replay diagnostics")
        }
        narrowInspectable.claimViewportForReplay()
        let narrowOwner = try await waitForOwner(narrow, session: sessionName)
        try await waitForWindows([wide, narrow], session: sessionName)
        guard narrowOwner.sourceColumns == narrowOwner.viewColumns,
              narrowOwner.sourceRows == narrowOwner.viewRows,
              narrowOwner.ownershipEpoch > wideOwner.ownershipEpoch else {
            throw HarnessError.message("second window claim did not become authoritative")
        }
        screenshots.append(try capture(narrow, named: "03-second-owner"))

        let sourceBeforePassiveResize = (narrowOwner.sourceColumns, narrowOwner.sourceRows)
        wide.place(into: CGRect(x: 80, y: 160, width: 560, height: 360))
        try await Task.sleep(nanoseconds: 300_000_000)
        let afterPassiveResize = try await waitForOwner(narrow, session: sessionName)
        guard (afterPassiveResize.sourceColumns, afterPassiveResize.sourceRows) == sourceBeforePassiveResize else {
            throw HarnessError.message(
                "passive resize of inactive viewer changed the source grid " +
                "from \(sourceBeforePassiveResize.0)x\(sourceBeforePassiveResize.1) " +
                "to \(afterPassiveResize.sourceColumns)x\(afterPassiveResize.sourceRows)"
            )
        }

        let revisionBeforeOwnerResize = (try await requireSession(named: sessionName)).revision
        narrow.place(into: CGRect(x: 760, y: 220, width: 620, height: 420))
        try await Task.sleep(nanoseconds: 300_000_000)
        let resizedOwner = try await waitForOwner(narrow, session: sessionName)
        try await waitForWindows([wide, narrow], session: sessionName)
        let revisionAfterOwnerResize = (try await requireSession(named: sessionName)).revision
        guard resizedOwner.sourceColumns == resizedOwner.viewColumns,
              resizedOwner.sourceRows == resizedOwner.viewRows,
              resizedOwner.sourceRevision == revisionBeforeOwnerResize + 1 else {
            throw HarnessError.message(
                "owner resize was not applied exactly once: " +
                "source revision \(revisionBeforeOwnerResize)->\(resizedOwner.sourceRevision), " +
                "observed revision \(revisionAfterOwnerResize), " +
                "source \(resizedOwner.sourceColumns)x\(resizedOwner.sourceRows), " +
                "view \(resizedOwner.viewColumns)x\(resizedOwner.viewRows)"
            )
        }
        screenshots.append(try capture(narrow, named: "04-owner-resize"))

        wideInspectable.sendInputForReplay("printf '\\033[6;1HINACTIVE-CLAIM-LIVE\\n'\n")
        let reclaimedWide = try await waitForOwner(wide, session: sessionName)
        try await waitForWindows([wide, narrow], session: sessionName)
        guard reclaimedWide.ownershipEpoch > resizedOwner.ownershipEpoch else {
            throw HarnessError.message("input through inactive viewer did not claim first")
        }

        try send("printf '\\033[7;1HLIVE-TAIL\\n'", through: wide)
        try await waitForWindows([wide, narrow], session: sessionName)

        let slow = try await client.openSession(
            name: sessionName,
            launch: .shell(cwd: summary.cwd, shell: summary.shell),
            lifetime: .persistent,
            columns: 1,
            rows: 1,
            createIfMissing: false,
            clientTitle: "E2E Slow Client"
        )
        retainedConnections.append(slow)
        try send(
            "python3 -c 'import sys; sys.stdout.write(\"flood\\n\" * 120000)'; printf 'FLOOD-END\\n'",
            through: wide
        )
        try await Task.sleep(nanoseconds: 500_000_000)
        let slowProbe = EventProbe()
        let slowTask = Task { await slowProbe.consume(slow) }
        eventTasks.append(slowTask)
        try await wait(timeoutSeconds: 12) {
            let state = await slowProbe.current()
            return state.checkpointCount >= 2 && state.consecutive
        }
        try await sendLiveTailAfterLatestCheckpoint(through: wide, observedBy: slowProbe)
        screenshots.append(try capture(narrow, named: "05-slow-resync"))

        summary = try await requireSession(named: sessionName)
        let initial = InitialState(
            sessionName: sessionName,
            ptyPID: summary.pid,
            columns: summary.columns,
            rows: summary.rows,
            revision: summary.revision,
            screenshots: screenshots,
            slowClientResynchronized: true,
            narrowWindowBelowFormerMinimum: true,
            narrowViewportCroppedAtReadableScale: true,
            ownershipEpoch: reclaimedWide.ownershipEpoch,
            passiveResizePreservedSource: true,
            ownerResizeAdvancedOnce: true,
            inactiveInputClaimedBeforeOutput: true
        )
        try JSONEncoder.pretty.encode(initial).write(
            to: arguments.artifactDirectory.appendingPathComponent("initial-state.json"),
            options: .atomic
        )
        windowRegistry.prepareForHostTermination()
        try await Task.sleep(nanoseconds: 300_000_000)
    }

    private func runRestore() async throws {
        NSApplication.shared.setActivationPolicy(.accessory)
        let initialData = try Data(contentsOf: arguments.artifactDirectory.appendingPathComponent("initial-state.json"))
        let initial = try JSONDecoder().decode(InitialState.self, from: initialData)
        let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let windowRegistry = TerminalWindowRegistry(
            store: store,
            client: client,
            spawn: spawner,
            loggerSubsystem: "com.example.agentdesk.AgentDeskTerminalReplayE2E"
        )
        registry = windowRegistry
        let retainedSource = try await requireSession(named: initial.sessionName)
        windowRegistry.startRestoration()
        do {
            try await wait(timeoutSeconds: 12) {
                let diagnostics = windowRegistry.openWindowDiagnostics
                return diagnostics.count == 2 && diagnostics.values.allSatisfy {
                    !$0.synchronizing
                        && $0.columns == retainedSource.columns
                        && $0.rows == retainedSource.rows
                }
            }
        } catch {
            let diagnostics = windowRegistry.openWindowDiagnostics.values.map {
                "sync=\($0.synchronizing) grid=\($0.columns)x\($0.rows) " +
                "source=\($0.sourceColumns)x\($0.sourceRows) owner=\($0.ownerClientID)"
            }.joined(separator: "; ")
            throw HarnessError.message("restored windows did not converge: \(diagnostics)")
        }
        let summary = try await requireSession(named: initial.sessionName)
        guard summary.pid == initial.ptyPID else {
            throw HarnessError.message("PTY PID changed across test-host restart")
        }
        let frontmostAfter = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let restoredWindows = NSApplication.shared.windows
            .filter { $0.isVisible && $0.windowNumber > 0 }
            .sorted { $0.frame.minX < $1.frame.minX }
        guard restoredWindows.count >= 2 else {
            throw HarnessError.message("restored windows are not visible")
        }
        var screenshots = initial.screenshots
        for (index, window) in restoredWindows.prefix(2).enumerated() {
            screenshots.append(try capture(windowID: UInt32(window.windowNumber), named: "05-post-restart-\(index + 1)"))
        }
        let presentationData = try Data(
            contentsOf: arguments.artifactDirectory.appendingPathComponent("presentations.json")
        )
        for forbidden in ["HEADLESS-PRIMARY", "late-join-marker", "SLOW-RESYNC-LIVE", "\\u001b"] {
            guard !presentationData.contains(Data(forbidden.utf8)) else {
                throw HarnessError.message("presentation metadata contains terminal payload")
            }
        }
        let result = FinalResult(
            passed: true,
            sessionName: initial.sessionName,
            ptyPIDBefore: initial.ptyPID,
            ptyPIDAfter: summary.pid,
            columns: summary.columns,
            rows: summary.rows,
            revisionBeforeRestart: initial.revision,
            revisionAfterRestart: summary.revision,
            restoredWindowCount: windowRegistry.openWindowDiagnostics.count,
            restoredWithoutFocusTheft: frontmostBefore == frontmostAfter,
            slowClientResynchronizedWithoutReconnect: initial.slowClientResynchronized,
            narrowWindowBelowFormerMinimum: initial.narrowWindowBelowFormerMinimum,
            narrowViewportCroppedAtReadableScale: initial.narrowViewportCroppedAtReadableScale,
            ownershipEpochBeforeRestart: initial.ownershipEpoch,
            ownerClientIDAfterRestore: summary.ownerClientID,
            passiveResizePreservedSource: initial.passiveResizePreservedSource,
            ownerResizeAdvancedOnce: initial.ownerResizeAdvancedOnce,
            inactiveInputClaimedBeforeOutput: initial.inactiveInputClaimedBeforeOutput,
            screenshots: screenshots,
            cleanup: "pending harness cleanup"
        )
        guard result.restoredWithoutFocusTheft else {
            throw HarnessError.message("restoration changed the frontmost application")
        }
        guard result.ownerClientIDAfterRestore == 0 else {
            throw HarnessError.message("restored windows stole terminal ownership")
        }
        try JSONEncoder.pretty.encode(result).write(
            to: arguments.artifactDirectory.appendingPathComponent("result.json"),
            options: .atomic
        )
        windowRegistry.prepareForHostTermination()
        try await Task.sleep(nanoseconds: 300_000_000)
    }

    private func spawn(_ session: PtySessionSummary, frame: CGRect) async throws -> TerminalEmulatorWindow {
        try await withCheckedThrowingContinuation { continuation in
            spawner.spawnExistingSession(session, into: frame) { result in
                continuation.resume(with: result)
            }
        }
    }

    private func retainAndConsume(_ connection: PtySessionConnection) {
        retainedConnections.append(connection)
        let probe = EventProbe()
        eventTasks.append(Task { await probe.consume(connection) })
    }

    private func send(_ command: String, through connection: PtySessionConnection) async throws {
        try await connection.sendInput(Data((command + "\n").utf8))
    }

    private func send(_ command: String, through window: TerminalEmulatorWindow) throws {
        guard let inspectable = window as? any TerminalWindowReplayInspectable else {
            throw HarnessError.message("terminal window does not support replay input")
        }
        inspectable.sendInputForReplay(command + "\n")
    }

    private func sendLiveTailAfterLatestCheckpoint(
        through window: TerminalEmulatorWindow,
        observedBy probe: EventProbe
    ) async throws {
        let deadline = Date().addingTimeInterval(12)
        var attempt = 1
        while Date() < deadline {
            let baseline = await probe.current().lastOutputRevision
            try send("printf 'SLOW-RESYNC-LIVE-\(attempt)\\n'", through: window)

            let attemptDeadline = min(Date().addingTimeInterval(0.75), deadline)
            while Date() < attemptDeadline {
                let state = await probe.current()
                if state.consecutive,
                   state.lastOutputRevision > baseline,
                   state.lastOutputRevision > state.checkpointRevision {
                    return
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            attempt += 1
        }
        throw HarnessError.message("slow client did not receive live output after its latest checkpoint")
    }

    private func requireSession(named name: String) async throws -> PtySessionSummary {
        try await wait(timeoutSeconds: 8) {
            guard let sessions = try? await self.client.listSessions() else { return false }
            return sessions.contains(where: { $0.name == name })
        }
        guard let session = try await client.listSessions().first(where: { $0.name == name }) else {
            throw HarnessError.message("missing session \(name)")
        }
        return session
    }

    private func waitForOwner(
        _ window: TerminalEmulatorWindow,
        session: String
    ) async throws -> TerminalWindowReplayDiagnostics {
        var match: TerminalWindowReplayDiagnostics?
        try await wait(timeoutSeconds: 12) {
            guard let sessions = try? await self.client.listSessions(),
                  let summary = sessions.first(where: { $0.name == session }),
                  let diagnostics = (window as? any TerminalWindowReplayInspectable)?.replayDiagnostics,
                  diagnostics.isOwner,
                  diagnostics.ownerClientID == summary.ownerClientID,
                  diagnostics.ownershipEpoch == summary.ownershipEpoch,
                  diagnostics.sourceColumns == summary.columns,
                  diagnostics.sourceRows == summary.rows else {
                return false
            }
            match = diagnostics
            return true
        }
        guard let match else {
            throw HarnessError.message("terminal owner status unavailable")
        }
        return match
    }

    private func waitForWindows(
        _ windows: [TerminalEmulatorWindow],
        session: String,
        columns: UInt32? = nil,
        rows: UInt32? = nil
    ) async throws {
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline {
            guard let sessions = try? await self.client.listSessions(),
                  let summary = sessions.first(where: { $0.name == session }) else {
                try await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            let expectedColumns = columns ?? summary.columns
            let expectedRows = rows ?? summary.rows
            let converged = windows.allSatisfy { window in
                guard let diagnostics = (window as? any TerminalWindowReplayInspectable)?.replayDiagnostics else {
                    return false
                }
                return !diagnostics.synchronizing
                    && diagnostics.columns == expectedColumns
                    && diagnostics.rows == expectedRows
                    && diagnostics.revision == summary.revision
            }
            if converged { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        let expected = try await requireSession(named: session)
        let diagnostics = windows.compactMap {
            ($0 as? any TerminalWindowReplayInspectable)?.replayDiagnostics
        }
        throw HarnessError.message(
            "terminal windows did not converge; expected " +
            "\(columns ?? expected.columns)x\(rows ?? expected.rows) revision \(expected.revision), " +
            "actual \(diagnostics)"
        )
    }

    private func requireMatchingDiagnostics(
        _ windows: [TerminalEmulatorWindow]
    ) throws -> [TerminalWindowReplayDiagnostics] {
        let diagnostics = windows.compactMap {
            ($0 as? any TerminalWindowReplayInspectable)?.replayDiagnostics
        }
        guard diagnostics.count == windows.count,
              let first = diagnostics.first,
              diagnostics.allSatisfy({
                  $0.columns == first.columns && $0.rows == first.rows && $0.revision == first.revision
              }) else {
            throw HarnessError.message("terminal clients did not converge")
        }
        return diagnostics
    }

    private func capture(_ window: TerminalEmulatorWindow, named name: String) throws -> String {
        guard let id = window.assignedDesktopWindowID else {
            throw HarnessError.message("terminal window has no window id")
        }
        return try capture(windowID: id, named: name)
    }

    private func capture(windowID: UInt32, named name: String) throws -> String {
        let url = arguments.artifactDirectory.appendingPathComponent("\(name).png")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l", String(windowID), url.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw HarnessError.message("screencapture failed for \(name)")
        }
        return url.path
    }

    private func wait(
        timeoutSeconds: Double,
        predicate: @escaping () async -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if await predicate() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw HarnessError.message("timed out after \(timeoutSeconds) seconds")
    }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

private func jsonEscaped(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
}

do {
    let arguments = try HarnessArguments()
    MainActor.assumeIsolated {
        let application = NSApplication.shared
        let delegate = HarnessDelegate(arguments: arguments)
        application.delegate = delegate
        application.run()
        _ = delegate
    }
} catch {
    FileHandle.standardError.write(Data("terminal-replay-harness: \(error)\n".utf8))
    exit(2)
}
