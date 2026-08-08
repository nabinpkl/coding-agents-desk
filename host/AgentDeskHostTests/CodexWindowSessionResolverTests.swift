import AgentDeskWire
import AppKit
import Foundation
import Testing

@testable import AgentDeskHost

/// The codex resolution is the layered title/project/Recents-first-row matcher over fixture state and
/// AX summaries -- pure, so every case is testable without a live app, process table, or file system.
struct CodexWindowSessionResolverTests {
    private let frameA = CGRect(x: 100, y: 100, width: 830, height: 877)
    private let frameB = CGRect(x: 1000, y: 100, width: 830, height: 877)

    private func summary(
        title: String = "",
        project: String = "",
        recentsFirstRow: String? = nil,
        frame: CGRect? = nil
    ) -> CodexWindowSummary {
        CodexWindowSummary(
            threadTitle: title,
            projectName: project,
            recentsFirstRow: recentsFirstRow,
            frame: frame ?? frameA
        )
    }

    // MARK: - Parsers

    @Test func parsesThreadsRowsFromSqliteJSON() {
        let json = Data("""
        [
            {"id": "019fe292-5466-7393-b931-8bf0c2cece82", "title": "find stream details", "cwd": "/Users/dev/projects/resumes"},
            {"id": "019fe22e-b97e-7d93-b1d7-16398e1533f0", "title": "understand the latest state", "cwd": "/Users/dev/projects/chatbot"},
            {"id": "broken", "title": null, "cwd": ""}
        ]
        """.utf8)
        let rows = CodexWindowSessionResolver.parseThreadsRows(json)
        #expect(rows.count == 2)
        #expect(rows[0].threadId == "019fe292-5466-7393-b931-8bf0c2cece82")
        #expect(rows[0].title == "find stream details")
        #expect(rows[0].cwd == "/Users/dev/projects/resumes")
    }

    @Test func skipsMalformedThreadRows() {
        #expect(CodexWindowSessionResolver.parseThreadsRows(Data("not json".utf8)).isEmpty)
        #expect(CodexWindowSessionResolver.parseThreadsRows(Data("{}".utf8)).isEmpty)
    }

    @Test func parsesSessionIndexLines() {
        let text = """
        {"id":"019fe292-5466-7393-b931-8bf0c2cece82","thread_name":"Find stream details","updated_at":"2026-08-08T18:11:14Z"}
        {"id":"019fe22e-b97e-7d93-b1d7-16398e1533f0","thread_name":"Understand latest state","updated_at":"2026-08-08T16:22:27Z"}
        not json
        """
        let entries = CodexWindowSessionResolver.parseSessionIndex(text)
        #expect(entries.count == 2)
        #expect(entries[0].threadName == "Find stream details")
    }

    @Test func projectNameIsTheDirectoryName() {
        #expect(CodexWindowSessionResolver.projectName(for: "/Users/dev/projects/resumes") == "resumes")
        #expect(CodexWindowSessionResolver.projectName(for: "/") == "/")
    }

    // MARK: - Header-bar layout matching

    @Test func aNamedThreadMatchesOnlyTitleAndProjectTogether() {
        // Same title in another project must not match.
        let windows = [
            summary(title: "Find stream details", project: "resumes"),
            summary(title: "Find stream details", project: "chatbot"),
        ]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "019fe292-5466-7393-b931-8bf0c2cece82",
            title: "find stream details",
            cwd: "/Users/dev/projects/resumes",
            threadName: "Find stream details",
            windows: windows
        )
        #expect(match == .matched(windows[0]))
    }

    @Test func aNamedThreadMatchesItsLowercasedRegistryTitleWhenNoDisplayNameExists() {
        let windows = [summary(title: "find stream details", project: "resumes")]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "find stream details",
            cwd: "/Users/dev/projects/resumes",
            threadName: "",
            windows: windows
        )
        #expect(match == .matched(windows[0]))
    }

    @Test func aGenericTitleResolvesByUniqueProjectAlone() {
        // Two fresh "New chat" threads in DIFFERENT projects resolve through the project popup.
        let windows = [
            summary(title: "New chat", project: "resumes"),
            summary(title: "New chat", project: "chatbot"),
        ]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "New chat",
            cwd: "/Users/dev/projects/chatbot",
            threadName: "New chat",
            windows: windows
        )
        #expect(match == .matched(windows[1]))
    }

    @Test func twoGenericThreadsInTheSameProjectAreAmbiguous() {
        let windows = [
            summary(title: "New chat", project: "resumes", frame: frameA),
            summary(title: "New chat", project: "resumes", frame: frameB),
        ]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "New chat",
            cwd: "/Users/dev/projects/resumes",
            threadName: "New chat",
            windows: windows
        )
        guard case .ambiguous(let candidates) = match else {
            Issue.record("expected ambiguous, got \(match)")
            return
        }
        #expect(candidates == windows)
    }

    // MARK: - Recents layout matching

    /// A thread opened from Recents has a `cwd` outside the app's project registry, so no window
    /// exposes a project popup; the first row of the window's Recents list is the identity.
    @Test func aRecentsThreadMatchesTheWindowWhoseRecentsFirstRowCarriesItsTitle() {
        let windows = [
            summary(recentsFirstRow: "Find stream details", frame: frameA),
            summary(recentsFirstRow: "Model and Work Capabilities", frame: frameB),
        ]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "019fe292-5466-7393-b931-8bf0c2cece82",
            title: "find stream details",
            cwd: "/Users/dev/Documents/Codex/2026-08-08/str",
            threadName: "Find stream details",
            windows: windows
        )
        #expect(match == .matched(windows[0]))
    }

    @Test func aRecentsThreadMatchesTheLowercasedRegistryTitleWhenNoDisplayNameExists() {
        let windows = [summary(recentsFirstRow: "find stream details")]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "find stream details",
            cwd: "/Users/dev/Documents/Codex/2026-08-08/str",
            threadName: "",
            windows: windows
        )
        #expect(match == .matched(windows[0]))
    }

    @Test func twoWindowsShowingTheSameRecentsTitleAreAmbiguous() {
        let windows = [
            summary(recentsFirstRow: "New chat", frame: frameA),
            summary(recentsFirstRow: "New chat", frame: frameB),
        ]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "New chat",
            cwd: "/Users/dev/Documents/Codex/2026-08-08/str",
            threadName: "New chat",
            windows: windows
        )
        guard case .ambiguous = match else {
            Issue.record("expected ambiguous, got \(match)")
            return
        }
    }

    @Test func aRecentsWindowShowingADifferentThreadDoesNotMatch() {
        let windows = [summary(recentsFirstRow: "Some other thread")]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "find stream details",
            cwd: "/Users/dev/Documents/Codex/2026-08-08/str",
            threadName: "Find stream details",
            windows: windows
        )
        #expect(match == .notFound)
    }

    @Test func aHeaderLayoutWindowWithoutARecentsListStillMatchesByHeaderAnchors() {
        let windows = [summary(title: "Find stream details", project: "resumes")]
        let match = CodexWindowSessionResolver.resolve(
            threadId: "id",
            title: "find stream details",
            cwd: "/Users/dev/projects/resumes",
            threadName: "Find stream details",
            windows: windows
        )
        #expect(match == .matched(windows[0]))
    }

    // MARK: - Live process and targeting

    @Test func codexMainPidsMatchesOnlyTheMainBinary() {
        let rows = AgentWindowSessionResolver.parseProcessTable("""
            1     0 /sbin/launchd
            700     1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
            701   700 /Applications/ChatGPT.app/Contents/Resources/codex app-server --analytics-default-enabled
            702     1 /Applications/ChatGPT.app/Contents/MacOS/ChatGPTX
        """)
        #expect(
            CodexWindowSessionResolver.codexMainPids(
                in: rows,
                mainPath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"
            ) == [700]
        )
    }

    @Test func sqliteLiteralDoublesEmbeddedQuotes() {
        #expect(CodexWindowState.sqliteLiteral("a'b") == "a''b")
        #expect(CodexWindowState.sqliteLiteral("plain") == "plain")
    }

    @Test func targetingPicksTheWindowWhoseFrameTheAccessibilityScanMatched() {
        let snapshot = WorkspaceDesktopSnapshot(
            activeSpaceID: 3,
            desktops: [],
            windows: [
                WorkspaceDesktopWindow(
                    windowID: 10,
                    ownerPID: 700,
                    ownerName: "ChatGPT",
                    title: "ChatGPT",
                    spaceIDs: [5],
                    layer: 0,
                    bounds: frameA,
                    expectation: .otherApp
                ),
                WorkspaceDesktopWindow(
                    windowID: 11,
                    ownerPID: 700,
                    ownerName: "ChatGPT",
                    title: "ChatGPT",
                    spaceIDs: [7],
                    layer: 0,
                    bounds: frameB,
                    expectation: .otherApp
                ),
            ],
            diagnostic: nil
        )
        let target = CodexWindowTargeting.target(
            sessionId: "id",
            mainPid: 700,
            frame: frameB,
            in: snapshot
        )
        #expect(target.map(\.windowID) == .success(11))
        #expect(target.map(\.homeSpaceID) == .success(7))
    }

    @Test func targetingRefusesWhenNoAuditedWindowMatchesTheFrame() {
        let snapshot = WorkspaceDesktopSnapshot(
            activeSpaceID: 3,
            desktops: [],
            windows: [
                WorkspaceDesktopWindow(
                    windowID: 10,
                    ownerPID: 700,
                    ownerName: "ChatGPT",
                    title: "ChatGPT",
                    spaceIDs: [5],
                    layer: 0,
                    bounds: frameA,
                    expectation: .otherApp
                ),
                WorkspaceDesktopWindow(
                    windowID: 11,
                    ownerPID: 700,
                    ownerName: "ChatGPT",
                    title: "ChatGPT",
                    spaceIDs: [7],
                    layer: 0,
                    bounds: frameB,
                    expectation: .otherApp
                ),
            ],
            diagnostic: nil
        )
        // Two windows and a frame the AX scan never matched: addressing would be a guess.
        let target = CodexWindowTargeting.target(
            sessionId: "id",
            mainPid: 700,
            frame: CGRect(x: 500, y: 500, width: 300, height: 300),
            in: snapshot
        )
        #expect(target == .failure(.noWindow))
    }

    @Test func targetingUsesTheSingleWindowWithoutAFrameMatch() {
        let snapshot = WorkspaceDesktopSnapshot(
            activeSpaceID: 3,
            desktops: [],
            windows: [
                WorkspaceDesktopWindow(
                    windowID: 10,
                    ownerPID: 700,
                    ownerName: "ChatGPT",
                    title: "ChatGPT",
                    spaceIDs: [5],
                    layer: 0,
                    bounds: frameA,
                    expectation: .otherApp
                )
            ],
            diagnostic: nil
        )
        let target = CodexWindowTargeting.target(
            sessionId: "id",
            mainPid: 700,
            frame: frameB,
            in: snapshot
        )
        // One window, nothing to disambiguate: the frame mismatch is not a refusal.
        #expect(target.map(\.windowID) == .success(10))
    }

    // MARK: - Placeholder normalization

    @Test func placeholderOnlyRecognizesTheEmptyComposerSerialization() {
        // Ground truth: an empty codex composer reads back "\nDo anything".
        #expect(CodexWindowComposerAccess.isPlaceholderOnly(value: "", description: "Do anything"))
        #expect(CodexWindowComposerAccess.isPlaceholderOnly(value: "\nDo anything", description: "Do anything"))
        #expect(!CodexWindowComposerAccess.isPlaceholderOnly(value: "real text", description: "Do anything"))
        #expect(!CodexWindowComposerAccess.isPlaceholderOnly(value: "\nDo anything", description: "Changed placeholder"))
    }
}
