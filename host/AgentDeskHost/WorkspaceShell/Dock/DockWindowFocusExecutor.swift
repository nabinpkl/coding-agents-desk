import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import os

struct DockWindowFocusRequest: Equatable, Sendable {
    let pid: pid_t
    let appName: String
    let windowID: UInt32?
    let title: String
    let role: String
    let subrole: String
    let isFocused: Bool
    let isMinimized: Bool
    let bounds: CGRect?
    let spaceIDs: [UInt64]
    let targetSpaceID: UInt64?
    let targetDisplayID: String?

    init(
        app: DockAppInstanceSummary,
        window: DockAppWindowSummary,
        group: DockDesktopGroupSummary
    ) {
        pid = app.pid
        appName = app.name
        windowID = window.windowID
        title = window.title
        role = window.role
        subrole = window.subrole
        isFocused = window.isFocused
        isMinimized = window.isMinimized
        bounds = window.bounds
        spaceIDs = window.spaceIDs
        targetSpaceID = group.spaceID
        targetDisplayID = group.displayID
    }

    static func onlyWindow(
        in instances: [DockAppInstanceSummary],
        group: DockDesktopGroupSummary
    ) -> DockWindowFocusRequest? {
        let requests = instances.flatMap { instance in
            instance.windows.map { window in
                DockWindowFocusRequest(app: instance, window: window, group: group)
            }
        }
        return requests.count == 1 ? requests[0] : nil
    }
}

/// A Desktop card action has no window identity: it only activates the card's
/// exact Space on its owning display. Keeping this separate from
/// `DockWindowFocusRequest` prevents a blank-card click from accidentally
/// performing Accessibility actions on one of its apps.
struct DockDesktopActivationRequest: Equatable, Sendable {
    let spaceID: UInt64
    let displayID: String
    let desktopLabel: String

    init?(group: DockDesktopGroupSummary) {
        guard let spaceID = group.spaceID, let displayID = group.displayID else {
            return nil
        }
        self.init(spaceID: spaceID, displayID: displayID, desktopLabel: group.desktopLabel)
    }

    init(spaceID: UInt64, displayID: String, desktopLabel: String) {
        self.spaceID = spaceID
        self.displayID = displayID
        self.desktopLabel = desktopLabel
    }
}

enum DockDesktopActivationError: Error, Equatable, LocalizedError {
    case spaceSwitchRejected(UInt64)
    case spaceSwitchTimedOut(UInt64)

    var errorDescription: String? {
        switch self {
        case .spaceSwitchRejected:
            return "The target Desktop could not be selected."
        case .spaceSwitchTimedOut:
            return "The target Desktop did not become active in time."
        }
    }
}

enum DockWindowFocusError: Error, Equatable, LocalizedError {
    case accessibilityPermissionRequired
    case unresolvedWindowID
    case unresolvedDesktop
    case staleWindow(UInt32)
    case staleDesktopMembership(UInt32, UInt64)
    case spaceSwitchRejected(UInt64)
    case spaceSwitchTimedOut(UInt64)
    case accessibilityReadFailed(Int32)
    case accessibilityWindowMissing(UInt32)
    case accessibilityWindowAmbiguous(UInt32)
    case accessibilityActionFailed(String, Int32)
    case applicationUnavailable(pid_t)
    case applicationActivationRejected(pid_t)

    var errorDescription: String? {
        switch self {
        case .accessibilityPermissionRequired:
            return "Accessibility permission is required to focus this window."
        case .unresolvedWindowID:
            return "This window has no resolvable system window id."
        case .unresolvedDesktop:
            return "This window's Desktop is no longer resolved."
        case .staleWindow:
            return "This window is no longer available."
        case .staleDesktopMembership:
            return "This window moved to another Desktop."
        case .spaceSwitchRejected:
            return "The target Desktop could not be selected."
        case .spaceSwitchTimedOut:
            return "The target Desktop did not become active in time."
        case .accessibilityReadFailed:
            return "The target app did not expose its windows to Accessibility."
        case .accessibilityWindowMissing:
            return "The target window did not appear after switching Desktops."
        case .accessibilityWindowAmbiguous:
            return "The target window could not be distinguished from another window."
        case .accessibilityActionFailed(let action, _):
            return "The target app rejected the \(action) focus action."
        case .applicationUnavailable:
            return "The target app is no longer running."
        case .applicationActivationRejected:
            return "The target app rejected activation."
        }
    }
}

@MainActor
protocol DockWindowFocusExecuting: AnyObject {
    func focus(_ request: DockWindowFocusRequest) async throws
    func activateDesktop(_ request: DockDesktopActivationRequest) async throws
}

struct DockAXWindowCandidate<Element> {
    let element: Element
    let facts: DockAXWindowFacts
}

@MainActor
protocol DockAXWindowAccessing {
    associatedtype Element

    func isTrusted() -> Bool
    func windows(for pid: pid_t) throws -> [DockAXWindowCandidate<Element>]
    func setMinimized(_ minimized: Bool, for element: Element) throws
    func setMain(_ main: Bool, for element: Element) throws
    func setFocused(_ focused: Bool, for element: Element) throws
    func raise(_ element: Element) throws
    func activate(pid: pid_t) throws
}

@MainActor
struct AXDockWindowAccess: DockAXWindowAccessing {
    func isTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    func windows(for pid: pid_t) throws -> [DockAXWindowCandidate<AXUIElement>] {
        let app = AXUIElementCreateApplication(pid)
        let timeoutResult = AXUIElementSetMessagingTimeout(app, AXDockWindowReader.messagingTimeout)
        guard timeoutResult == .success else {
            throw DockWindowFocusError.accessibilityReadFailed(Int32(timeoutResult.rawValue))
        }
        var rawWindows: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows)
        guard result == .success else {
            throw DockWindowFocusError.accessibilityReadFailed(Int32(result.rawValue))
        }
        guard let windows = rawWindows as? [AXUIElement] else { return [] }
        return windows.map { window in
            DockAXWindowCandidate(
                element: window,
                facts: AXDockWindowReader.windowFacts(window)
            )
        }
    }

    func setMinimized(_ minimized: Bool, for element: AXUIElement) throws {
        try setBoolean(minimized, attribute: kAXMinimizedAttribute, on: element)
    }

    func setMain(_ main: Bool, for element: AXUIElement) throws {
        try setBoolean(main, attribute: kAXMainAttribute, on: element)
    }

    func setFocused(_ focused: Bool, for element: AXUIElement) throws {
        try setBoolean(focused, attribute: kAXFocusedAttribute, on: element)
    }

    func raise(_ element: AXUIElement) throws {
        let result = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
        guard result == .success else {
            throw DockWindowFocusError.accessibilityActionFailed(
                "raise",
                Int32(result.rawValue)
            )
        }
    }

    func activate(pid: pid_t) throws {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw DockWindowFocusError.applicationUnavailable(pid)
        }
        guard app.activate() else {
            throw DockWindowFocusError.applicationActivationRejected(pid)
        }
    }

    private func setBoolean(
        _ value: Bool,
        attribute: String,
        on element: AXUIElement
    ) throws {
        let rawValue = NSNumber(value: value)
        let result = AXUIElementSetAttributeValue(element, attribute as CFString, rawValue)
        guard result == .success else {
            throw DockWindowFocusError.accessibilityActionFailed(
                attribute,
                Int32(result.rawValue)
            )
        }
    }
}

@MainActor
final class DockWindowFocusExecutor<AXAccess: DockAXWindowAccessing>: DockWindowFocusExecuting {
    private let desktopSwitcher: WorkspaceDesktopSwitcher
    private let desktopAudit: any WorkspaceDesktopAuditing
    private let cgWindows: any DockCGWindowReading
    private let axAccess: AXAccess
    private let logger = Logger(subsystem: Config.logSubsystem, category: "dock-window-focus")

    init(
        desktopSwitcher: WorkspaceDesktopSwitcher,
        desktopAudit: any WorkspaceDesktopAuditing = HostWorkspaceDesktopAudit(),
        cgWindows: any DockCGWindowReading = CGDockWindowReader(),
        axAccess: AXAccess
    ) {
        self.desktopSwitcher = desktopSwitcher
        self.desktopAudit = desktopAudit
        self.cgWindows = cgWindows
        self.axAccess = axAccess
    }

    func focus(_ request: DockWindowFocusRequest) async throws {
        logStage("validate", request: request)
        try Task.checkCancellation()
        guard axAccess.isTrusted() else {
            throw DockWindowFocusError.accessibilityPermissionRequired
        }
        guard let windowID = request.windowID else {
            throw DockWindowFocusError.unresolvedWindowID
        }
        _ = try liveCGWindow(matching: request, windowID: windowID)
        let liveMembership = try liveSpaceIDs(windowID: windowID)
        guard let targetSpaceID = request.targetSpaceID,
              let targetDisplayID = request.targetDisplayID else {
            throw DockWindowFocusError.unresolvedDesktop
        }
        guard liveMembership.contains(targetSpaceID) else {
            throw DockWindowFocusError.staleDesktopMembership(windowID, targetSpaceID)
        }

        let currentSpaceID = desktopSwitcher.currentSpaceID(on: targetDisplayID)
        if currentSpaceID.map({ $0 != targetSpaceID }) ?? true {
            logStage("switch-space", request: request)
            let result = try await desktopSwitcher.switchToDesktopAndWait(
                spaceID: targetSpaceID,
                displayID: targetDisplayID
            )
            switch result {
            case .reached:
                break
            case .rejected:
                throw DockWindowFocusError.spaceSwitchRejected(targetSpaceID)
            case .timedOut:
                throw DockWindowFocusError.spaceSwitchTimedOut(targetSpaceID)
            }
        } else {
            logStage("skip-space-switch", request: request)
        }

        logStage("reacquire", request: request)
        try Task.checkCancellation()
        let refreshedTarget = try liveCGWindow(matching: request, windowID: windowID)
        let candidates = try axAccess.windows(for: request.pid)
        let match = DockWindowMatcher.axWindow(
            matching: refreshedTarget,
            in: candidates.map(\.facts)
        )
        let candidate: DockAXWindowCandidate<AXAccess.Element>
        switch match {
        case .matched(let index):
            candidate = candidates[index]
        case .missing:
            throw DockWindowFocusError.accessibilityWindowMissing(windowID)
        case .ambiguous:
            throw DockWindowFocusError.accessibilityWindowAmbiguous(windowID)
        }

        logStage("focus", request: request)
        if candidate.facts.isMinimized {
            try axAccess.setMinimized(false, for: candidate.element)
        }
        try axAccess.setMain(true, for: candidate.element)
        try axAccess.setFocused(true, for: candidate.element)
        try axAccess.raise(candidate.element)
        try axAccess.activate(pid: request.pid)
    }

    func activateDesktop(_ request: DockDesktopActivationRequest) async throws {
        try Task.checkCancellation()
        let result = try await desktopSwitcher.switchToDesktopAndWait(
            spaceID: request.spaceID,
            displayID: request.displayID
        )
        switch result {
        case .reached:
            logger.notice(
                "desktop activation succeeded space=\(request.spaceID) display=\(request.displayID, privacy: .public)"
            )
        case .rejected:
            throw DockDesktopActivationError.spaceSwitchRejected(request.spaceID)
        case .timedOut:
            throw DockDesktopActivationError.spaceSwitchTimedOut(request.spaceID)
        }
    }

    private func logStage(_ stage: String, request: DockWindowFocusRequest) {
        logger.debug(
            "stage=\(stage, privacy: .public) pid=\(request.pid) window=\(request.windowID ?? 0) targetSpace=\(request.targetSpaceID ?? 0)"
        )
    }

    private func liveCGWindow(
        matching request: DockWindowFocusRequest,
        windowID: UInt32
    ) throws -> DockCGWindowFacts {
        guard let target = cgWindows.windows().first(where: {
            $0.pid == request.pid && $0.windowID == windowID
        }), DockWindowMatcher.isOrdinary(target) else {
            throw DockWindowFocusError.staleWindow(windowID)
        }
        let titleMatches = !target.title.isEmpty &&
            request.title != "Untitled Window" &&
            target.title == request.title
        let boundsMatch = request.bounds.map {
            DockWindowMatcher.close($0, to: target.bounds)
        } ?? false
        guard titleMatches || boundsMatch else {
            throw DockWindowFocusError.staleWindow(windowID)
        }
        return target
    }

    private func liveSpaceIDs(windowID: UInt32) throws -> [UInt64] {
        let snapshot = desktopAudit.snapshot()
        guard snapshot.diagnostic == nil,
              let window = snapshot.windows.first(where: { $0.windowID == windowID }) else {
            throw DockWindowFocusError.staleWindow(windowID)
        }
        return window.spaceIDs
    }
}
