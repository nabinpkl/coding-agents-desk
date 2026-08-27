import AppKit
import ApplicationServices
import Foundation
import os

enum CodexWindowLaunchError: Error, Equatable, Sendable, CustomStringConvertible {
    case desktopAuditUnavailable(String)
    case targetDesktopUnavailable(spaceID: UInt64)
    case multipleApplications([pid_t])
    case applicationNotFound(String)
    case applicationLaunchTimedOut
    case applicationLaunchFailed(String)
    case accessibilityPermissionMissing
    case fileMenuMissing(String)
    case newWindowCommandMissing(String)
    case newWindowCommandDisabled(String)
    case newWindowCommandFailed
    case windowAppearanceTimedOut
    case ambiguousNewWindows([UInt32])
    case placementFailed(windowID: UInt32, spaceID: UInt64, reason: String)

    var description: String {
        switch self {
        case .desktopAuditUnavailable(let diagnostic):
            return "Desktop audit unavailable: \(diagnostic)"
        case .targetDesktopUnavailable(let spaceID):
            return "The requested Desktop is no longer available (Space \(spaceID))"
        case .multipleApplications(let pids):
            return "More than one Codex Desktop application is running (pids \(pids))"
        case .applicationNotFound(let bundleIdentifier):
            return "Codex Desktop is not installed (bundle \(bundleIdentifier))"
        case .applicationLaunchTimedOut:
            return "Codex Desktop did not finish launching"
        case .applicationLaunchFailed(let reason):
            return "Codex Desktop could not be launched: \(reason)"
        case .accessibilityPermissionMissing:
            return "Accessibility permission is required to invoke Codex Desktop's New Window command"
        case .fileMenuMissing(let title):
            return "Codex Desktop's \(title) menu is unavailable"
        case .newWindowCommandMissing(let title):
            return "Codex Desktop's \(title) command is unavailable"
        case .newWindowCommandDisabled(let title):
            return "Codex Desktop's \(title) command is disabled"
        case .newWindowCommandFailed:
            return "Codex Desktop refused its New Window command"
        case .windowAppearanceTimedOut:
            return "Codex Desktop did not create a window in time"
        case .ambiguousNewWindows(let windowIDs):
            return "More than one new Codex window appeared; refusing to guess between \(windowIDs)"
        case .placementFailed(let windowID, let spaceID, let reason):
            return "Could not place Codex window \(windowID) on Space \(spaceID): \(reason)"
        }
    }
}

/// The external-application operations needed to create one Codex Desktop window.
///
/// Kept behind a seam because both branches change another application's state: an already-running
/// app receives its native File > New Window action, while an absent app is launched and its initial
/// window is the requested window. The launcher must never do both or one click would create two.
protocol CodexDesktopApplicationOpening {
    func runningMainPID() throws -> pid_t?
    func launch() throws -> pid_t
    func requestNewWindow(mainPID: pid_t) throws
}

/// Opens one Codex Desktop window and proves which WindowServer window was created before placing it.
///
/// The whole before/request/after sequence is serialized off the main thread. Without that ownership,
/// two quick clicks could each observe the other's window and both move the wrong one. Existing window
/// ids are captured before the request; exactly one new layer-zero window must appear for the owning
/// pid. Zero waits to a bound, and more than one fails without moving anything.
final class CodexWindowLauncher: @unchecked Sendable {
    private let application: CodexDesktopApplicationOpening
    private let audit: WorkspaceDesktopAuditing
    private let mover: AgentWindowDesktopMoving
    private let pollAttempts: Int
    private let pollInterval: TimeInterval
    private let queue = DispatchQueue(label: Config.dispatchQueuePrefix + ".codex-window-launcher")
    private let logger = Logger(subsystem: Config.logSubsystem, category: "codex-window-launcher")

    init(
        application: CodexDesktopApplicationOpening = LiveCodexDesktopApplicationAccess(),
        audit: WorkspaceDesktopAuditing = HostWorkspaceDesktopAudit(),
        mover: AgentWindowDesktopMoving = BridgedWindowSpaceMover(),
        pollAttempts: Int = Config.codexWindowOpenPollAttempts,
        pollInterval: TimeInterval = Config.codexWindowOpenPollInterval
    ) {
        self.application = application
        self.audit = audit
        self.mover = mover
        self.pollAttempts = max(1, pollAttempts)
        self.pollInterval = max(0, pollInterval)
    }

    /// UI entry point. Completion returns to the main actor so the presenter can show a native error
    /// without reaching across actor boundaries from this launcher's blocking worker queue.
    func open(
        on desktop: WorkspaceDesktopAssignment,
        completion: @escaping @MainActor (Result<UInt32, CodexWindowLaunchError>) -> Void
    ) {
        queue.async { [self] in
            let result: Result<UInt32, CodexWindowLaunchError>
            do {
                result = .success(try openNow(on: desktop))
            } catch let error as CodexWindowLaunchError {
                logger.error("codex window launch failed: \(error.description, privacy: .public)")
                result = .failure(error)
            } catch {
                let wrapped = CodexWindowLaunchError.applicationLaunchFailed(String(describing: error))
                logger.error("codex window launch failed: \(wrapped.description, privacy: .public)")
                result = .failure(wrapped)
            }
            Task { @MainActor in completion(result) }
        }
    }

    /// Synchronous core for deterministic tests. Production calls it only on `queue`.
    func openNow(on desktop: WorkspaceDesktopAssignment) throws -> UInt32 {
        let before = audit.snapshot()
        try validate(before, contains: desktop)

        let runningPID = try application.runningMainPID()
        let existingWindowIDs = runningPID.map { windowIDs(in: before, ownerPID: $0) } ?? []
        let mainPID: pid_t
        if let runningPID {
            mainPID = runningPID
            try application.requestNewWindow(mainPID: runningPID)
        } else {
            mainPID = try application.launch()
        }

        for attempt in 0..<pollAttempts {
            let current = audit.snapshot()
            if let diagnostic = current.diagnostic {
                throw CodexWindowLaunchError.desktopAuditUnavailable(diagnostic)
            }
            let candidates = current.windows
                .filter {
                    $0.ownerPID == mainPID
                        && $0.layer == 0
                        && !existingWindowIDs.contains($0.windowID)
                }
                .sorted { $0.windowID < $1.windowID }

            switch candidates.count {
            case 1:
                let window = candidates[0]
                if window.spaceIDs != [desktop.spaceID] {
                    do {
                        try mover.move(windowID: window.windowID, toSpaceID: desktop.spaceID)
                    } catch {
                        throw CodexWindowLaunchError.placementFailed(
                            windowID: window.windowID,
                            spaceID: desktop.spaceID,
                            reason: String(describing: error)
                        )
                    }
                }
                logger.notice(
                    "opened codex window=\(window.windowID, privacy: .public) targetSpace=\(desktop.spaceID, privacy: .public) moved=\(window.spaceIDs != [desktop.spaceID], privacy: .public)"
                )
                return window.windowID
            case 2...:
                throw CodexWindowLaunchError.ambiguousNewWindows(candidates.map(\.windowID))
            default:
                if attempt + 1 < pollAttempts, pollInterval > 0 {
                    Thread.sleep(forTimeInterval: pollInterval)
                }
            }
        }
        throw CodexWindowLaunchError.windowAppearanceTimedOut
    }

    private func validate(
        _ snapshot: WorkspaceDesktopSnapshot,
        contains desktop: WorkspaceDesktopAssignment
    ) throws {
        if let diagnostic = snapshot.diagnostic {
            throw CodexWindowLaunchError.desktopAuditUnavailable(diagnostic)
        }
        guard snapshot.desktops.contains(where: { $0.id == desktop.spaceID }) else {
            throw CodexWindowLaunchError.targetDesktopUnavailable(spaceID: desktop.spaceID)
        }
    }

    private func windowIDs(in snapshot: WorkspaceDesktopSnapshot, ownerPID: pid_t) -> Set<UInt32> {
        Set(snapshot.windows.lazy.filter { $0.ownerPID == ownerPID && $0.layer == 0 }.map(\.windowID))
    }
}

/// Live Codex Desktop access. Menu titles are configuration because they are another application's
/// localized/private UI strings and can change independently of AgentDesk.
private struct LiveCodexDesktopApplicationAccess: CodexDesktopApplicationOpening {
    func runningMainPID() throws -> pid_t? {
        let pids = AgentWindowProcessTable.codexMainPids(
            in: AgentWindowProcessTable.liveProcessRows(),
            mainPath: Config.codexMainPath
        )
        guard pids.count <= 1 else { throw CodexWindowLaunchError.multipleApplications(pids) }
        return pids.first
    }

    func launch() throws -> pid_t {
        guard let applicationURL = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: Config.codexBundleIdentifier
        ) else {
            throw CodexWindowLaunchError.applicationNotFound(Config.codexBundleIdentifier)
        }

        let semaphore = DispatchSemaphore(value: 0)
        let result = CodexApplicationLaunchResult()
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: applicationURL, configuration: configuration) { application, error in
            if let application {
                result.store(.success(application.processIdentifier))
            } else {
                result.store(.failure(.applicationLaunchFailed(error?.localizedDescription ?? "unknown error")))
            }
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + Config.codexApplicationLaunchTimeout) == .success else {
            throw CodexWindowLaunchError.applicationLaunchTimedOut
        }
        return try result.load().get()
    }

    func requestNewWindow(mainPID: pid_t) throws {
        guard AXIsProcessTrusted() else {
            throw CodexWindowLaunchError.accessibilityPermissionMissing
        }
        let application = AXUIElementCreateApplication(mainPID)
        guard let menuBar = elementAttribute(application, kAXMenuBarAttribute) else {
            throw CodexWindowLaunchError.fileMenuMissing(Config.codexFileMenuTitle)
        }
        guard let fileMenuBarItem = childElements(menuBar).first(where: {
            stringAttribute($0, kAXRoleAttribute) == kAXMenuBarItemRole
                && stringAttribute($0, kAXTitleAttribute) == Config.codexFileMenuTitle
        }), let fileMenu = childElements(fileMenuBarItem).first(where: {
            stringAttribute($0, kAXRoleAttribute) == kAXMenuRole
        }) else {
            throw CodexWindowLaunchError.fileMenuMissing(Config.codexFileMenuTitle)
        }
        guard let command = childElements(fileMenu).first(where: {
            stringAttribute($0, kAXRoleAttribute) == kAXMenuItemRole
                && stringAttribute($0, kAXTitleAttribute) == Config.codexNewWindowMenuItemTitle
        }) else {
            throw CodexWindowLaunchError.newWindowCommandMissing(Config.codexNewWindowMenuItemTitle)
        }
        guard boolAttribute(command, kAXEnabledAttribute) != false else {
            throw CodexWindowLaunchError.newWindowCommandDisabled(Config.codexNewWindowMenuItemTitle)
        }
        guard AXUIElementPerformAction(command, kAXPressAction as CFString) == .success else {
            throw CodexWindowLaunchError.newWindowCommandFailed
        }
    }

    private func elementAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let raw,
              CFGetTypeID(raw) == AXUIElementGetTypeID()
        else { return nil }
        return (raw as! AXUIElement)
    }

    private func childElements(_ element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
              let children = raw as? [AXUIElement]
        else { return [] }
        return children
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return "" }
        return raw as? String ?? ""
    }

    private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success else { return nil }
        return raw as? Bool
    }
}

private final class CodexApplicationLaunchResult: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<pid_t, CodexWindowLaunchError>?

    func store(_ result: Result<pid_t, CodexWindowLaunchError>) {
        lock.withLock { self.result = result }
    }

    func load() -> Result<pid_t, CodexWindowLaunchError> {
        lock.withLock { result ?? .failure(.applicationLaunchFailed("launch returned no result")) }
    }
}
