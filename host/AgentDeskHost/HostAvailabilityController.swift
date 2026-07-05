import Foundation
import AgentDeskWire

struct HostAvailabilitySnapshot: Equatable, Sendable {
    let availability: HostAvailability
    let reason: String?
}

struct HostAvailabilityController: Equatable, Sendable {
    private(set) var availability: HostAvailability = .active
    private(set) var reason: String?

    var snapshot: HostAvailabilitySnapshot {
        HostAvailabilitySnapshot(availability: availability, reason: reason)
    }

    var preservesSessionOnInputLaneClose: Bool {
        availability == .locked || availability == .captureUnavailable
    }

    mutating func noteLock(reason: String = "session-resigned-active") -> HostAvailabilitySnapshot? {
        set(.locked, reason: reason)
    }

    mutating func noteCaptureUnavailable(reason: String) -> HostAvailabilitySnapshot? {
        set(availability == .locked ? .locked : .captureUnavailable, reason: reason)
    }

    mutating func noteActive(reason: String = "session-active") -> HostAvailabilitySnapshot? {
        set(.active, reason: reason)
    }

    mutating func noteDisconnected(reason: String) -> HostAvailabilitySnapshot? {
        set(.disconnected, reason: reason)
    }

    private mutating func set(_ next: HostAvailability, reason nextReason: String?) -> HostAvailabilitySnapshot? {
        guard availability != next || reason != nextReason else { return nil }
        availability = next
        reason = nextReason
        return snapshot
    }
}
