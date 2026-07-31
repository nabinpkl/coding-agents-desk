import Foundation
import Network
import os

/// ADR-0088: the path half of link telemetry, shared by host and client.
///
/// This lives beside the wire struct on purpose. The mapping from `NWPath` to the reported
/// strings is exactly the kind of thing that drifts when each side writes its own, and the
/// whole value of this telemetry is comparing the two ends -- which is worthless if "wifi"
/// on one side and "Wi-Fi" on the other are the same reality.
///
/// `NWPathMonitor` rather than connection callbacks: `onPathUpdate` / `onViabilityUpdate`
/// exist on `NetworkConnection` but are constrained to `ApplicationProtocol: OneToOneProtocol`,
/// and QUIC does not conform. The process-level monitor carries the same `NWPath`, and the
/// connection's own `currentPath` is polled separately for the cases where they disagree.
public struct LinkPathSnapshot: Equatable, Sendable {
    public let interfaceType: String
    public let expensive: Bool
    public let constrained: Bool
    public let ultraConstrained: Bool
    public let linkQuality: String
    public let status: String
    /// Only meaningful when `status` is `unsatisfied`; nil otherwise so a healthy report does
    /// not carry a misleading `notAvailable`.
    public let unsatisfiedReason: String?

    /// Memberwise, for tests and for the detector's fixtures. `NWPath` cannot be constructed,
    /// so without this the only way to exercise a path transition is on a real device moving
    /// between real networks -- which is precisely the thing that is hard to reproduce.
    public init(
        interfaceType: String,
        expensive: Bool,
        constrained: Bool,
        ultraConstrained: Bool,
        linkQuality: String,
        status: String,
        unsatisfiedReason: String?
    ) {
        self.interfaceType = interfaceType
        self.expensive = expensive
        self.constrained = constrained
        self.ultraConstrained = ultraConstrained
        self.linkQuality = linkQuality
        self.status = status
        self.unsatisfiedReason = unsatisfiedReason
    }

    public init(path: NWPath) {
        // Interface order is priority order, so the first is the one actually in use.
        switch path.availableInterfaces.first?.type {
        case .wifi: interfaceType = "wifi"
        case .cellular: interfaceType = "cellular"
        case .wiredEthernet: interfaceType = "wired"
        case .loopback: interfaceType = "loopback"
        case .other: interfaceType = "other"
        case .none: interfaceType = "none"
        @unknown default: interfaceType = "unknown"
        }

        switch path.status {
        case .satisfied: status = "satisfied"
        case .unsatisfied: status = "unsatisfied"
        case .requiresConnection: status = "requiresConnection"
        @unknown default: status = "unknown"
        }

        switch path.linkQuality {
        case .minimal: linkQuality = "minimal"
        case .moderate: linkQuality = "moderate"
        case .good: linkQuality = "good"
        case .unknown: linkQuality = "unknown"
        @unknown default: linkQuality = "unknown"
        }

        if path.status == .satisfied {
            unsatisfiedReason = nil
        } else {
            switch path.unsatisfiedReason {
            case .notAvailable: unsatisfiedReason = "notAvailable"
            case .cellularDenied: unsatisfiedReason = "cellularDenied"
            case .wifiDenied: unsatisfiedReason = "wifiDenied"
            case .localNetworkDenied: unsatisfiedReason = "localNetworkDenied"
            case .vpnInactive: unsatisfiedReason = "vpnInactive"
            @unknown default: unsatisfiedReason = "unknown"
            }
        }

        expensive = path.isExpensive
        constrained = path.isConstrained
        ultraConstrained = path.isUltraConstrained
    }

    /// The one-line form used for the edge-triggered log record.
    public var logDescription: String {
        var line = "iface=\(interfaceType) status=\(status) expensive=\(expensive)"
            + " constrained=\(constrained) ultraConstrained=\(ultraConstrained)"
            + " linkQuality=\(linkQuality)"
        if let unsatisfiedReason { line += " unsatisfied=\(unsatisfiedReason)" }
        return line
    }
}

/// Watches the process path and accumulates transitions between reports.
///
/// Edge-triggered, so it costs nothing while the link is stable -- which is the common case
/// and the reason this can run unconditionally rather than behind a debug flag.
public final class LinkPathObserver: @unchecked Sendable {
    private struct State {
        var snapshot: LinkPathSnapshot?
        /// Cumulative, never reset: a delta counter drained into a report that then fails to
        /// send loses the transition permanently, which is exactly what R208 measured.
        var changesTotal: Int = 0
        var totalAtLastReport: Int = 0
    }

    private let monitor = NWPathMonitor()
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let onChange: (@Sendable (LinkPathSnapshot) -> Void)?

    /// - Parameter onChange: called only when the snapshot actually differs from the previous
    ///   one, not on every monitor callback. The monitor fires for changes we do not model
    ///   (DNS, gateways), and logging those would bury the transitions that matter.
    public init(onChange: (@Sendable (LinkPathSnapshot) -> Void)? = nil) {
        self.onChange = onChange
    }

    public func start(queue: DispatchQueue) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let snapshot = LinkPathSnapshot(path: path)
            let changed = self.state.withLock { state -> Bool in
                guard state.snapshot != snapshot else { return false }
                // The first observation is the baseline, not a transition: counting it would
                // make every session open with pathChanges=1 and hide real churn in the noise.
                let isFirst = state.snapshot == nil
                state.snapshot = snapshot
                if !isFirst { state.changesTotal += 1 }
                return true
            }
            guard changed else { return }
            self.onChange?(snapshot)
        }
        monitor.start(queue: queue)
    }

    public func stop() {
        monitor.cancel()
    }

    /// Current snapshot plus the **cumulative** transition count. Called once per report
    /// window, and non-destructive for the same reason as `LinkChangeDetector.reportSnapshot`:
    /// the report rides a datagram over the link that just changed, so a counter that resets on
    /// read loses the transition whenever the transition is what stopped the report arriving.
    ///
    /// `newSinceLastReport` is local-only (it gates a console line), so its reset is harmless.
    public func reportSnapshot() -> (snapshot: LinkPathSnapshot?, total: Int, newSinceLastReport: Int) {
        state.withLock { state in
            let fresh = state.changesTotal - state.totalAtLastReport
            state.totalAtLastReport = state.changesTotal
            return (state.snapshot, state.changesTotal, fresh)
        }
    }
}
