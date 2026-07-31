import Foundation
import OSLog
#if os(iOS)
import CoreTelephony
#endif

/// ADR-0088: which cellular radio we are on, and when it changes.
///
/// A handover (5G to LTE, or between carriers' bands) is one of the four candidate causes of
/// the cellular-only freezes, and it is the only one with no signal anywhere else: the path
/// stays satisfied, the interface stays `cellular`, and the RTT change looks like ordinary
/// jitter. `radioType` on `NWConnection.DataTransferReport.PathReport` would have carried it,
/// but that report returns all zeros on the new API (ADR-0088), so CoreTelephony is the only
/// route to it.
///
/// `CTCarrier` and `currentRadioAccessTechnology` are deprecated;
/// `serviceCurrentRadioAccessTechnology` is not, and needs no entitlement.
final class RadioAccessObserver: @unchecked Sendable {
    private let lock = OSAllocatedUnfairLock(initialState: State())
    private let logger = Logger(subsystem: Config.logSubsystem, category: "link-telemetry")

    private struct State {
        var current: String?
        var changesSinceDrain: Int = 0
    }

    #if os(iOS)
    private let networkInfo = CTTelephonyNetworkInfo()
    private var observer: NSObjectProtocol?
    #endif

    /// Reports the transition itself, not just that the count moved. `LinkChangeDetector` needs
    /// `from -> to` to say which signal noticed a handover first, and the drained count cannot
    /// carry that.
    private let onChange: (@Sendable (String?, String?) -> Void)?

    init(onChange: (@Sendable (String?, String?) -> Void)? = nil) {
        self.onChange = onChange
    }

    func start() {
        #if os(iOS)
        refresh(isInitial: true)
        observer = NotificationCenter.default.addObserver(
            forName: .CTServiceRadioAccessTechnologyDidChange,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.refresh(isInitial: false)
        }
        #endif
    }

    func stop() {
        #if os(iOS)
        if let observer {
            NotificationCenter.default.removeObserver(observer)
            self.observer = nil
        }
        #endif
    }

    /// Current radio plus changes since the previous drain, resetting the count.
    func drainForReport() -> (radio: String?, changes: Int) {
        lock.withLock { state in
            let changes = state.changesSinceDrain
            state.changesSinceDrain = 0
            return (state.current, changes)
        }
    }

    #if os(iOS)
    private func refresh(isInitial: Bool) {
        // A dual-SIM phone reports per service. We take the first stable-sorted entry rather
        // than guessing which SIM carries our traffic: the value is a coarse label for
        // correlating against a freeze, not an authority on routing.
        let value = networkInfo.serviceCurrentRadioAccessTechnology?
            .sorted(by: { $0.key < $1.key })
            .first?
            .value
        let simplified = value.map(Self.strippingPrefix)
        let transition = lock.withLock { state -> (from: String?, to: String?)? in
            guard state.current != simplified else { return nil }
            let previous = state.current
            state.current = simplified
            // Same rule as LinkPathObserver: the first reading is a baseline, not a handover.
            if !isInitial { state.changesSinceDrain += 1 }
            return (previous, simplified)
        }
        guard let transition, !isInitial else { return }
        logger.notice("link radio changed to=\(simplified ?? "none", privacy: .public)")
        onChange?(transition.from, transition.to)
    }
    #endif

    /// `CTRadioAccessTechnologyNRNSA` -> `NRNSA`. The prefix is 25 characters of noise on a
    /// line we read during an incident.
    static func strippingPrefix(_ raw: String) -> String {
        let prefix = "CTRadioAccessTechnology"
        guard raw.hasPrefix(prefix) else { return raw }
        return String(raw.dropFirst(prefix.count))
    }
}
