import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

struct DockAppSnapshotReaderTests {
    private struct StubApps: DockRunningApplicationReading {
        let apps: [DockRunningApplicationFacts]
        func runningApplications() -> [DockRunningApplicationFacts] { apps }
    }

    private struct StubAX: DockAXWindowReading {
        let byPID: [pid_t: DockAXWindowResult]
        func windows(for pid: pid_t) -> DockAXWindowResult { byPID[pid] ?? .windows([]) }
    }

    private struct StubCG: DockCGWindowReading {
        let list: [DockCGWindowFacts]
        func windows() -> [DockCGWindowFacts] { list }
    }

    private let bounds = CGRect(x: 0, y: 0, width: 100, height: 100)

    /// The one visible window maps to Desktop 1's Space id, so its app buckets under that desktop and
    /// Desktop 2 stays empty. The base label is the human 1-based "Desktop N".
    @Test func groupsAppWindowsByDesktopSpace() {
        let app = DockRunningApplicationFacts(pid: 100, name: "Editor", bundleIdentifier: "dev.test.editor", bundleURL: nil, isRegular: true)
        let ax = DockAXWindowFacts(title: "main.swift", role: "AXWindow", subrole: "AXStandardWindow", isFocused: true, isMinimized: false, bounds: bounds)
        let cg = DockCGWindowFacts(pid: 100, windowID: 42, title: "main.swift", layer: 0, alpha: 1, bounds: bounds)
        let desktops = [
            WorkspaceDesktop(id: 1, displayID: "display-1", ordinal: 0, isActive: true),
            WorkspaceDesktop(id: 2, displayID: "display-1", ordinal: 1, isActive: false),
        ]
        let auditWindow = WorkspaceDesktopWindow(windowID: 42, ownerName: "Editor", title: "main.swift", spaceIDs: [1], layer: 0, bounds: bounds, expectation: .otherApp)
        let audit = StaticWorkspaceDesktopAudit(WorkspaceDesktopSnapshot(activeSpaceID: 1, desktops: desktops, windows: [auditWindow], diagnostic: nil))
        let monitors = StaticDockDisplayMonitorReader(monitors: [
            DockDisplayMonitorFacts(displayID: "display-1", name: "Built-in", frame: CGRect(x: 0, y: 0, width: 1440, height: 900), visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 860), isMain: true),
        ])

        let reader = DockAppSnapshotReader(
            applications: StubApps(apps: [app]),
            axWindows: StubAX(byPID: [100: .windows([ax])]),
            cgWindows: StubCG(list: [cg]),
            desktopAudit: audit,
            monitors: monitors
        )
        let snapshot = reader.snapshot()

        #expect(snapshot.desktopGroups.count == 2)
        let desktop1 = snapshot.desktopGroups.first { $0.spaceID == 1 }
        let desktop2 = snapshot.desktopGroups.first { $0.spaceID == 2 }
        #expect(desktop1?.apps.map(\.name) == ["Editor"])
        #expect(desktop1?.desktopLabel == "Desktop 1")
        #expect(desktop1?.monitorName == "Built-in")
        #expect(desktop2?.apps.isEmpty == true)
        #expect(desktop2?.desktopLabel == "Desktop 2")
    }

    /// A window whose Space id is not among the audit's desktops (or no audit) leaves its app ungrouped,
    /// so the reader emits a single fallback group carrying every app.
    @Test func unavailableAuditFallsBackToOneGroup() {
        let app = DockRunningApplicationFacts(pid: 100, name: "Editor", bundleIdentifier: "dev.test.editor", bundleURL: nil, isRegular: true)
        let reader = DockAppSnapshotReader(
            applications: StubApps(apps: [app]),
            axWindows: StubAX(byPID: [:]),
            cgWindows: StubCG(list: []),
            desktopAudit: StaticWorkspaceDesktopAudit(.unavailable("no skylight")),
            monitors: StaticDockDisplayMonitorReader(monitors: [])
        )
        let snapshot = reader.snapshot()

        #expect(snapshot.desktopGroups.count == 1)
        #expect(snapshot.desktopGroups.first?.diagnostic != nil)
        #expect(snapshot.desktopGroups.first?.apps.map(\.name) == ["Editor"])
    }
}
