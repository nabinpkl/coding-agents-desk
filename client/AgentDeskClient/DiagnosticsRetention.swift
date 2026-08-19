import Foundation

/// Which events a run's byte budget sacrifices first.
///
/// Measured on one archived run: 10,538 events over 444s, of which 7,316 (69.4%) were
/// `mediaLtrAcknowledged` and exactly 2 were the lifecycle events that say what the run did.
/// The budget was one number trimmed oldest-first, and lifecycle events happen at the start of
/// a run, so the per-frame stream was structurally guaranteed to evict the only records anyone
/// reads. Rate and value are unrelated, so they cannot share an eviction order.
enum DiagnosticsRetention: String, Codable, Sendable {
    /// Rare events that explain what the run did: launch, dial, attach, failure. Kept while any
    /// `.stream` event is still available to sacrifice. The default, so a new event type is
    /// presumed worth keeping until someone measures it chatty.
    case lifecycle = "l"
    /// Per-frame or per-tick telemetry. Sacrificed first, oldest first within the class.
    case stream = "s"
}

/// Chooses which stored lines survive a byte budget.
///
/// Pure and dependency-free on purpose: the policy is the part worth testing, and it should be
/// testable without a filesystem, a clock, or a store.
enum DiagnosticsTrimPolicy {
    /// Returns the lines to keep, in their original order, under `limit` total bytes.
    ///
    /// Sacrifices every `.stream` line, oldest first, before touching a single `.lifecycle`
    /// line -- and then sacrifices `.lifecycle` oldest-first too, because a budget that cannot
    /// be met by dropping the stream still has to be met.
    static func keep<Line>(
        _ lines: [Line],
        limit: Int,
        bytes: (Line) -> Int,
        retention: (Line) -> DiagnosticsRetention
    ) -> [Line] {
        let sizes = lines.map(bytes)
        var total = sizes.reduce(0, +)
        guard total > limit else { return lines }

        var dropped = [Bool](repeating: false, count: lines.count)
        // Two ordered passes rather than a sort: within a class the walk is already oldest
        // first, so age order needs no comparator and stays stable.
        for sacrificed in [DiagnosticsRetention.stream, .lifecycle] {
            guard total > limit else { break }
            for index in lines.indices {
                guard total > limit else { break }
                guard !dropped[index], retention(lines[index]) == sacrificed else { continue }
                dropped[index] = true
                total -= sizes[index]
            }
        }
        return lines.indices.filter { !dropped[$0] }.map { lines[$0] }
    }
}
