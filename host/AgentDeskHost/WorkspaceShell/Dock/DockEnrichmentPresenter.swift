import Foundation
import os

@MainActor
protocol DockEnrichmentRendering: AnyObject {
    func render(_ snapshot: DockAppSnapshot, swapState: DockDesktopSwapState)
    func renderWindowFocusFailure(_ message: String?)
}

protocol DockSnapshotScheduling: Sendable {
    func async(_ work: @escaping @Sendable () -> Void)
}

struct DispatchDockSnapshotScheduler: DockSnapshotScheduling {
    let queue: DispatchQueue

    func async(_ work: @escaping @Sendable () -> Void) {
        queue.async(execute: work)
    }
}

@MainActor
protocol DockUndoTiming: AnyObject {
    func schedule(_ action: @escaping @MainActor () -> Void)
    func cancel()
}

@MainActor
final class TaskDockUndoTimer: DockUndoTiming {
    private let delay: Duration
    private var task: Task<Void, Never>?

    init(delay: Duration = .seconds(8)) {
        self.delay = delay
    }

    func schedule(_ action: @escaping @MainActor () -> Void) {
        cancel()
        task = Task { [delay] in
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            action()
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}

/// Owns the Dock's snapshot lifecycle and the complete desktop-swap interaction. The renderer receives
/// immutable snapshot/state pairs; yabai effects remain behind `DockDesktopSwapExecuting`, and the
/// presenter alone owns operation lifetime, held-reveal publication, and the Undo expiry timer.
@MainActor
final class DockEnrichmentPresenter {
    private let reader: any DockAppSnapshotReading
    private weak var renderer: DockEnrichmentRendering?
    private let snapshotScheduler: DockSnapshotScheduling
    private let swapExecutor: any DockDesktopSwapExecuting
    private let focusExecutor: any DockWindowFocusExecuting
    private let undoTimer: any DockUndoTiming
    private let swapLogger = Logger(subsystem: Config.logSubsystem, category: "dock-desktop-swap")
    private let focusLogger = Logger(subsystem: Config.logSubsystem, category: "dock-window-focus")
    private(set) var isVisible = false
    private(set) var swapState = DockDesktopSwapState.idle
    private var machine = DockDesktopSwapStateMachine()
    private var latestSnapshot = DockAppSnapshot(desktopGroups: [])
    private var generation = 0
    private var isSnapshotRunning = false
    private var pendingRefresh = false
    private var operationTask: Task<Void, Never>?
    private var focusTask: Task<Void, Never>?
    private var focusGeneration = 0
    private var publishedHeld = false

    var onInteractionHeldChange: ((Bool) -> Void)?

    init(
        reader: any DockAppSnapshotReading,
        renderer: DockEnrichmentRendering,
        snapshotScheduler: DockSnapshotScheduling = DispatchDockSnapshotScheduler(
            queue: DispatchQueue.global(qos: .utility)
        ),
        swapExecutor: any DockDesktopSwapExecuting = DockDesktopSwapExecutor(),
        focusExecutor: any DockWindowFocusExecuting,
        undoTimer: any DockUndoTiming = TaskDockUndoTimer()
    ) {
        self.reader = reader
        self.renderer = renderer
        self.snapshotScheduler = snapshotScheduler
        self.swapExecutor = swapExecutor
        self.focusExecutor = focusExecutor
        self.undoTimer = undoTimer
    }

    func setVisible(_ visible: Bool) {
        let becameVisible = visible && !isVisible
        isVisible = visible
        if !visible {
            generation += 1
            pendingRefresh = false
        }
        if becameVisible {
            refreshIfVisible()
        }
    }

    func stop() {
        operationTask?.cancel()
        operationTask = nil
        cancelWindowFocus()
        undoTimer.cancel()
        isVisible = false
        generation += 1
        pendingRefresh = false
        machine.reset()
        publish()
    }

    func refreshIfVisible() {
        guard isVisible else { return }
        requestRefresh()
    }

    func toggleSwap() {
        cancelWindowFocus()
        renderer?.renderWindowFocusFailure(nil)
        apply(.toggle)
    }

    func focusWindow(_ request: DockWindowFocusRequest) {
        guard !swapState.holdsDock else { return }
        cancelWindowFocus()
        renderer?.renderWindowFocusFailure(nil)
        focusGeneration += 1
        let token = focusGeneration
        focusTask = Task { [weak self, focusExecutor, focusLogger] in
            do {
                try await focusExecutor.focus(request)
                guard !Task.isCancelled, let self, token == self.focusGeneration else { return }
                focusLogger.notice(
                    "dock window focus succeeded pid=\(request.pid) window=\(request.windowID ?? 0) targetSpace=\(request.targetSpaceID ?? 0)"
                )
                self.renderer?.renderWindowFocusFailure(nil)
                self.focusTask = nil
                self.refreshIfVisible()
            } catch is CancellationError {
                return
            } catch {
                guard !Task.isCancelled, let self, token == self.focusGeneration else { return }
                focusLogger.error(
                    "dock window focus failed pid=\(request.pid) window=\(request.windowID ?? 0) targetSpace=\(request.targetSpaceID ?? 0) error=\(String(describing: error), privacy: .public)"
                )
                self.renderer?.renderWindowFocusFailure(error.localizedDescription)
                self.focusTask = nil
                self.refreshIfVisible()
            }
        }
    }

    func selectDesktop(_ selection: DockDesktopSwapSelection) {
        apply(.select(selection))
    }

    func undo() {
        apply(.undo)
    }

    func cancelInteraction() {
        apply(.cancel)
    }

    private func apply(_ event: DockDesktopSwapEvent) {
        let effect = machine.send(event)
        syncTimer(for: event)
        publish()
        if let effect { execute(effect) }
    }

    private func syncTimer(for event: DockDesktopSwapEvent) {
        switch event {
        case .swapSucceeded:
            undoTimer.schedule { [weak self] in self?.apply(.undoExpired) }
        case .undo, .undoExpired, .cancel, .toggle, .operationFailed:
            if !machine.state.isUndoAvailable {
                undoTimer.cancel()
            }
        case .select, .undoSucceeded:
            break
        }
    }

    private func execute(_ effect: DockDesktopSwapEffect) {
        operationTask?.cancel()
        operationTask = Task { [weak self, swapExecutor, swapLogger] in
            do {
                switch effect {
                case .swap(let sourceSpaceID, let destinationSpaceID):
                    let receipt = try await swapExecutor.swap(
                        sourceSpaceID: sourceSpaceID,
                        destinationSpaceID: destinationSpaceID
                    )
                    guard !Task.isCancelled else { return }
                    swapLogger.notice(
                        "dock desktop swap succeeded source=\(sourceSpaceID) destination=\(destinationSpaceID) sourceWindows=\(receipt.sourceWindowIDs.count) destinationWindows=\(receipt.destinationWindowIDs.count)"
                    )
                    self?.apply(.swapSucceeded(receipt))
                case .undo(let receipt):
                    let result = try await swapExecutor.undo(receipt)
                    guard !Task.isCancelled else { return }
                    swapLogger.notice(
                        "dock desktop undo succeeded restored=\(result.restoredWindowIDs.count) skipped=\(result.skippedWindowIDs.count)"
                    )
                    self?.apply(.undoSucceeded)
                }
                self?.refreshIfVisible()
            } catch {
                guard !Task.isCancelled else { return }
                swapLogger.error("dock desktop operation failed: \(String(describing: error), privacy: .public)")
                self?.apply(.operationFailed(error.localizedDescription))
            }
        }
    }

    private func publish() {
        swapState = machine.state
        renderer?.render(latestSnapshot, swapState: swapState)
        let held = swapState.holdsDock
        guard held != publishedHeld else { return }
        publishedHeld = held
        onInteractionHeldChange?(held)
    }

    private func requestRefresh() {
        guard isVisible else { return }
        if isSnapshotRunning {
            pendingRefresh = true
            return
        }
        isSnapshotRunning = true
        generation += 1
        let token = generation
        snapshotScheduler.async { [reader] in
            let snapshot = reader.snapshot()
            Task { @MainActor [weak self] in self?.finish(snapshot, token: token) }
        }
    }

    private func finish(_ snapshot: DockAppSnapshot, token: Int) {
        isSnapshotRunning = false
        guard token == generation, isVisible else {
            schedulePendingRefreshIfNeeded()
            return
        }
        latestSnapshot = snapshot
        publish()
        schedulePendingRefreshIfNeeded()
    }

    private func schedulePendingRefreshIfNeeded() {
        guard isVisible, pendingRefresh else {
            pendingRefresh = false
            return
        }
        pendingRefresh = false
        requestRefresh()
    }

    private func cancelWindowFocus() {
        focusTask?.cancel()
        focusTask = nil
        focusGeneration += 1
    }
}

private extension DockDesktopSwapState {
    var isUndoAvailable: Bool {
        if case .undoAvailable = self { return true }
        return false
    }
}
