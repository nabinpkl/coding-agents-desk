import Foundation
import os
import OSLog
import UIKit

/// What a drained unified-log entry becomes, decided without touching OSLog itself.
///
/// Split out so the two decisions worth arguing about -- which entries are worth keeping under
/// budget pressure, and which have already been taken -- are testable without a log store.
enum OSLogDrainPolicy {
    /// Maps a log level onto the retention classes the run budget sacrifices in order.
    ///
    /// The level the code already chose IS the classification: `.notice` upward is what the
    /// dial, capture, and session paths use for the lines worth reading later, and `.debug` /
    /// `.info` is where per-frame chatter goes. Nothing new has to be annotated for this.
    static func retention(for level: OSLogEntryLog.Level) -> DiagnosticsRetention {
        switch level {
        case .notice, .error, .fault:
            return .lifecycle
        case .debug, .info, .undefined:
            return .stream
        @unknown default:
            // A level this build does not know is not evidence it is unimportant, and the
            // lifecycle class is the one that survives.
            return .lifecycle
        }
    }

    /// Whether an entry is past the point the last drain reached.
    ///
    /// Strictly after, not at: `position(date:)` is inclusive, so the boundary entry comes back
    /// on the next drain and would be stored twice. The cost is an entry sharing a `Date` to
    /// sub-microsecond precision with the boundary, which is dropped rather than duplicated --
    /// a duplicate would be indistinguishable from the event genuinely happening twice.
    static func shouldEmit(entryDate: Date, after boundary: Date?) -> Bool {
        guard let boundary else { return true }
        return entryDate > boundary
    }

    /// The fields a drained entry contributes, beyond the timestamp the store stamps for it.
    static func fields(category: String, level: OSLogEntryLog.Level, message: String) -> [String: String] {
        [
            "category": category,
            "level": name(of: level),
            "message": message
        ]
    }

    private static func name(of level: OSLogEntryLog.Level) -> String {
        switch level {
        case .debug: return "debug"
        case .info: return "info"
        case .notice: return "notice"
        case .error: return "error"
        case .fault: return "fault"
        case .undefined: return "undefined"
        @unknown default: return "unknown"
        }
    }
}

/// Copies this process's own unified-log entries into the durable diagnostics store.
///
/// The app had two logging systems that never met. `Logger` carries most of the real
/// diagnostics -- dial phases, capture geometry, path settling, the media internals -- while the
/// durable store carried a hand-curated subset, and the mirroring ran one way only, store to
/// log and never back. So a pull returned a view missing most of what the code actually logs,
/// and adding a fact to it meant hand-writing a second call beside the log line.
///
/// Scope is `.currentProcessIdentifier` because that is the only scope iOS offers, so this
/// cannot reach a previous launch. That costs nothing here: the store's own NDJSON already
/// survives runs, so the drain only ever has to cover the process it is running in.
///
/// `getEntries` is slow even with a predicate, so this never runs on the main thread and never
/// runs from inside the store's own queue.
final class OSLogDrain: @unchecked Sendable {
    static let shared = OSLogDrain()

    private let logger = Logger(subsystem: Config.logSubsystem, category: "oslog-drain")
    private let queue = DispatchQueue(label: "\(Config.bundleIdentifier).oslog-drain", qos: .utility)
    private let diagnostics: ClientDiagnosticsStore
    private let subsystem: String
    /// Excluded from every query, or the store's own mirror of each recorded event would come
    /// straight back in as a log line and be recorded again, forever.
    private let excludedCategory: String
    private let maxEntriesPerDrain: Int

    /// End of the last drain. Guarded by `queue`.
    private var boundary: Date?
    private var timer: DispatchSourceTimer?
    /// Read from the main actor and from the drain queue's completion hop, so it carries its
    /// own lock rather than riding on either one's isolation.
    private let backgroundTaskIdentifier = OSAllocatedUnfairLock<UIBackgroundTaskIdentifier>(
        initialState: .invalid
    )

    init(
        diagnostics: ClientDiagnosticsStore = ClientDiagnostics.shared,
        subsystem: String = Config.logSubsystem,
        excludedCategory: String = Config.diagnosticsLogCategory,
        maxEntriesPerDrain: Int = Config.osLogDrainMaxEntries
    ) {
        self.diagnostics = diagnostics
        self.subsystem = subsystem
        self.excludedCategory = excludedCategory
        self.maxEntriesPerDrain = maxEntriesPerDrain
    }

    /// True when this process is hosting a test bundle rather than running as the app.
    private static var isHostingTests: Bool {
        let environment = ProcessInfo.processInfo.environment
        return environment["XCTestConfigurationFilePath"] != nil
            || environment["XCTestBundlePath"] != nil
    }

    /// Starts draining on a cadence. Idempotent.
    ///
    /// Not in a test host. The cadence exists so a run that dies WITHOUT a backgrounding
    /// callback -- a crash, an out-of-memory kill, a force quit -- still left its log somewhere
    /// that survives the process. A test host has no such run to preserve, and paying for one
    /// spends machine CPU and disk on a suite whose WebKit-backed assertions already fail under
    /// load. `drain()` still works when a test asks for it; only the unasked-for cadence stops.
    func start() {
        guard !Self.isHostingTests else { return }
        queue.async { [self] in
            guard timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(
                deadline: .now() + .milliseconds(Config.osLogDrainIntervalMs),
                repeating: .milliseconds(Config.osLogDrainIntervalMs)
            )
            timer.setEventHandler { [weak self] in self?.drainLocked() }
            timer.resume()
            self.timer = timer
        }
    }

    func stop() {
        queue.async { [self] in
            timer?.cancel()
            timer = nil
        }
    }

    /// Drains and returns once the entries are in the store, without blocking the caller.
    ///
    /// Every caller is on the main thread -- the offer listener runs its whole connection on
    /// the main queue -- and a drain walks the unified log, which is slow even with a
    /// predicate, so there is deliberately no blocking form of this to reach for.
    func drain() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { [self] in
                drainLocked()
                diagnostics.flush()
                continuation.resume()
            }
        }
    }

    /// Drains under a background-task assertion, for the transition into the background.
    ///
    /// The cadence may never get another tick, so this is the last chance to move the run's log
    /// into a store that survives the process -- but the main thread is on a watchdog at this
    /// transition and a drain is slow, so blocking it here is how an app gets killed. The
    /// assertion buys time to do it off-thread instead, and the expiration handler ends the
    /// assertion even when the drain outlives what iOS was willing to give.
    @MainActor
    func drainBeforeSuspension() {
        let identifier = UIApplication.shared.beginBackgroundTask(withName: "oslog-drain") {
            // UIKit runs the expiration handler on the main thread.
            MainActor.assumeIsolated { [weak self] in self?.endBackgroundTaskIfNeeded() }
        }
        backgroundTaskIdentifier.withLock { $0 = identifier }
        queue.async { [self] in
            drainLocked()
            diagnostics.flush()
            Task { @MainActor [weak self] in self?.endBackgroundTaskIfNeeded() }
        }
    }

    /// Ends the assertion exactly once, whichever of the two paths gets here first.
    @MainActor
    private func endBackgroundTaskIfNeeded() {
        let identifier = backgroundTaskIdentifier.withLock { state -> UIBackgroundTaskIdentifier in
            defer { state = .invalid }
            return state
        }
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
    }

    private func drainLocked() {
        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            let position = boundary.map { store.position(date: $0) }
                ?? store.position(timeIntervalSinceLatestBoot: 0)
            let predicate = NSPredicate(
                format: "subsystem == %@ AND category != %@",
                subsystem,
                excludedCategory
            )
            var emitted = 0
            var latest = boundary
            var capped = false
            for case let entry as OSLogEntryLog in try store.getEntries(at: position, matching: predicate) {
                guard OSLogDrainPolicy.shouldEmit(entryDate: entry.date, after: boundary) else { continue }
                guard emitted < maxEntriesPerDrain else {
                    // Stop rather than keep walking and dropping. The boundary stays at the
                    // last entry actually stored, so the next tick resumes exactly here and a
                    // backlog drains over several of them instead of losing its newest half.
                    capped = true
                    break
                }
                latest = entry.date
                // The store's field sanitizer redacts by KEY, and everything here arrives under
                // one key called `message`, so a secret written into a log line would pass
                // through. Its URL patterns still apply to the body; no current line puts a
                // credential in one, and this is the reason none should.
                diagnostics.record(
                    type: "osLog",
                    fields: OSLogDrainPolicy.fields(
                        category: entry.category,
                        level: entry.level,
                        message: entry.composedMessage
                    ),
                    level: .info,
                    retention: OSLogDrainPolicy.retention(for: entry.level),
                    atMs: Int(entry.date.timeIntervalSince1970 * 1000)
                )
                emitted += 1
            }
            // The boundary is the last entry STORED, so nothing between it and the cap is
            // skipped -- it is simply the next tick's work.
            boundary = latest
            if capped {
                diagnostics.record(
                    type: "osLogDrainCapped",
                    fields: ["emitted": String(emitted), "cap": String(maxEntriesPerDrain)],
                    level: .error
                )
            }
        } catch {
            // Recorded rather than swallowed: a drain that silently stops looks exactly like an
            // app that stopped logging, which is the wrong thing to go looking for.
            logger.error("oslog drain failed: \(String(describing: error), privacy: .public)")
            diagnostics.record(
                type: "osLogDrainFailed",
                fields: ["error": String(describing: error)],
                level: .error
            )
        }
    }
}
