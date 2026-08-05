import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalWebView
import WindowPlacement
import os

public protocol TerminalSessionListing: Sendable {
    func listSessions() async throws -> [PtySessionSummary]
}

extension PtyClient: TerminalSessionListing {}

@MainActor
public protocol TerminalExistingSessionSpawning: AnyObject {
    func spawnExistingWorkspace(
        sessions: [PtySessionSummary],
        state: PtyTerminalWorkspaceState,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    )
}

extension WebPtyManagerTerminalSpawn: TerminalExistingSessionSpawning {}

@MainActor
public protocol TerminalWindowDesktopPlacing: AnyObject {
    func present(
        _ window: any TerminalWindowPresentationTrackable,
        at placement: DesktopWindowPlacement,
        focus: Bool
    ) throws -> DesktopWindowPlacement

    func capture(
        _ window: any TerminalWindowPresentationTrackable,
        preserving placement: DesktopWindowPlacement
    ) throws -> DesktopWindowPlacement?
}

/// Explicit frame-only placement for the standalone replay harness. AgentDesk injects its verified
/// WindowServer implementation instead, so production never silently falls back to the active Space.
@MainActor
public final class FrameOnlyTerminalWindowDesktopPlacer: TerminalWindowDesktopPlacing {
    public init() {}

    public func present(
        _ window: any TerminalWindowPresentationTrackable,
        at placement: DesktopWindowPlacement,
        focus: Bool
    ) throws -> DesktopWindowPlacement {
        window.place(into: placement.frame)
        if focus { window.raise() } else { window.orderWithoutFocus() }
        return placement
    }

    public func capture(
        _ window: any TerminalWindowPresentationTrackable,
        preserving placement: DesktopWindowPlacement
    ) throws -> DesktopWindowPlacement? {
        var next = placement
        next.frame = window.currentFrame
        return next
    }
}

/// Owns only standalone-window presentation and attachment metadata. The Rust
/// manager remains the sole owner of terminal cells and replay history.
@MainActor
public final class TerminalWindowRegistry {
    private let store: TerminalWindowPresentationStore
    private let client: any TerminalSessionListing
    private let spawn: any TerminalExistingSessionSpawning
    private let desktopPlacer: any TerminalWindowDesktopPlacing
    private let logger: Logger
    private var windows: [UUID: any TerminalWindowPresentationTrackable] = [:]
    private var restoring: Set<UUID> = []
    private var unresolvedPlacements: Set<UUID> = []
    private var placementTasks: [UUID: Task<Void, Never>] = [:]
    private var workspaceTasks: [UUID: Task<Void, Never>] = [:]
    private var restorationTask: Task<Void, Never>?
    private var shuttingDown = false

    public init(
        store: TerminalWindowPresentationStore,
        client: any TerminalSessionListing,
        spawn: any TerminalExistingSessionSpawning,
        desktopPlacer: any TerminalWindowDesktopPlacing,
        loggerSubsystem: String = "com.example.agentdesk.AgentDeskTerminalReplay"
    ) {
        self.store = store
        self.client = client
        self.spawn = spawn
        self.desktopPlacer = desktopPlacer
        logger = Logger(subsystem: loggerSubsystem, category: "terminal-restoration")
    }

    /// The windows that are open right now, as the descriptors that describe them. The store also
    /// holds descriptors for windows a previous host run left behind and this one has not put back
    /// yet, which a chooser must not offer to go to; those are the ones filtered out here.
    ///
    /// Unordered on purpose: the store's order is last-written-first-forgotten and a live drag
    /// rewrites a descriptor, so the caller sorts by whatever it names windows with.
    public var openWindowPresentations: [TerminalWindowPresentationDescriptor] {
        store.descriptors.filter { windows[$0.id] != nil }
    }

    /// Brings one open window to the front of the Desktop it is already on. Which Desktop that is, and
    /// getting there first, belong to the host: this registry has no Spaces authority.
    public func raiseWindow(id: UUID) {
        guard !shuttingDown else { return }
        windows[id]?.raise()
    }

    /// Closes one window along the same path as its own close button, so it forfeits its stored
    /// presentation and does not come back on the next launch. Distinct from `prepareForHostTermination`,
    /// which closes everything and preserves it all.
    ///
    /// Unknown ids are ignored rather than trapped: a chooser can only hold the list as it was when it
    /// was opened, and the window may have closed itself since.
    public func closeWindow(id: UUID) {
        guard !shuttingDown else { return }
        windows[id]?.close()
    }

    public var openWindowDiagnostics: [UUID: TerminalWindowReplayDiagnostics] {
        windows.reduce(into: [:]) { result, entry in
            guard let window = entry.value as? any TerminalWindowReplayInspectable else { return }
            result[entry.key] = window.replayDiagnostics
        }
    }

    public func register(
        _ window: TerminalEmulatorWindow,
        sessionName: String,
        workspaceID: UUID?,
        workspaceLabel: String,
        cascadeOrdinal: Int,
        placement: DesktopWindowPlacement,
        focus: Bool,
        presentationID: UUID = UUID()
    ) {
        guard let tracked = window as? any TerminalWindowPresentationTrackable else { return }
        guard !shuttingDown else {
            tracked.closePreservingPresentation()
            return
        }
        let descriptor = TerminalWindowPresentationDescriptor(
            id: presentationID,
            workspace: tracked.terminalWorkspaceState,
            workspaceID: workspaceID,
            placement: placement,
            cascadeOrdinal: cascadeOrdinal,
            workspaceLabel: workspaceLabel
        )
        do {
            try store.upsert(descriptor)
            windows[presentationID] = tracked
        } catch {
            tracked.closePreservingPresentation()
            logger.error("terminal presentation registration failed: \(String(describing: error), privacy: .public)")
            return
        }
        tracked.observePresentation(
            frameChanged: { [weak self] frame in
                self?.schedulePlacement(frame: frame, id: presentationID)
            },
            workspaceChanged: { [weak self] workspace in
                self?.scheduleWorkspace(workspace, id: presentationID)
            },
            closed: { [weak self] _ in
                self?.removePresentation(id: presentationID)
            }
        )
        do {
            let resolved = try desktopPlacer.present(tracked, at: placement, focus: focus)
            unresolvedPlacements.remove(presentationID)
            if resolved != placement {
                var repaired = descriptor
                repaired.placement = resolved
                try store.upsert(repaired)
            }
        } catch {
            unresolvedPlacements.insert(presentationID)
            windows.removeValue(forKey: presentationID)
            tracked.closePreservingPresentation()
            logger.error("terminal Desktop placement failed: \(String(describing: error), privacy: .public)")
        }
    }

    public func startRestoration() {
        guard !shuttingDown, restorationTask == nil else { return }
        restorationTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    let sessions = try await client.listSessions()
                    restore(using: sessions)
                    restorationTask = nil
                    return
                } catch {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
        }
    }

    public func prepareForHostTermination() {
        shuttingDown = true
        restorationTask?.cancel()
        restorationTask = nil
        for task in placementTasks.values { task.cancel() }
        placementTasks.removeAll()
        for task in workspaceTasks.values { task.cancel() }
        workspaceTasks.removeAll()
        let openWindows = windows.values
        windows.removeAll()
        restoring.removeAll()
        unresolvedPlacements.removeAll()
        for window in openWindows { window.closePreservingPresentation() }
    }

    private func restore(using sessions: [PtySessionSummary]) {
        let running = Dictionary(uniqueKeysWithValues: sessions
            .filter { $0.state == .running }
            .map { ($0.name, $0) })
        for descriptor in store.descriptors {
            guard windows[descriptor.id] == nil, !restoring.contains(descriptor.id) else { continue }
            let sessions = descriptor.sessionNames.compactMap { running[$0] }
            guard sessions.count == descriptor.sessionNames.count else {
                do {
                    try store.remove(id: descriptor.id)
                } catch {
                    logger.error("terminal stale presentation removal failed: \(String(describing: error), privacy: .public)")
                }
                continue
            }
            var placement = descriptor.placement
            placement.frame = constrainedFrame(placement.frame)
            restoring.insert(descriptor.id)
            spawn.spawnExistingWorkspace(
                sessions: sessions,
                state: descriptor.workspace,
                into: placement.frame
            ) { [weak self] result in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.restoring.remove(descriptor.id)
                    guard !self.shuttingDown else {
                        if case .success(let window) = result { window.close() }
                        return
                    }
                    switch result {
                    case .success(let window):
                        window.setWorkspaceLabel(descriptor.workspaceLabel)
                        self.register(
                            window,
                            sessionName: descriptor.sessionName,
                            workspaceID: descriptor.workspaceID,
                            workspaceLabel: descriptor.workspaceLabel,
                            cascadeOrdinal: descriptor.cascadeOrdinal,
                            placement: placement,
                            focus: false,
                            presentationID: descriptor.id
                        )
                    case .failure:
                        // A reachable manager can disappear during attachment.
                        // Keep metadata and retry on the next readiness cycle.
                        self.restorationTask = nil
                        self.startRestoration()
                    }
                }
            }
        }
    }

    private func schedulePlacement(frame _: CGRect, id: UUID) {
        guard !shuttingDown else { return }
        placementTasks[id]?.cancel()
        placementTasks[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self,
                  !self.unresolvedPlacements.contains(id),
                  let window = self.windows[id],
                  var descriptor = self.store.descriptors.first(where: { $0.id == id }) else { return }
            do {
                guard let placement = try self.desktopPlacer.capture(
                    window,
                    preserving: descriptor.placement
                ) else { return }
                descriptor.placement = placement
                try self.store.upsert(descriptor)
            } catch {
                self.logger.error("terminal Desktop capture failed: \(String(describing: error), privacy: .public)")
            }
            self.placementTasks[id] = nil
        }
    }

    private func scheduleWorkspace(_ workspace: PtyTerminalWorkspaceState, id: UUID) {
        guard !shuttingDown else { return }
        workspaceTasks[id]?.cancel()
        workspaceTasks[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self,
                  var descriptor = self.store.descriptors.first(where: { $0.id == id }) else { return }
            descriptor = TerminalWindowPresentationDescriptor(
                id: descriptor.id,
                workspace: workspace,
                workspaceID: descriptor.workspaceID,
                placement: descriptor.placement,
                cascadeOrdinal: descriptor.cascadeOrdinal,
                workspaceLabel: descriptor.workspaceLabel
            )
            do {
                try self.store.upsert(descriptor)
            } catch {
                self.logger.error("terminal workspace presentation persist failed: \(String(describing: error), privacy: .public)")
            }
            self.workspaceTasks[id] = nil
        }
    }

    private func removePresentation(id: UUID) {
        guard !shuttingDown else { return }
        placementTasks.removeValue(forKey: id)?.cancel()
        workspaceTasks.removeValue(forKey: id)?.cancel()
        unresolvedPlacements.remove(id)
        windows.removeValue(forKey: id)
        do {
            try store.remove(id: id)
        } catch {
            logger.error("terminal presentation removal failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func constrainedFrame(_ frame: CGRect) -> CGRect {
        let screens = NSScreen.screens.map(\.visibleFrame)
        guard !screens.isEmpty else { return frame }
        let target = screens.max { lhs, rhs in
            intersectionArea(lhs, frame) < intersectionArea(rhs, frame)
        } ?? screens[0]
        let width = min(frame.width, target.width)
        let height = min(frame.height, target.height)
        let maximumX = target.maxX - width
        let maximumY = target.maxY - height
        return CGRect(
            x: min(max(frame.minX, target.minX), maximumX),
            y: min(max(frame.minY, target.minY), maximumY),
            width: width,
            height: height
        )
    }

    private func intersectionArea(_ lhs: CGRect, _ rhs: CGRect) -> CGFloat {
        let intersection = lhs.intersection(rhs)
        guard !intersection.isNull else { return 0 }
        return intersection.width * intersection.height
    }
}
