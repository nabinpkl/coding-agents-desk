import Foundation

@MainActor
protocol DockEnrichmentRendering: AnyObject {
    func render(_ snapshot: DockAppSnapshot)
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

/// Drives the dock-enrichment panel: takes a snapshot off the main thread (the reader does AX/CG/
/// SkyLight reads), then renders on the main actor. Coalesces overlapping refreshes with a
/// generation token so only the latest snapshot renders, and defers a refresh requested mid-snapshot.
@MainActor
final class DockEnrichmentPresenter {
    private let reader: DockAppSnapshotReader
    private weak var renderer: DockEnrichmentRendering?
    private let snapshotScheduler: DockSnapshotScheduling
    private(set) var isVisible = false
    private var generation = 0
    private var isSnapshotRunning = false
    private var pendingRefresh = false

    init(
        reader: DockAppSnapshotReader,
        renderer: DockEnrichmentRendering,
        snapshotScheduler: DockSnapshotScheduling = DispatchDockSnapshotScheduler(queue: DispatchQueue.global(qos: .utility))
    ) {
        self.reader = reader
        self.renderer = renderer
        self.snapshotScheduler = snapshotScheduler
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

    func refreshIfVisible() {
        guard isVisible else { return }
        requestRefresh()
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
        renderer?.render(snapshot)
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
}
