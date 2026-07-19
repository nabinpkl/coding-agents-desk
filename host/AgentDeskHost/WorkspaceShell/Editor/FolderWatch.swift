import CoreServices
import Foundation
import os

/// Watches a folder subtree for filesystem changes and fires a coalesced callback on the
/// main thread. Wraps FSEvents (the OS's recursive, batched directory watcher) so the file
/// tree can refresh itself when files appear, vanish, or change — instead of only on a
/// workspace switch.
///
/// FSEvents already batches bursts within its latency window; an extra debounce collapses a
/// multi-callback storm (a `git checkout`, a build) into one refresh. The callback runs on
/// the main thread, ready to touch AppKit. Main-thread use; `start` replaces any prior watch.
public final class FolderWatch {
    private var stream: FSEventStreamRef?
    private var pending: DispatchWorkItem?
    private var pendingPaths: Set<String> = []
    private let debounce: TimeInterval
    private let onChange: ([String]) -> Void
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskHost", category: "folder-watch")

    public init(debounce: TimeInterval = 0.3, onChange: @escaping ([String]) -> Void) {
        self.debounce = debounce
        self.onChange = onChange
    }

    deinit { stop() }

    /// Start watching `root` recursively, replacing any existing watch. The FSEvents
    /// callback hops here via the opaque `info` pointer (unretained — `FolderWatch` outlives
    /// the stream and `stop()`/`deinit` tear it down, so no cycle).
    public func start(root: URL) {
        stop()
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let watch = Unmanaged<FolderWatch>.fromOpaque(info).takeUnretainedValue()
            let changed = unsafeBitCast(paths, to: NSArray.self) as? [String] ?? []
            watch.handle(changedPaths: changed)
        }
        // UseCFTypes so the callback gets the changed paths as `[String]` (we filter them);
        // FileEvents for per-file granularity; NoDefer to fire the first event promptly.
        let flags = UInt32(
            kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagNoDefer
                | kFSEventStreamCreateFlagUseCFTypes
        )
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            [root.path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            debounce,
            flags
        ) else {
            logger.error("FSEventStreamCreate failed for \(root.path, privacy: .public)")
            return
        }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
        self.stream = stream
    }

    /// Stop and release the watch (idempotent).
    public func stop() {
        pending?.cancel()
        pending = nil
        pendingPaths.removeAll()
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    /// Decide whether a batch of changed paths warrants a refresh. We drop the noisy
    /// directories VS Code excludes by default (`.git/objects`, `.git/subtree-cache`,
    /// `node_modules`) — high-churn, irrelevant to the tree, and the source of refresh
    /// storms. We deliberately keep watching the rest of `.git` (index, HEAD, refs) so an
    /// external commit / stage / branch switch still refreshes decorations; our own status
    /// reads no longer write `.git/index` (GIT_OPTIONAL_LOCKS, see `GitStatusReader`), so
    /// that no longer loops.
    private func handle(changedPaths: [String]) {
        let relevant = changedPaths.filter { !Self.isNoise($0) }
        guard !relevant.isEmpty else { return }
        coalesce(paths: relevant)
    }

    private static let noiseSegments = ["/.git/objects/", "/.git/subtree-cache/", "/node_modules/"]

    private static func isNoise(_ path: String) -> Bool {
        noiseSegments.contains { path.contains($0) }
    }

    /// Collapse a burst of events into a single trailing-edge callback.
    private func coalesce(paths: [String]) {
        pendingPaths.formUnion(paths)
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let paths = self.pendingPaths.sorted()
            self.pendingPaths.removeAll()
            self.onChange(paths)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + debounce, execute: work)
    }
}
