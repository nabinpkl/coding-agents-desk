import AppKit
import ApplicationServices

public struct DockAppSnapshotReader: DockAppSnapshotReading {
    private let applications: DockRunningApplicationReading
    private let axWindows: DockAXWindowReading
    private let cgWindows: DockCGWindowReading
    private let desktopAudit: WorkspaceDesktopAuditing
    private let monitors: DockDisplayMonitorReading

    public init(desktopAudit: WorkspaceDesktopAuditing = HostWorkspaceDesktopAudit()) {
        applications = NSWorkspaceDockRunningApplicationReader()
        axWindows = AXDockWindowReader()
        cgWindows = CGDockWindowReader()
        self.desktopAudit = desktopAudit
        monitors = DockDisplayMonitorCache.shared
    }

    init(
        applications: DockRunningApplicationReading,
        axWindows: DockAXWindowReading,
        cgWindows: DockCGWindowReading,
        desktopAudit: WorkspaceDesktopAuditing = StaticWorkspaceDesktopAudit(.unavailable("desktop audit unavailable")),
        monitors: DockDisplayMonitorReading = StaticDockDisplayMonitorReader(monitors: [])
    ) {
        self.applications = applications
        self.axWindows = axWindows
        self.cgWindows = cgWindows
        self.desktopAudit = desktopAudit
        self.monitors = monitors
    }

    public func snapshot() -> DockAppSnapshot {
        let running = applications.runningApplications()
            .filter(\.isRegular)
            .sorted { lhs, rhs in
                let nameCompare = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
                return nameCompare == .orderedSame ? lhs.pid < rhs.pid : nameCompare == .orderedAscending
        }
        let duplicateIndexes = Self.duplicateIndexes(for: running)
        let cgByPID = Dictionary(grouping: cgWindows.windows(), by: \.pid)
        let desktopSnapshot = desktopAudit.snapshot()
        let spaceIDsByWindowID = Dictionary(uniqueKeysWithValues: desktopSnapshot.windows.map { ($0.windowID, $0.spaceIDs) })
        let apps = running.map { app in
            let result = axWindows.windows(for: app.pid)
            let axFacts: [DockAXWindowFacts]
            let axErrorCode: Int32?
            switch result {
            case .windows(let windows):
                axFacts = windows
                axErrorCode = nil
            case .error(let code):
                axFacts = []
                axErrorCode = code
            }
            let windows = Self.mergedWindows(
                app: app,
                axWindows: axFacts,
                cgWindows: cgByPID[app.pid] ?? [],
                spaceIDsByWindowID: spaceIDsByWindowID
            )
            return DockAppInstanceSummary(
                pid: app.pid,
                name: app.name,
                bundleIdentifier: app.bundleIdentifier,
                bundleURL: app.bundleURL,
                duplicateIndex: duplicateIndexes[app.pid],
                axErrorCode: axErrorCode,
                windows: windows
            )
        }
        return groupedSnapshot(
            apps: apps,
            desktopSnapshot: desktopSnapshot,
            monitors: monitors.monitors()
        )
    }

    private static func duplicateIndexes(for apps: [DockRunningApplicationFacts]) -> [pid_t: Int] {
        let byName = Dictionary(grouping: apps, by: { $0.name.lowercased() })
        return byName.values.reduce(into: [:]) { result, group in
            guard group.count > 1 else { return }
            for (offset, app) in group.sorted(by: { $0.pid < $1.pid }).enumerated() {
                result[app.pid] = offset + 1
            }
        }
    }

    private static func mergedWindows(
        app: DockRunningApplicationFacts,
        axWindows: [DockAXWindowFacts],
        cgWindows: [DockCGWindowFacts],
        spaceIDsByWindowID: [UInt32: [UInt64]]
    ) -> [DockAppWindowSummary] {
        var usedCGWindowIDs = Set<UInt32>()
        var summaries = axWindows.compactMap { ax -> DockAppWindowSummary? in
            guard !isShellControlWindow(app: app, title: ax.title) else { return nil }
            let cg = bestCGWindow(for: ax, in: cgWindows, excluding: usedCGWindowIDs)
            if let cg { usedCGWindowIDs.insert(cg.windowID) }
            return DockAppWindowSummary(
                windowID: cg?.windowID,
                title: displayTitle(ax.title),
                role: ax.role,
                subrole: ax.subrole,
                isFocused: ax.isFocused,
                isMinimized: ax.isMinimized,
                isOnScreen: cg != nil,
                layer: cg?.layer,
                alpha: cg?.alpha,
                bounds: ax.bounds ?? cg?.bounds,
                spaceIDs: cg.flatMap { spaceIDsByWindowID[$0.windowID] } ?? []
            )
        }
        let cgOnly = cgWindows
            .filter { !usedCGWindowIDs.contains($0.windowID) }
            .filter { !$0.title.isEmpty && !isShellControlWindow(app: app, title: $0.title) }
            .map { cg in
                DockAppWindowSummary(
                    windowID: cg.windowID,
                    title: displayTitle(cg.title),
                    role: "",
                    subrole: "",
                    isFocused: false,
                    isMinimized: false,
                    isOnScreen: true,
                    layer: cg.layer,
                    alpha: cg.alpha,
                    bounds: cg.bounds,
                    spaceIDs: spaceIDsByWindowID[cg.windowID] ?? []
                )
            }
        summaries.append(contentsOf: cgOnly)
        return summaries.sorted { lhs, rhs in
            if lhs.isFocused != rhs.isFocused { return lhs.isFocused && !rhs.isFocused }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    private static func bestCGWindow(
        for ax: DockAXWindowFacts,
        in windows: [DockCGWindowFacts],
        excluding used: Set<UInt32>
    ) -> DockCGWindowFacts? {
        let available = windows.filter { !used.contains($0.windowID) }
        if let exactTitle = available.first(where: { !$0.title.isEmpty && $0.title == ax.title }) {
            return exactTitle
        }
        if let axBounds = ax.bounds,
           let boundsMatch = available.first(where: { close($0.bounds, to: axBounds) }) {
            return boundsMatch
        }
        return available.first { $0.layer == 0 }
    }

    private static func close(_ lhs: CGRect, to rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) < 2 &&
            abs(lhs.minY - rhs.minY) < 2 &&
            abs(lhs.width - rhs.width) < 2 &&
            abs(lhs.height - rhs.height) < 2
    }

    private static func displayTitle(_ title: String) -> String {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled Window" : title
    }

    private static func isShellControlWindow(app: DockRunningApplicationFacts, title: String) -> Bool {
        guard app.bundleIdentifier == Bundle.main.bundleIdentifier ||
            app.name == WorkspaceDesktopWindowExpectation.hostOwnerName
        else { return false }
        return WorkspaceShellControlWindow.all.contains(title)
    }

    private func groupedSnapshot(
        apps: [DockAppInstanceSummary],
        desktopSnapshot: WorkspaceDesktopSnapshot,
        monitors: [DockDisplayMonitorFacts]
    ) -> DockAppSnapshot {
        guard desktopSnapshot.diagnostic == nil, !desktopSnapshot.desktops.isEmpty else {
            return DockAppSnapshot(desktopGroups: [
                DockDesktopGroupSummary(
                    spaceID: nil,
                    displayID: nil,
                    desktopOrdinal: nil,
                    monitorName: "Current Desktop",
                    monitorFrame: nil,
                    isActive: true,
                    isMainDisplay: true,
                    diagnostic: desktopSnapshot.diagnostic ?? "Desktop audit unavailable",
                    apps: apps
                ),
            ])
        }

        let monitorByDisplayID = Dictionary(uniqueKeysWithValues: monitors.map { ($0.displayID, $0) })
        let desktops = desktopSnapshot.desktops
        let desktopIDs = Set(desktops.map(\.id))
        let activeDesktopID = desktopSnapshot.activeSpaceID.flatMap { active in
            desktopIDs.contains(active) ? active : nil
        }
        var appsByDesktopID: [UInt64: [DockAppInstanceSummary]] = [:]
        var ungroupedApps: [DockAppInstanceSummary] = []

        for app in apps {
            var groupedWindowsByDesktopID: [UInt64: [DockAppWindowSummary]] = [:]
            for window in app.windows {
                for spaceID in window.spaceIDs where desktopIDs.contains(spaceID) {
                    groupedWindowsByDesktopID[spaceID, default: []].append(window)
                }
            }

            if groupedWindowsByDesktopID.isEmpty {
                ungroupedApps.append(app.withWindows([]))
            } else {
                for (desktopID, windows) in groupedWindowsByDesktopID {
                    appsByDesktopID[desktopID, default: []].append(app.withWindows(Self.sortedWindows(windows)))
                }
            }
        }

        var groups = desktops.map { desktop in
            let monitor = monitorByDisplayID[desktop.displayID]
            return DockDesktopGroupSummary(
                spaceID: desktop.id,
                displayID: desktop.displayID,
                desktopOrdinal: desktop.ordinal,
                monitorName: monitor?.name ?? desktop.displayID,
                monitorFrame: monitor?.frame,
                isActive: desktop.isActive,
                isMainDisplay: monitor?.isMain ?? false,
                diagnostic: nil,
                apps: Self.sortedApps(appsByDesktopID[desktop.id] ?? []),
                // Base label is the human 1-based "Desktop N"; the panel overlays the assigned
                // workspace name (Q2) on the main thread where the store lives.
                label: "Desktop \(desktop.ordinal + 1)"
            )
        }
        if !ungroupedApps.isEmpty {
            let active = activeDesktopID.flatMap { id in desktops.first { $0.id == id } }
            let monitor = active.flatMap { monitorByDisplayID[$0.displayID] }
            groups.append(DockDesktopGroupSummary(
                spaceID: nil,
                displayID: active?.displayID,
                desktopOrdinal: nil,
                monitorName: monitor?.name ?? "No resolved Space membership",
                monitorFrame: monitor?.frame,
                isActive: false,
                isMainDisplay: monitor?.isMain ?? false,
                diagnostic: "Apps without groupable visible windows",
                apps: Self.sortedApps(ungroupedApps),
                label: "No visible Desktop"
            ))
        }
        return DockAppSnapshot(desktopGroups: groups)
    }

    private static func sortedApps(_ apps: [DockAppInstanceSummary]) -> [DockAppInstanceSummary] {
        apps.sorted { lhs, rhs in
            let nameCompare = lhs.name.localizedCaseInsensitiveCompare(rhs.name)
            return nameCompare == .orderedSame ? lhs.pid < rhs.pid : nameCompare == .orderedAscending
        }
    }

    private static func sortedWindows(_ windows: [DockAppWindowSummary]) -> [DockAppWindowSummary] {
        windows.sorted { lhs, rhs in
            if lhs.isFocused != rhs.isFocused { return lhs.isFocused && !rhs.isFocused }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }
}

private extension DockAppInstanceSummary {
    func withWindows(_ windows: [DockAppWindowSummary]) -> DockAppInstanceSummary {
        DockAppInstanceSummary(
            pid: pid,
            name: name,
            bundleIdentifier: bundleIdentifier,
            bundleURL: bundleURL,
            duplicateIndex: duplicateIndex,
            axErrorCode: axErrorCode,
            windows: windows
        )
    }
}

struct NSWorkspaceDockRunningApplicationReader: DockRunningApplicationReading {
    func runningApplications() -> [DockRunningApplicationFacts] {
        NSWorkspace.shared.runningApplications.map { app in
            DockRunningApplicationFacts(
                pid: app.processIdentifier,
                name: app.localizedName ?? app.bundleURL?.lastPathComponent ?? "pid \(app.processIdentifier)",
                bundleIdentifier: app.bundleIdentifier,
                bundleURL: app.bundleURL,
                isRegular: app.activationPolicy == .regular
            )
        }
    }
}

final class DockDisplayMonitorCache: DockDisplayMonitorReading, @unchecked Sendable {
    static let shared = DockDisplayMonitorCache()
    private let lock = NSLock()
    private var cached: [DockDisplayMonitorFacts] = []

    func refreshFromScreens() {
        precondition(Thread.isMainThread, "DockDisplayMonitorCache.refreshFromScreens must run on the main thread")
        let next = NSScreen.screens.compactMap { screen -> DockDisplayMonitorFacts? in
            let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
            let displayID = number?.uint32Value ?? 0
            guard let rawUUID = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue() else { return nil }
            let uuid = CFUUIDCreateString(nil, rawUUID) as String
            return DockDisplayMonitorFacts(
                displayID: uuid,
                name: screen.localizedName,
                frame: screen.frame,
                visibleFrame: screen.visibleFrame,
                isMain: screen == NSScreen.main
            )
        }
        lock.lock()
        cached = next
        lock.unlock()
    }

    func monitors() -> [DockDisplayMonitorFacts] {
        lock.lock()
        let monitors = cached
        lock.unlock()
        return monitors
    }
}

struct StaticDockDisplayMonitorReader: DockDisplayMonitorReading {
    let monitorFacts: [DockDisplayMonitorFacts]

    init(monitors: [DockDisplayMonitorFacts]) {
        monitorFacts = monitors
    }

    func monitors() -> [DockDisplayMonitorFacts] {
        monitorFacts
    }
}
