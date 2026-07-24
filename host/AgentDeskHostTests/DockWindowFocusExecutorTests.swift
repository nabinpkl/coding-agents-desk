import AgentDeskWire
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
struct DockWindowFocusExecutorTests {
    private let bounds = CGRect(x: 100, y: 200, width: 900, height: 700)

    @Test func offSpaceTargetWaitsForExactSpaceThenFocusesExactWindow() async throws {
        var currentSpaceID: UInt64 = 10
        var commits: [(Int, String)] = []
        let switcher = makeSwitcher(
            currentSpaceID: { currentSpaceID },
            commit: { delta, displayID in
                commits.append((delta, displayID))
                return true
            },
            wait: { target, _ in
                currentSpaceID = target
                return true
            }
        )
        let ax = RecordingDockAXAccess(candidates: [
            candidate(id: 1, title: "Current", bounds: CGRect(x: 0, y: 0, width: 10, height: 10)),
            candidate(id: 2, title: "Target", bounds: bounds),
        ])
        let executor = makeExecutor(
            switcher: switcher,
            spaceIDs: [20],
            ax: ax
        )

        try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))

        #expect(commits.count == 1)
        #expect(commits.first?.0 == 1)
        #expect(commits.first?.1 == "D1")
        #expect(ax.actions == ["main:2:true", "focused:2:true", "raise:2", "activate:100"])
    }

    @Test func allSpacesTargetFocusesInPlaceWithoutSwitching() async throws {
        var commits = 0
        let switcher = makeSwitcher(
            currentSpaceID: { 10 },
            commit: { _, _ in
                commits += 1
                return true
            },
            wait: { _, _ in
                Issue.record("all-Spaces focus must not wait for another Space")
                return false
            }
        )
        let ax = RecordingDockAXAccess(candidates: [
            candidate(id: 2, title: "Target", bounds: bounds),
        ])
        let executor = makeExecutor(
            switcher: switcher,
            spaceIDs: [10, 20],
            ax: ax
        )

        try await executor.focus(request(spaceIDs: [10, 20], targetSpaceID: 20))

        #expect(commits == 0)
        #expect(ax.actions.last == "activate:100")
    }

    @Test func minimizedTargetRestoresBeforeFocusActions() async throws {
        let switcher = makeSwitcher(
            currentSpaceID: { 20 },
            commit: { _, _ in true },
            wait: { _, _ in true }
        )
        let ax = RecordingDockAXAccess(candidates: [
            candidate(id: 2, title: "Target", bounds: bounds, isMinimized: true),
        ])
        let executor = makeExecutor(switcher: switcher, spaceIDs: [20], ax: ax)

        try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))

        #expect(
            ax.actions == [
                "minimized:2:false",
                "main:2:true",
                "focused:2:true",
                "raise:2",
                "activate:100",
            ]
        )
    }

    @Test func staleWindowFailsWithoutAnyAXAction() async {
        let switcher = makeSwitcher(
            currentSpaceID: { 20 },
            commit: { _, _ in true },
            wait: { _, _ in true }
        )
        let ax = RecordingDockAXAccess(candidates: [])
        let executor = DockWindowFocusExecutor(
            desktopSwitcher: switcher,
            desktopAudit: audit(spaceIDs: [20]),
            cgWindows: StaticDockCGWindowReader(windows: []),
            axAccess: ax
        )

        await #expect(throws: DockWindowFocusError.staleWindow(42)) {
            try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))
        }
        #expect(ax.actions.isEmpty)
    }

    @Test func reusedWindowIDWithDifferentFactsFailsWithoutAnyAXAction() async {
        let switcher = makeSwitcher(
            currentSpaceID: { 20 },
            commit: { _, _ in true },
            wait: { _, _ in true }
        )
        let ax = RecordingDockAXAccess(candidates: [
            candidate(id: 2, title: "Replacement", bounds: .zero),
        ])
        let replacement = DockCGWindowFacts(
            pid: 100,
            windowID: 42,
            title: "Replacement",
            layer: 0,
            alpha: 1,
            bounds: .zero
        )
        let executor = DockWindowFocusExecutor(
            desktopSwitcher: switcher,
            desktopAudit: audit(spaceIDs: [20]),
            cgWindows: StaticDockCGWindowReader(windows: [replacement]),
            axAccess: ax
        )

        await #expect(throws: DockWindowFocusError.staleWindow(42)) {
            try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))
        }
        #expect(ax.actions.isEmpty)
    }

    @Test func ambiguousAXMatchFailsWithoutChoosingAnotherWindow() async {
        let switcher = makeSwitcher(
            currentSpaceID: { 20 },
            commit: { _, _ in true },
            wait: { _, _ in true }
        )
        let ax = RecordingDockAXAccess(candidates: [
            candidate(id: 1, title: "Target", bounds: bounds),
            candidate(id: 2, title: "Target", bounds: bounds),
        ])
        let executor = makeExecutor(switcher: switcher, spaceIDs: [20], ax: ax)

        await #expect(throws: DockWindowFocusError.accessibilityWindowAmbiguous(42)) {
            try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))
        }
        #expect(ax.actions.isEmpty)
    }

    @Test func deniedAccessibilityFailsBeforeSwitching() async {
        var commits = 0
        let switcher = makeSwitcher(
            currentSpaceID: { 10 },
            commit: { _, _ in
                commits += 1
                return true
            },
            wait: { _, _ in true }
        )
        let ax = RecordingDockAXAccess(trusted: false, candidates: [])
        let executor = makeExecutor(switcher: switcher, spaceIDs: [20], ax: ax)

        await #expect(throws: DockWindowFocusError.accessibilityPermissionRequired) {
            try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))
        }
        #expect(commits == 0)
    }

    @Test(arguments: [
        (false, true, DockWindowFocusError.spaceSwitchRejected(20)),
        (true, false, DockWindowFocusError.spaceSwitchTimedOut(20)),
    ])
    func unsuccessfulSpaceSwitchNeverTouchesAX(
        commitAccepted: Bool,
        waitSucceeded: Bool,
        expectedError: DockWindowFocusError
    ) async {
        let switcher = makeSwitcher(
            currentSpaceID: { 10 },
            commit: { _, _ in commitAccepted },
            wait: { _, _ in waitSucceeded }
        )
        let ax = RecordingDockAXAccess(candidates: [
            candidate(id: 2, title: "Target", bounds: bounds),
        ])
        let executor = makeExecutor(switcher: switcher, spaceIDs: [20], ax: ax)

        await #expect(throws: expectedError) {
            try await executor.focus(request(spaceIDs: [20], targetSpaceID: 20))
        }
        #expect(ax.actions.isEmpty)
    }

    @Test func exactMatcherRejectsDuplicateTitleAndBounds() {
        let target = cgWindow()
        let facts = candidate(id: 1, title: "Target", bounds: bounds).facts

        #expect(DockWindowMatcher.axWindow(matching: target, in: [facts, facts]) == .ambiguous)
        #expect(DockWindowMatcher.axWindow(matching: target, in: [facts]) == .matched(0))
        #expect(
            DockWindowMatcher.axWindow(
                matching: target,
                in: [candidate(id: 3, title: "Other", bounds: .zero).facts]
            ) == .missing
        )
    }

    private func makeExecutor(
        switcher: WorkspaceDesktopSwitcher,
        spaceIDs: [UInt64],
        ax: RecordingDockAXAccess
    ) -> DockWindowFocusExecutor<RecordingDockAXAccess> {
        DockWindowFocusExecutor(
            desktopSwitcher: switcher,
            desktopAudit: audit(spaceIDs: spaceIDs),
            cgWindows: StaticDockCGWindowReader(windows: [cgWindow()]),
            axAccess: ax
        )
    }

    private func makeSwitcher(
        currentSpaceID: @escaping () -> UInt64,
        commit: @escaping (Int, String) -> Bool,
        wait: @escaping (UInt64, String) async throws -> Bool
    ) -> WorkspaceDesktopSwitcher {
        WorkspaceDesktopSwitcher(
            state: {
                DesktopState(
                    displays: [],
                    spaces: [
                        SpaceMetadata(id: 10, displayId: "D1", index: 0, type: 0),
                        SpaceMetadata(id: 20, displayId: "D1", index: 1, type: 0),
                    ],
                    activeDisplayId: "D1",
                    activeSpaceId: currentSpaceID()
                )
            },
            currentSpaceID: { _ in currentSpaceID() },
            commit: commit,
            waitForCurrentSpace: wait
        )
    }

    private func request(
        spaceIDs: [UInt64],
        targetSpaceID: UInt64
    ) -> DockWindowFocusRequest {
        DockWindowFocusRequest(
            app: DockAppInstanceSummary(
                pid: 100,
                name: "Editor",
                bundleIdentifier: "dev.test.editor",
                bundleURL: nil,
                duplicateIndex: nil,
                axErrorCode: nil,
                windows: []
            ),
            window: DockAppWindowSummary(
                windowID: 42,
                title: "Target",
                role: "AXWindow",
                subrole: "AXStandardWindow",
                isFocused: false,
                isMinimized: false,
                isOnScreen: true,
                layer: 0,
                alpha: 1,
                bounds: bounds,
                spaceIDs: spaceIDs
            ),
            group: DockDesktopGroupSummary(
                spaceID: targetSpaceID,
                displayID: "D1",
                missionControlOrdinal: 1,
                monitorName: "Display",
                monitorFrame: nil,
                isActive: targetSpaceID == 10,
                isMainDisplay: true,
                diagnostic: nil,
                apps: []
            )
        )
    }

    private func cgWindow() -> DockCGWindowFacts {
        DockCGWindowFacts(
            pid: 100,
            windowID: 42,
            title: "Target",
            layer: 0,
            alpha: 1,
            bounds: bounds
        )
    }

    private func audit(spaceIDs: [UInt64]) -> StaticWorkspaceDesktopAudit {
        StaticWorkspaceDesktopAudit(
            WorkspaceDesktopSnapshot(
                activeSpaceID: spaceIDs.first,
                desktops: [],
                windows: [
                    WorkspaceDesktopWindow(
                        windowID: 42,
                        ownerName: "Editor",
                        title: "Target",
                        spaceIDs: spaceIDs,
                        layer: 0,
                        bounds: bounds,
                        expectation: .otherApp
                    ),
                ],
                diagnostic: nil
            )
        )
    }

    private func candidate(
        id: Int,
        title: String,
        bounds: CGRect,
        isMinimized: Bool = false
    ) -> DockAXWindowCandidate<Int> {
        DockAXWindowCandidate(
            element: id,
            facts: DockAXWindowFacts(
                title: title,
                role: "AXWindow",
                subrole: "AXStandardWindow",
                isFocused: false,
                isMinimized: isMinimized,
                bounds: bounds
            )
        )
    }
}

private struct StaticDockCGWindowReader: DockCGWindowReading {
    let windowsValue: [DockCGWindowFacts]

    init(windows: [DockCGWindowFacts]) {
        windowsValue = windows
    }

    func windows() -> [DockCGWindowFacts] {
        windowsValue
    }
}

@MainActor
private final class RecordingDockAXAccess: DockAXWindowAccessing {
    let trusted: Bool
    let candidates: [DockAXWindowCandidate<Int>]
    private(set) var actions: [String] = []

    init(
        trusted: Bool = true,
        candidates: [DockAXWindowCandidate<Int>]
    ) {
        self.trusted = trusted
        self.candidates = candidates
    }

    func isTrusted() -> Bool {
        trusted
    }

    func windows(for pid: pid_t) throws -> [DockAXWindowCandidate<Int>] {
        candidates
    }

    func setMinimized(_ minimized: Bool, for element: Int) throws {
        actions.append("minimized:\(element):\(minimized)")
    }

    func setMain(_ main: Bool, for element: Int) throws {
        actions.append("main:\(element):\(main)")
    }

    func setFocused(_ focused: Bool, for element: Int) throws {
        actions.append("focused:\(element):\(focused)")
    }

    func raise(_ element: Int) throws {
        actions.append("raise:\(element)")
    }

    func activate(pid: pid_t) throws {
        actions.append("activate:\(pid)")
    }
}
