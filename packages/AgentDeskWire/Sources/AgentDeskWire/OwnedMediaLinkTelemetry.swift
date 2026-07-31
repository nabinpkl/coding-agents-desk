import Foundation

/// ADR-0088: what the client knows about the link that the host cannot see.
///
/// Rides the existing `.linkHealth` control message rather than opening a second channel,
/// so it arrives on the same cadence and in the same window the frame counts describe.
///
/// Every field is optional and every field is a *report about the client's own view*. The
/// host has its own path observer and its own round-trip tracker; this is deliberately not
/// merged with those, because the whole point is to compare the two ends. A freeze where
/// the host sees a healthy path and the client reports `viable=false` is a different bug
/// from one where both agree.
///
/// Keys are abbreviated because this is sent twice a second over a link we are trying not
/// to congest. Both sides decode the same declaration, so unlike the agent-feed wire there
/// is only one place for these to drift.
public struct OwnedMediaLinkTelemetry: Codable, Equatable, Sendable {
    // MARK: path (NWPathMonitor)

    /// `wifi` / `cellular` / `wiredEthernet` / `loopback` / `other` / `none`.
    public let interfaceType: String?
    /// True on cellular and on personal hotspots.
    public let expensive: Bool?
    /// Low Data Mode.
    public let constrained: Bool?
    /// iOS 26 `isUltraConstrained`.
    public let ultraConstrained: Bool?
    /// `unknown` / `minimal` / `moderate` / `good`. A coarse platform hint, not a measurement:
    /// Apple's header says explicitly not to use it to override decisions made from observed
    /// performance, so it is recorded and never fed to the ladder.
    public let linkQuality: String?
    /// `satisfied` / `unsatisfied` / `requiresConnection`.
    public let pathStatus: String?
    /// Populated only when the path is unsatisfied: `cellularDenied`, `wifiDenied`, etc.
    public let unsatisfiedReason: String?
    /// Path transitions observed, **cumulative for the life of the connection** -- diff it
    /// against the previous report to get the per-window count. See `linkChanges` for why
    /// these are totals rather than deltas.
    public let pathChanges: Int?

    // MARK: radio (CoreTelephony, iOS only)

    /// `LTE`, `NR`, `NRNSA`, `WCDMA`, ... with the `CTRadioAccessTechnology` prefix stripped.
    public let radioAccess: String?
    /// Radio-technology changes, **cumulative** (see `linkChanges`). An increase between two
    /// reports is a handover.
    public let radioChanges: Int?

    // MARK: receive liveness (ours, not the platform's)

    /// Datagrams the receive loop actually pulled off the connection this window.
    public let datagramsReceived: Int?
    /// Longest gap between consecutive datagram arrivals this window. The number that
    /// separates "nothing was delivered to us" from "we were too slow to collect it".
    public let maxArrivalGapMs: Double?
    /// Monotonic count of receive-loop iterations. If this climbs while `datagramsReceived`
    /// stays at zero, the loop is alive and the network is silent; if both stall, our task
    /// is not running.
    public let receiveLoopIterations: Int?

    // MARK: presentation waste (ours)

    /// Frames decoded this window but never shown, because a newer frame was already
    /// available by the time the fps deadline came round.
    ///
    /// This is the host's own bandwidth coming back as a number. A frame that arrives too
    /// late to be the newest still has to be decoded (it is a reference for the ones behind
    /// it) but is never presented, so every byte in it bought the user nothing. Recovering
    /// after a stall is exactly when this spikes: the measured 12.79s freeze released 49
    /// frames into a single 500ms window, of which the pacer presents at most one per fps
    /// interval.
    ///
    /// Deliberately reported rather than inferred: it was previously recorded only into the
    /// client's own diagnostics store, which keeps three runs, so by the time anyone asked
    /// what a past freeze had wasted the answer was already evicted.
    public let presentationSkips: Int?
    /// Bytes belonging to those frames. The number that would justify the host declining to
    /// send at all while the client is behind.
    public let presentationSkipBytes: Int?

    // MARK: handover detection (ours)

    /// Link transitions detected across every cause, **cumulative for the life of the
    /// connection**. An increase since the previous report means the link moved.
    ///
    /// Cumulative rather than per-window because this report is a datagram sent over the link
    /// it describes, and `sendVideoControl` drops it silently on failure. R208 measured report
    /// loss at 0.2% at rest but **18% during a freeze** -- the link change is itself what makes
    /// the report carrying it go missing. Under a delta counter the transition is drained into
    /// a report that never arrives and is gone for good, which is exactly what happened: a real
    /// wifi-to-cellular switch produced `linkChanges=0` in all 976 delivered reports. Totals
    /// survive loss; deltas do not.
    ///
    /// Distinct from `pathChanges`, which counts only `NWPath` snapshot differences. The case
    /// that motivated this -- a cellular address change with no interface change -- produces an
    /// identical `NWPath` snapshot and so is invisible to `pathChanges`.
    public let linkChanges: Int?
    /// The recent causes, as `cause(from->to)`, comma separated, most recent last.
    ///
    /// Sticky rather than drained, and bounded to the last few: any single report that survives
    /// then carries the history, instead of only whatever happened to land in its own window.
    ///
    /// The point of Phase 1: a device run shows which cause noticed a real handover first, and
    /// how far ahead of the transport's own 18-second `Network is down` it was. Phase 2 picks
    /// the trigger from this rather than from a guess.
    public let linkChangeCauses: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case interfaceType = "it"
        case expensive = "xp"
        case constrained = "cn"
        case ultraConstrained = "uc"
        case linkQuality = "lq"
        case pathStatus = "ps"
        case unsatisfiedReason = "ur"
        case pathChanges = "pc"
        case radioAccess = "ra"
        case radioChanges = "rc"
        case datagramsReceived = "dr"
        case maxArrivalGapMs = "dg"
        case receiveLoopIterations = "di"
        case presentationSkips = "pk"
        case presentationSkipBytes = "pb"
        case linkChanges = "lc"
        case linkChangeCauses = "lk"
    }

    public init(
        interfaceType: String? = nil,
        expensive: Bool? = nil,
        constrained: Bool? = nil,
        ultraConstrained: Bool? = nil,
        linkQuality: String? = nil,
        pathStatus: String? = nil,
        unsatisfiedReason: String? = nil,
        pathChanges: Int? = nil,
        radioAccess: String? = nil,
        radioChanges: Int? = nil,
        datagramsReceived: Int? = nil,
        maxArrivalGapMs: Double? = nil,
        receiveLoopIterations: Int? = nil,
        presentationSkips: Int? = nil,
        presentationSkipBytes: Int? = nil,
        linkChanges: Int? = nil,
        linkChangeCauses: String? = nil
    ) {
        self.interfaceType = interfaceType
        self.expensive = expensive
        self.constrained = constrained
        self.ultraConstrained = ultraConstrained
        self.linkQuality = linkQuality
        self.pathStatus = pathStatus
        self.unsatisfiedReason = unsatisfiedReason
        self.pathChanges = pathChanges
        self.radioAccess = radioAccess
        self.radioChanges = radioChanges
        self.datagramsReceived = datagramsReceived
        self.maxArrivalGapMs = maxArrivalGapMs
        self.receiveLoopIterations = receiveLoopIterations
        self.presentationSkips = presentationSkips
        self.presentationSkipBytes = presentationSkipBytes
        self.linkChanges = linkChanges
        self.linkChangeCauses = linkChangeCauses
    }

    /// One compact `key=value` line for the host log. Absent fields are omitted rather than
    /// printed as `nil`, so a report from a platform that cannot supply radio data reads as
    /// short rather than broken.
    public var logDescription: String {
        var parts: [String] = []
        func add(_ key: String, _ value: CustomStringConvertible?) {
            guard let value else { return }
            parts.append("\(key)=\(value)")
        }
        add("iface", interfaceType)
        add("expensive", expensive)
        add("constrained", constrained)
        add("ultraConstrained", ultraConstrained)
        add("linkQuality", linkQuality)
        add("pathStatus", pathStatus)
        add("unsatisfied", unsatisfiedReason)
        add("pathChanges", pathChanges)
        add("radio", radioAccess)
        add("radioChanges", radioChanges)
        add("datagramsRecv", datagramsReceived)
        add("maxArrivalGapMs", maxArrivalGapMs.map { String(format: "%.1f", $0) })
        add("recvLoopIters", receiveLoopIterations)
        add("presSkips", presentationSkips)
        add("presSkipBytes", presentationSkipBytes)
        add("linkChanges", linkChanges)
        add("linkCauses", linkChangeCauses)
        return parts.isEmpty ? "none" : parts.joined(separator: " ")
    }
}
