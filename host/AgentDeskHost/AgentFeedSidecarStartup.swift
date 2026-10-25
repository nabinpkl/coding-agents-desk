import Foundation

/// How far a starting sidecar has got, as far as its port can tell.
///
/// The host used to ask one question of a starting sidecar -- "live yet?" -- and kill it after a
/// fixed five seconds of no. That cannot tell a process that is still binding its port from one
/// that is answering and busy building its catalog from one that is hung, so a start that needed
/// slightly longer than the clock was killed identically on every retry. The stages are the
/// distinctions the port can actually make.
enum SidecarStage: Equatable, CustomStringConvertible {
    /// Connection refused: nothing has bound the port yet.
    case notListening
    /// Something accepted the connection, or the attempt timed out, and gave no usable answer.
    case silent
    /// An HTTP answer that is not yet `live`: the sidecar's own `watcherState` (`idle`,
    /// `reconciling`), or `http <status>` when the body had none.
    case answering(String)
    case live

    /// Order of progress, so a start that goes backwards is not mistaken for one that advanced.
    var rank: Int {
        switch self {
        case .notListening: 0
        case .silent: 1
        case .answering: 2
        case .live: 3
        }
    }

    var description: String {
        switch self {
        case .notListening: "not-listening"
        case .silent: "silent"
        case .answering(let state): "answering:\(state)"
        case .live: "live"
        }
    }
}

/// Reads the stage off the sidecar's `/api/config`.
enum SidecarStageProbe {
    static func stage(of url: URL, timeout: TimeInterval) -> SidecarStage {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        let result = ProbeResult()
        let completion = DispatchSemaphore(value: 0)
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            result.set(Self.classify(data: data, response: response, error: error))
            completion.signal()
        }
        task.resume()
        // The semaphore outlasts the request's own timeout by a little, so a timed-out request
        // reports itself as `silent` rather than racing this wait into a cancel.
        guard completion.wait(timeout: .now() + timeout + 0.05) == .success else {
            task.cancel()
            return .silent
        }
        return result.value
    }

    static func classify(data: Data?, response: URLResponse?, error: Error?) -> SidecarStage {
        if let error = error as? URLError {
            return error.code == .cannotConnectToHost ? .notListening : .silent
        }
        guard error == nil, let http = response as? HTTPURLResponse else { return .silent }
        guard (200..<300).contains(http.statusCode) else { return .answering("http \(http.statusCode)") }
        guard let data,
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let state = body["watcherState"] as? String
        else { return .answering("http \(http.statusCode)") }
        return state == "live" ? .live : .answering(state)
    }

    private final class ProbeResult: @unchecked Sendable {
        private let lock = NSLock()
        private var stage = SidecarStage.silent

        func set(_ stage: SidecarStage) {
            lock.lock()
            self.stage = stage
            lock.unlock()
        }

        var value: SidecarStage {
            lock.lock()
            defer { lock.unlock() }
            return stage
        }
    }
}

/// One start attempt, watched for progress rather than for elapsed time.
///
/// The clock that matters is the time since the sidecar last reached a stage it had not reached
/// before. A sidecar that keeps advancing is never stalled, however long the whole start takes;
/// the ceiling is only the backstop for one that advances forever without arriving. Times are
/// passed in, so the decisions are testable without a process or a sleep.
struct SidecarStartWatch {
    enum Verdict: Equatable {
        case waiting
        /// No new stage for `seconds`, which exceeds the allowance.
        case stalled(seconds: TimeInterval)
        /// Still moving, but past the ceiling on the whole start.
        case overCeiling(seconds: TimeInterval)
    }

    private(set) var stage: SidecarStage = .notListening
    /// Each stage as first reached, with the time since the start began.
    private(set) var timeline: [(stage: SidecarStage, at: TimeInterval)] = []
    private let startedAt: TimeInterval
    private var lastProgressAt: TimeInterval
    private var maxRank = -1
    private var seen: Set<String> = []

    init(startedAt: TimeInterval) {
        self.startedAt = startedAt
        self.lastProgressAt = startedAt
    }

    /// Records what the probe saw. True when this is a stage not seen before in this start, which
    /// is also when the stall clock restarts. Going backwards (a bound port that stops answering)
    /// updates `stage` but never counts as progress, and flapping cannot restart the clock because
    /// a stage already seen is not new.
    @discardableResult
    mutating func observe(_ observed: SidecarStage, at now: TimeInterval) -> Bool {
        stage = observed
        let key = observed.description
        guard !seen.contains(key) else { return false }
        seen.insert(key)
        timeline.append((observed, now - startedAt))
        guard observed.rank >= maxRank else { return true }
        maxRank = observed.rank
        lastProgressAt = now
        return true
    }

    func verdict(at now: TimeInterval, stallAllowance: TimeInterval, ceiling: TimeInterval) -> Verdict {
        if now - startedAt >= ceiling { return .overCeiling(seconds: now - startedAt) }
        let stalled = now - lastProgressAt
        return stalled >= stallAllowance ? .stalled(seconds: stalled) : .waiting
    }

    func elapsed(at now: TimeInterval) -> TimeInterval { now - startedAt }

    /// `not-listening@0.0s answering:reconciling@2.1s live@5.4s`.
    var timelineDescription: String {
        timeline.map { "\($0.stage)@\(String(format: "%.1f", $0.at))s" }.joined(separator: " ")
    }
}

/// What the starts that failed in a row have in common, so a loop is named and then broken.
///
/// A fixed allowance retried at a fixed length is what let one host restart a sidecar fifteen times
/// in under five minutes without learning anything. Each consecutive failure doubles the stall
/// allowance up to the ceiling, which is what turns a retry that cannot win into one that can.
struct SidecarStartFailures {
    private(set) var consecutive = 0
    private(set) var lastStage: SidecarStage?
    /// How many of the consecutive failures ended at `lastStage`.
    private(set) var atLastStage = 0

    mutating func record(stage: SidecarStage) {
        consecutive += 1
        atLastStage = stage == lastStage ? atLastStage + 1 : 1
        lastStage = stage
    }

    mutating func reset() {
        consecutive = 0
        lastStage = nil
        atLastStage = 0
    }

    func allowance(base: TimeInterval, ceiling: TimeInterval) -> TimeInterval {
        // Capped on the exponent as well, so a long loop cannot overflow the shift.
        min(base * Double(1 << min(consecutive, 10)), ceiling)
    }
}
