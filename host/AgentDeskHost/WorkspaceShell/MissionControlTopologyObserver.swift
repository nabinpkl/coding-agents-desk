import AgentDeskWire
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import os

struct MissionControlDisplayTopology: Equatable, Sendable {
    let displayID: String
    let spaceIDs: [UInt64]
}

struct MissionControlTopology: Equatable, Sendable {
    let displays: [MissionControlDisplayTopology]

    init(state: DesktopState) {
        let userSpaces = state.spaces.filter { $0.type == 0 && $0.index != nil }
        let knownDisplayIDs = state.displays.map(\.id)
        let remainingDisplayIDs = userSpaces.map(\.displayId).filter { !knownDisplayIDs.contains($0) }
        let displayIDs = knownDisplayIDs + remainingDisplayIDs.reduce(into: [String]()) { ids, id in
            if !ids.contains(id) { ids.append(id) }
        }
        displays = displayIDs.compactMap { displayID in
            let ids = userSpaces
                .filter { $0.displayId == displayID }
                .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
                .map(\.id)
            return ids.isEmpty ? nil : MissionControlDisplayTopology(displayID: displayID, spaceIDs: ids)
        }
    }

    func assignment(for spaceID: UInt64) -> WorkspaceDesktopAssignment? {
        for display in displays {
            if let ordinal = display.spaceIDs.firstIndex(of: spaceID) {
                return WorkspaceDesktopAssignment(
                    spaceID: spaceID,
                    displayID: display.displayID,
                    ordinal: ordinal
                )
            }
        }
        return nil
    }

    var assignmentsBySpaceID: [UInt64: WorkspaceDesktopAssignment] {
        var result: [UInt64: WorkspaceDesktopAssignment] = [:]
        for display in displays {
            for (ordinal, spaceID) in display.spaceIDs.enumerated() {
                result[spaceID] = WorkspaceDesktopAssignment(
                    spaceID: spaceID,
                    displayID: display.displayID,
                    ordinal: ordinal
                )
            }
        }
        return result
    }

    var spaceCount: Int {
        displays.reduce(0) { $0 + $1.spaceIDs.count }
    }
}

@MainActor
final class MissionControlTopologyObserver {
    typealias RegisterEntry = (@escaping @MainActor () -> Void) -> Bool
    typealias ScheduleExitCheck = (TimeInterval, @escaping @MainActor () -> Void) -> Void
    static let exitCheckDelay: TimeInterval = 0.1

    private let logger = Logger(subsystem: Config.logSubsystem, category: "mission-control-topology")
    private let registerEntry: RegisterEntry
    private let isMissionControlVisible: () -> Bool
    private let readTopology: () -> MissionControlTopology?
    private let scheduleExitCheck: ScheduleExitCheck

    private var registered = false
    private var active = false
    private var observingExit = false
    private var observationEpoch: UInt64 = 0
    private var lastTopology: MissionControlTopology?

    var onTopologyChanged: ((MissionControlTopology) -> Void)?

    convenience init(spacesProvider: SpacesProvider) {
        let entrySource = MissionControlEntrySource.shared
        self.init(
            registerEntry: entrySource.register,
            isMissionControlVisible: Self.isMissionControlVisible,
            readTopology: {
                spacesProvider.current().map(MissionControlTopology.init(state:))
            },
            scheduleExitCheck: { delay, work in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                    MainActor.assumeIsolated { work() }
                }
            }
        )
    }

    init(
        registerEntry: @escaping RegisterEntry,
        isMissionControlVisible: @escaping () -> Bool,
        readTopology: @escaping () -> MissionControlTopology?,
        scheduleExitCheck: @escaping ScheduleExitCheck
    ) {
        self.registerEntry = registerEntry
        self.isMissionControlVisible = isMissionControlVisible
        self.readTopology = readTopology
        self.scheduleExitCheck = scheduleExitCheck
    }

    @discardableResult
    func start() -> Bool {
        if !registered {
            guard registerEntry({ [weak self] in self?.missionControlEntered() }) else {
                logger.error("Mission Control entry observation registration failed")
                return false
            }
            registered = true
            logger.notice("Mission Control entry observation active")
        }
        active = true
        lastTopology = readTopology()
        return true
    }

    func stop() {
        active = false
        observationEpoch &+= 1
        observingExit = false
    }

    private func missionControlEntered() {
        guard active, !observingExit else { return }
        observationEpoch &+= 1
        observingExit = true
        let epoch = observationEpoch
        logger.debug("Mission Control entered; bounded exit observation started")
        scheduleExitCheck(Self.exitCheckDelay) { [weak self] in self?.checkForExit(epoch: epoch) }
    }

    private func checkForExit(epoch: UInt64) {
        guard observingExit, observationEpoch == epoch else { return }
        if isMissionControlVisible() {
            scheduleExitCheck(Self.exitCheckDelay) { [weak self] in self?.checkForExit(epoch: epoch) }
            return
        }

        observingExit = false
        guard let current = readTopology() else {
            logger.error("Mission Control exited but the Space topology was unavailable")
            return
        }
        guard lastTopology != current else {
            logger.debug("Mission Control exited with unchanged Space topology")
            return
        }
        lastTopology = current
        logger.notice(
            "Mission Control topology changed: displays=\(current.displays.count, privacy: .public) spaces=\(current.spaceCount, privacy: .public)"
        )
        onTopologyChanged?(current)
    }

    private static func isMissionControlVisible() -> Bool {
        let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)
            as? [[String: Any]] ?? []
        return windows.contains { info in
            guard info[kCGWindowName as String] == nil,
                  info[kCGWindowOwnerName as String] as? String == "Dock",
                  let layer = info[kCGWindowLayer as String] as? NSNumber
            else { return false }
            return layer.intValue == 18
        }
    }
}

@MainActor
private final class MissionControlEntrySource {
    static let shared = MissionControlEntrySource()

    private var handler: (@MainActor () -> Void)?
    private var skyLightRegistered = false
    private var accessibilityRegistered = false
    private var dockElement: AXUIElement?
    private var accessibilityObserver: AXObserver?

    func register(handler: @escaping @MainActor () -> Void) -> Bool {
        self.handler = handler
        if !skyLightRegistered {
            let context = Unmanaged.passUnretained(self).toOpaque()
            skyLightRegistered = SpacesProvider.registerMissionControlEntry(
                callback: skyLightMissionControlConnectionCallback,
                context: context
            )
        }
        if !accessibilityRegistered {
            accessibilityRegistered = registerDockAccessibilityEntry()
        }
        let operatingSystemMajorVersion = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        let registered = operatingSystemMajorVersion >= 12
            ? accessibilityRegistered
            : skyLightRegistered
        if !registered { self.handler = nil }
        return registered
    }

    func deliver() {
        handler?()
    }

    private func registerDockAccessibilityEntry() -> Bool {
        guard let dockPID = NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.apple.dock")
            .first?
            .processIdentifier
        else { return false }

        let element = AXUIElementCreateApplication(dockPID)
        var observer: AXObserver?
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard AXObserverCreate(dockPID, missionControlAccessibilityCallback, &observer) == .success,
              let observer
        else { return false }

        let notifications = [
            "AXExposeShowAllWindows",
            "AXExposeShowFrontWindows",
            "AXExposeShowDesktop",
        ]
        var addedEntryNotification = false
        for name in notifications {
            if AXObserverAddNotification(observer, element, name as CFString, context) == .success {
                addedEntryNotification = true
            }
        }
        guard addedEntryNotification else { return false }

        dockElement = element
        accessibilityObserver = observer
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )
        return true
    }
}

private func skyLightMissionControlConnectionCallback(
    type: UInt32,
    _: UnsafeMutableRawPointer?,
    _: Int,
    context: UnsafeMutableRawPointer?,
    _: Int32
) {
    guard type == 1_204, let context else { return }
    let contextAddress = UInt(bitPattern: context)
    DispatchQueue.main.async {
        MainActor.assumeIsolated {
            guard let context = UnsafeMutableRawPointer(bitPattern: contextAddress) else { return }
            Unmanaged<MissionControlEntrySource>
                .fromOpaque(context)
                .takeUnretainedValue()
                .deliver()
        }
    }
}

private func missionControlAccessibilityCallback(
    _: AXObserver,
    _: AXUIElement,
    notification: CFString,
    context: UnsafeMutableRawPointer?
) {
    guard let context,
          notification == "AXExposeShowAllWindows" as CFString
              || notification == "AXExposeShowFrontWindows" as CFString
              || notification == "AXExposeShowDesktop" as CFString
    else { return }
    let contextAddress = UInt(bitPattern: context)
    DispatchQueue.main.async {
        MainActor.assumeIsolated {
            guard let context = UnsafeMutableRawPointer(bitPattern: contextAddress) else { return }
            Unmanaged<MissionControlEntrySource>
                .fromOpaque(context)
                .takeUnretainedValue()
                .deliver()
        }
    }
}
