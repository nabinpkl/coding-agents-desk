import CoreGraphics
import Foundation

public struct DockAppSnapshot: Equatable, Sendable {
    public let desktopGroups: [DockDesktopGroupSummary]
    public var apps: [DockAppInstanceSummary] { desktopGroups.flatMap(\.apps) }

    public init(apps: [DockAppInstanceSummary]) {
        desktopGroups = [
            DockDesktopGroupSummary(
                spaceID: nil,
                displayID: nil,
                desktopOrdinal: nil,
                monitorName: "Current Desktop",
                monitorFrame: nil,
                isActive: true,
                isMainDisplay: true,
                diagnostic: nil,
                apps: apps
            ),
        ]
    }

    public init(desktopGroups: [DockDesktopGroupSummary]) {
        self.desktopGroups = desktopGroups
    }
}

public struct DockDesktopGroupSummary: Equatable, Sendable {
    public let spaceID: UInt64?
    public let displayID: String?
    public let desktopOrdinal: Int?
    public let monitorName: String
    public let monitorFrame: CGRect?
    public let isActive: Bool
    public let isMainDisplay: Bool
    public let diagnostic: String?
    public let apps: [DockAppInstanceSummary]
    public let label: String?

    public var windowCount: Int {
        apps.reduce(0) { count, app in count + app.windows.count }
    }

    public var desktopLabel: String {
        label ?? desktopOrdinal.map { "Desktop \($0)" } ?? "Current Desktop"
    }

    public var monitorDetailLabel: String {
        let size = monitorFrame.map { " · \(Int($0.width)) x \(Int($0.height))" } ?? ""
        let main = isMainDisplay ? " · main monitor" : ""
        let active = isActive ? " · active" : ""
        return "\(monitorName)\(size)\(main)\(active)"
    }

    public var monitorBadgeLabel: String {
        isMainDisplay ? "P" : "S"
    }

    public init(
        spaceID: UInt64?,
        displayID: String?,
        desktopOrdinal: Int?,
        monitorName: String,
        monitorFrame: CGRect?,
        isActive: Bool,
        isMainDisplay: Bool,
        diagnostic: String?,
        apps: [DockAppInstanceSummary],
        label: String? = nil
    ) {
        self.spaceID = spaceID
        self.displayID = displayID
        self.desktopOrdinal = desktopOrdinal
        self.monitorName = monitorName
        self.monitorFrame = monitorFrame
        self.isActive = isActive
        self.isMainDisplay = isMainDisplay
        self.diagnostic = diagnostic
        self.apps = apps
        self.label = label
    }
}

public struct DockAppInstanceSummary: Equatable, Sendable {
    public let pid: pid_t
    public let name: String
    public let bundleIdentifier: String?
    public let bundleURL: URL?
    public let duplicateIndex: Int?
    public let axErrorCode: Int32?
    public let windows: [DockAppWindowSummary]

    public init(
        pid: pid_t,
        name: String,
        bundleIdentifier: String?,
        bundleURL: URL?,
        duplicateIndex: Int?,
        axErrorCode: Int32?,
        windows: [DockAppWindowSummary]
    ) {
        self.pid = pid
        self.name = name
        self.bundleIdentifier = bundleIdentifier
        self.bundleURL = bundleURL
        self.duplicateIndex = duplicateIndex
        self.axErrorCode = axErrorCode
        self.windows = windows
    }
}

public struct DockAppWindowSummary: Equatable, Sendable {
    public let windowID: UInt32?
    public let title: String
    public let role: String
    public let subrole: String
    public let isFocused: Bool
    public let isMinimized: Bool
    public let isOnScreen: Bool
    public let layer: Int?
    public let alpha: Double?
    public let bounds: CGRect?
    public let spaceIDs: [UInt64]

    public init(
        windowID: UInt32?,
        title: String,
        role: String,
        subrole: String,
        isFocused: Bool,
        isMinimized: Bool,
        isOnScreen: Bool,
        layer: Int?,
        alpha: Double?,
        bounds: CGRect?,
        spaceIDs: [UInt64] = []
    ) {
        self.windowID = windowID
        self.title = title
        self.role = role
        self.subrole = subrole
        self.isFocused = isFocused
        self.isMinimized = isMinimized
        self.isOnScreen = isOnScreen
        self.layer = layer
        self.alpha = alpha
        self.bounds = bounds
        self.spaceIDs = spaceIDs
    }
}

public protocol DockAppSnapshotReading: Sendable {
    func snapshot() -> DockAppSnapshot
}

struct DockRunningApplicationFacts: Equatable, Sendable {
    let pid: pid_t
    let name: String
    let bundleIdentifier: String?
    let bundleURL: URL?
    let isRegular: Bool
}

struct DockAXWindowFacts: Equatable, Sendable {
    let title: String
    let role: String
    let subrole: String
    let isFocused: Bool
    let isMinimized: Bool
    let bounds: CGRect?
}

enum DockAXWindowResult: Equatable, Sendable {
    case windows([DockAXWindowFacts])
    case error(Int32)
}

struct DockCGWindowFacts: Equatable, Sendable {
    let pid: pid_t
    let windowID: UInt32
    let title: String
    let layer: Int
    let alpha: Double
    let bounds: CGRect
}

struct DockDisplayMonitorFacts: Equatable, Sendable {
    let displayID: String
    let name: String
    let frame: CGRect
    let visibleFrame: CGRect
    let isMain: Bool
}

protocol DockRunningApplicationReading: Sendable {
    func runningApplications() -> [DockRunningApplicationFacts]
}

protocol DockAXWindowReading: Sendable {
    func windows(for pid: pid_t) -> DockAXWindowResult
}

protocol DockCGWindowReading: Sendable {
    func windows() -> [DockCGWindowFacts]
}

protocol DockDisplayMonitorReading: Sendable {
    func monitors() -> [DockDisplayMonitorFacts]
}

extension DockDesktopGroupSummary {
    /// A copy with the display label replaced. The panel uses this to overlay the assigned workspace
    /// name (Q2) on the main thread, where the workspace store lives.
    func withLabel(_ newLabel: String?) -> DockDesktopGroupSummary {
        DockDesktopGroupSummary(
            spaceID: spaceID,
            displayID: displayID,
            desktopOrdinal: desktopOrdinal,
            monitorName: monitorName,
            monitorFrame: monitorFrame,
            isActive: isActive,
            isMainDisplay: isMainDisplay,
            diagnostic: diagnostic,
            apps: apps,
            label: newLabel
        )
    }
}
