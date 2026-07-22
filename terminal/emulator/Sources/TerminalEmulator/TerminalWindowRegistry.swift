import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalWebView
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

/// Owns only standalone-window presentation and attachment metadata. The Rust
/// manager remains the sole owner of terminal cells and replay history.
@MainActor
public final class TerminalWindowRegistry {
    private let store: TerminalWindowPresentationStore
    private let client: any TerminalSessionListing
    private let spawn: any TerminalExistingSessionSpawning
    private let logger: Logger
    private var windows: [UUID: any TerminalWindowPresentationTrackable] = [:]
    private var restoring: Set<UUID> = []
    private var frameTasks: [UUID: Task<Void, Never>] = [:]
    private var workspaceTasks: [UUID: Task<Void, Never>] = [:]
    private var restorationTask: Task<Void, Never>?
    private var shuttingDown = false

    public init(
        store: TerminalWindowPresentationStore,
        client: any TerminalSessionListing,
        spawn: any TerminalExistingSessionSpawning,
        loggerSubsystem: String = "com.example.agentdesk.AgentDeskTerminalReplay"
    ) {
        self.store = store
        self.client = client
        self.spawn = spawn
        logger = Logger(subsystem: loggerSubsystem, category: "terminal-restoration")
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
            frame: TerminalWindowFrame(tracked.currentFrame),
            cascadeOrdinal: cascadeOrdinal,
            workspaceLabel: workspaceLabel
        )
        do {
            try store.upsert(descriptor)
            windows[presentationID] = tracked
        } catch {
            logger.error("terminal presentation registration failed")
            return
        }
        tracked.observePresentation(
            frameChanged: { [weak self] frame in
                self?.scheduleFrame(frame, id: presentationID)
            },
            workspaceChanged: { [weak self] workspace in
                self?.scheduleWorkspace(workspace, id: presentationID)
            },
            closed: { [weak self] _ in
                self?.removePresentation(id: presentationID)
            }
        )
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
        for task in frameTasks.values { task.cancel() }
        frameTasks.removeAll()
        for task in workspaceTasks.values { task.cancel() }
        workspaceTasks.removeAll()
        let openWindows = windows.values
        windows.removeAll()
        restoring.removeAll()
        for window in openWindows { window.closePreservingPresentation() }
    }

    private func restore(using sessions: [PtySessionSummary]) {
        let running = Dictionary(uniqueKeysWithValues: sessions
            .filter { $0.state == .running && $0.lifetime == .persistent }
            .map { ($0.name, $0) })
        for descriptor in store.descriptors {
            guard windows[descriptor.id] == nil, !restoring.contains(descriptor.id) else { continue }
            let sessions = descriptor.sessionNames.compactMap { running[$0] }
            guard sessions.count == descriptor.sessionNames.count else {
                try? store.remove(id: descriptor.id)
                continue
            }
            let frame = constrainedFrame(descriptor.frame.cgRect)
            restoring.insert(descriptor.id)
            spawn.spawnExistingWorkspace(
                sessions: sessions,
                state: descriptor.workspace,
                into: frame
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
                            presentationID: descriptor.id
                        )
                        (window as? any TerminalWindowPresentationTrackable)?.orderWithoutFocus()
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

    private func scheduleFrame(_ frame: CGRect, id: UUID) {
        guard !shuttingDown else { return }
        frameTasks[id]?.cancel()
        frameTasks[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 200_000_000)
            guard !Task.isCancelled, let self,
                  var descriptor = self.store.descriptors.first(where: { $0.id == id }) else { return }
            descriptor.frame = TerminalWindowFrame(frame)
            try? self.store.upsert(descriptor)
            self.frameTasks[id] = nil
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
                frame: descriptor.frame,
                cascadeOrdinal: descriptor.cascadeOrdinal,
                workspaceLabel: descriptor.workspaceLabel
            )
            try? self.store.upsert(descriptor)
            self.workspaceTasks[id] = nil
        }
    }

    private func removePresentation(id: UUID) {
        guard !shuttingDown else { return }
        frameTasks.removeValue(forKey: id)?.cancel()
        workspaceTasks.removeValue(forKey: id)?.cancel()
        windows.removeValue(forKey: id)
        try? store.remove(id: id)
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
