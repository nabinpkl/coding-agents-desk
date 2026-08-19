import Foundation

/// Splits one dial into its phases so a slow connect can name the phase that owned the time.
///
/// The dial is a serial chain of awaits under a single overall budget, and it reported only two
/// facts: it started, and some seconds later it connected. A cold start measured at 9s between
/// `sessionAttemptStarted` and `sessionConnected` was therefore unattributable by construction --
/// DNS, the QUIC handshake, the two signed round trips, and opening five lanes all land in the
/// same number. `establishmentReport()` covers the first phase only, and goes to os_log, so it
/// never reaches the store the phone hands back.
///
/// Deliberately dependency-free: it holds durations and formats them, so it is unit-testable
/// without a network, and the caller owns where the numbers go.
struct SessionDialPhaseTimer {
    /// One completed phase, in the order it ran.
    struct Phase: Equatable {
        let name: String
        let ms: Int
    }

    private let clockNs: () -> UInt64
    private let startedNs: UInt64
    private var lastNs: UInt64
    private(set) var phases: [Phase] = []

    init(clockNs: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) {
        self.clockNs = clockNs
        let now = clockNs()
        startedNs = now
        lastNs = now
    }

    /// Closes the phase that ended here and opens the next one.
    mutating func mark(_ name: String) {
        let now = clockNs()
        phases.append(Phase(name: name, ms: Self.ms(from: lastNs, to: now)))
        lastNs = now
    }

    var totalMs: Int { Self.ms(from: startedNs, to: clockNs()) }

    /// `connect=8412 control=3 challenge=91 ...`, for the log line.
    var summary: String {
        phases.map { "\($0.name)=\($0.ms)" }.joined(separator: " ")
    }

    /// The same phases as diagnostics fields, plus the total, so the phone's own store carries
    /// the split and `just client-diagnostics` can answer this without a console attached.
    var diagnosticsFields: [String: String] {
        var fields: [String: String] = [:]
        for phase in phases {
            fields["\(phase.name)Ms"] = String(phase.ms)
        }
        fields["totalMs"] = String(totalMs)
        return fields
    }

    /// The phase that took the longest, which is the one worth reading first.
    var slowestPhase: Phase? {
        phases.max { $0.ms < $1.ms }
    }

    private static func ms(from: UInt64, to: UInt64) -> Int {
        Int((to &- from) / 1_000_000)
    }
}
