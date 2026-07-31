import Darwin
import Foundation
import os

/// Phase 1 of the handover architecture: notice that the link moved under us, and say which
/// signal noticed first. It deliberately acts on nothing.
///
/// The measured problem it exists to solve: a WiFi-to-cellular switch black-holed traffic for
/// **18 seconds** before `NetworkConnection` reported `Network is down`, and the session resume
/// window is 20 seconds, so by the time anything noticed there were two seconds of window left.
/// Recovery cannot be driven off the transport admitting failure. Something has to see it
/// sooner, and this measures which candidate actually does.
///
/// Five causes, because they fail differently and, critically, they do **not** all catch the
/// same incidents:
///
/// - `interfaceType` catches WiFi <-> cellular, and misses a cellular address change entirely;
/// - `localAddress` is the only one that catches a 5G -> 3G PDP re-establish, where the phone
///   gets a new address while `interfaceType` stays `cellular` and the path stays `satisfied`;
/// - `pathStatus` catches an outright loss of connectivity;
/// - `radioAccess` catches the radio handover that usually precedes the address change;
/// - `stall` is our own arrival-gap evidence, which caught the measured freeze at ~1.6s and is
///   the backstop for any cause the platform never reports at all.
///
/// Phase 2 picks a trigger from what this measures. Guessing now would repeat the mistake that
/// produced a resume path wired to `willEnterForeground`, which cannot fire during a network
/// change because the app never leaves the foreground.
public enum LinkChangeCause: String, Sendable, CaseIterable {
    case interfaceType
    case pathStatus
    case localAddress
    case radioAccess
    case stall
}

public struct LinkChangeEvent: Sendable, Equatable {
    public let cause: LinkChangeCause
    /// `from -> to`, or the stall's measured gap. Read during an incident, so it carries the
    /// transition rather than just the fact of one.
    public let detail: String

    public init(cause: LinkChangeCause, detail: String) {
        self.cause = cause
        self.detail = detail
    }

    public var logDescription: String { "\(cause.rawValue)(\(detail))" }
}

/// Fuses the link-change signals and accumulates what fired between report windows.
///
/// Edge-triggered on every input, so a stable link costs one `getifaddrs` per report window and
/// nothing else. The first observation of any value is a baseline, never a transition -- the
/// same rule `LinkPathObserver` and `RadioAccessObserver` already use, so a session does not
/// open by reporting that everything just changed.
public final class LinkChangeDetector: @unchecked Sendable {
    private struct State {
        var interfaceType: String?
        var pathStatus: String?
        var addressDigest: UInt64?
        var changesSinceDrain: Int = 0
        var eventsSinceDrain: [LinkChangeEvent] = []
    }

    /// Bounded so a pathological flap cannot grow this without limit between drains. The count
    /// stays exact; only the retained detail is capped.
    private static let maxRetainedEvents = 8

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let onChange: (@Sendable (LinkChangeEvent) -> Void)?

    /// - Parameter onChange: called once per real transition, for the edge-triggered log line.
    public init(onChange: (@Sendable (LinkChangeEvent) -> Void)? = nil) {
        self.onChange = onChange
    }

    /// Feed a path snapshot. Compares the two fields that indicate a moved link; the rest of the
    /// snapshot (expensive, linkQuality) varies without the link having moved.
    public func notePath(_ snapshot: LinkPathSnapshot) {
        // Events are built inside the lock and returned, never captured from outside it:
        // `withLock` takes a sendable closure, so mutating an outer `var` is a Swift 6 error.
        let events: [LinkChangeEvent] = state.withLock { state in
            var found: [LinkChangeEvent] = []
            if let previous = state.interfaceType, previous != snapshot.interfaceType {
                found.append(LinkChangeEvent(
                    cause: .interfaceType,
                    detail: "\(previous)->\(snapshot.interfaceType)"
                ))
            }
            state.interfaceType = snapshot.interfaceType

            if let previous = state.pathStatus, previous != snapshot.status {
                found.append(LinkChangeEvent(
                    cause: .pathStatus,
                    detail: "\(previous)->\(snapshot.status)"
                ))
            }
            state.pathStatus = snapshot.status

            record(found, into: &state)
            return found
        }
        events.forEach { onChange?($0) }
    }

    /// Sample the host's own addresses and report a change.
    ///
    /// Called on the report cadence rather than only from the path callback, because the case
    /// this exists for -- a cellular address change with no interface change -- may not produce
    /// a path callback at all. One `getifaddrs` twice a second is cheaper than missing it.
    public func sampleAddresses(digest: UInt64 = LinkChangeDetector.currentAddressDigest()) {
        let event: LinkChangeEvent? = state.withLock { state in
            var found: LinkChangeEvent?
            if let previous = state.addressDigest, previous != digest {
                // The digest, not the addresses: enough to prove the link moved, without
                // putting the device's addresses in a log that gets pasted into issues.
                found = LinkChangeEvent(
                    cause: .localAddress,
                    detail: String(
                        format: "%08x->%08x",
                        UInt32(truncatingIfNeeded: previous),
                        UInt32(truncatingIfNeeded: digest)
                    )
                )
            }
            state.addressDigest = digest
            if let found { record([found], into: &state) }
            return found
        }
        if let event { onChange?(event) }
    }

    /// Radio transitions come from CoreTelephony on the client; the host has no equivalent, so
    /// this is fed rather than observed here.
    public func noteRadioChange(from previous: String?, to current: String?) {
        let event = LinkChangeEvent(
            cause: .radioAccess,
            detail: "\(previous ?? "none")->\(current ?? "none")"
        )
        state.withLock { state in record([event], into: &state) }
        onChange?(event)
    }

    /// Our own evidence: the client received nothing for materially longer than the host was
    /// quiet. Fed from the same comparison `MediaQualityController.clientLinkStalled` uses, so
    /// a calm screen does not register as a link change.
    ///
    /// Unfed in Phase 1. Both numbers exist only on the host, and deriving it client-side from
    /// the arrival gap alone would reintroduce the false positive fixed in `ef649c86`, where a
    /// quiet host reads as a stalled link. Wired in Phase 3 with the host-side liveness work.
    public func noteStall(gapMs: Double, hostQuietMs: Double) {
        let event = LinkChangeEvent(
            cause: .stall,
            detail: String(format: "gap=%.0fms quiet=%.0fms", gapMs, hostQuietMs)
        )
        state.withLock { state in record([event], into: &state) }
        onChange?(event)
    }

    private func record(_ events: [LinkChangeEvent], into state: inout State) {
        guard !events.isEmpty else { return }
        state.changesSinceDrain += events.count
        for event in events where state.eventsSinceDrain.count < Self.maxRetainedEvents {
            state.eventsSinceDrain.append(event)
        }
    }

    /// Transitions since the previous drain, and the causes that produced them, resetting both.
    public func drainForReport() -> (changes: Int, causes: String?) {
        state.withLock { state in
            let changes = state.changesSinceDrain
            let causes = state.eventsSinceDrain.map(\.logDescription).joined(separator: ",")
            state.changesSinceDrain = 0
            state.eventsSinceDrain.removeAll(keepingCapacity: true)
            return (changes, causes.isEmpty ? nil : causes)
        }
    }

    // MARK: - Address digest

    /// FNV-1a over the sorted `interface=address` set, excluding loopback and link-local.
    ///
    /// Link-local is excluded because it is per-interface and carries no routing meaning, so
    /// including it would report a change every time an interface appears. The tailnet's own
    /// address is deliberately kept: it is stable across the path switches that do not break us
    /// (direct <-> DERP), which makes it a useful control rather than noise.
    public static func currentAddressDigest() -> UInt64 {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let head else { return 0 }
        defer { freeifaddrs(head) }

        var entries: [String] = []
        for pointer in sequence(first: head, next: { $0.pointee.ifa_next }) {
            let flags = Int32(pointer.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            guard let address = pointer.pointee.ifa_addr else { continue }
            let family = address.pointee.sa_family
            guard family == UInt8(AF_INET) || family == UInt8(AF_INET6) else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let resolved = getnameinfo(
                address,
                socklen_t(address.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            guard resolved == 0 else { continue }
            let text = String(decoding: host.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self)
            guard !text.hasPrefix("fe80:"), !text.hasPrefix("169.254.") else { continue }
            entries.append("\(String(cString: pointer.pointee.ifa_name))=\(text)")
        }
        return fnv1a(entries.sorted().joined(separator: ","))
    }

    static func fnv1a(_ value: String) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100_0000_01b3
        }
        return hash
    }
}
