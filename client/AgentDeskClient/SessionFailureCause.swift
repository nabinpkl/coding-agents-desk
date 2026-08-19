import Foundation
import Network
import AgentDeskWire

// Why a session dial failed, in terms someone standing at their Mac can act on.
//
// The reconnect loop is deliberately endless: a Mac that went to sleep should come back by
// itself, and a phone that walked out of wifi range should reattach without being told to.
// But an endless retry that only ever says "Paired (reconnecting)" cannot distinguish a
// five-second blip from a host that died an hour ago and is never coming back on its own.
// Both look identical, forever, and the second one needs a human. Naming the cause is the
// difference between waiting and knowing to go look at the Mac.
enum SessionFailureCause: Equatable {
    // The Mac answered and refused the port: the machine is up and reachable on the tailnet,
    // but nothing is listening there. In practice the AgentDesk host is not running -- quit,
    // crashed, or still coming up.
    //
    // This is the one cause the transport states unambiguously, and only because a refusal is
    // an *answer*. Silence cannot be told apart from a slow link, which is why every other
    // case below is a weaker claim than this one.
    case hostNotRunning
    // Nothing answered. The Mac is asleep, off the tailnet, or the path is dead somewhere in
    // between. Deliberately not called "Mac is asleep": we cannot tell which.
    case hostUnreachable
    // A network exists but this phone cannot currently use it.
    case networkUnavailable
    // The host answered and turned this attempt down.
    //
    // Only the recoverable reasons ever reach this label. `PairingClient.applyRejection` sends
    // revoked, unknown-device, bad-signature to `.revoked` and incompatible-protocol to
    // `.rejected`, and the reconnect loop stops on both, so those render as their own screens.
    // What lands back in `.pairedDisconnected` -- replay, malformed, expired-resume,
    // signing-key-unavailable, unauthorized -- is exactly the set where the next durable dial
    // can succeed. So this says "trying again" and means it.
    case rejected(SessionRejectionReason)
    // Classified as nothing in particular. Says so rather than guessing.
    case unknown

    // Shown under "Paired (reconnecting)". One line, no jargon, and it never claims more
    // certainty than the signal carries.
    var explanation: String {
        switch self {
        case .hostNotRunning:
            return "Your Mac is reachable but AgentDesk isn't running on it. Open AgentDesk on the Mac."
        case .hostUnreachable:
            return "Your Mac isn't answering. It may be asleep or off the tailnet."
        case .networkUnavailable:
            return "This iPhone has no usable network path right now."
        case let .rejected(reason):
            return "Your Mac turned this attempt down (\(reason.rawValue)). Trying again."
        case .unknown:
            return "Couldn't reach your Mac."
        }
    }

    // A dial fails once on every ordinary host restart, so one failure is not news and
    // announcing it would make the screen flap during a normal relaunch. Two in a row at the
    // 1s retry delay is about two seconds of a condition that is not clearing itself.
    static let announceAfterConsecutiveFailures = 2

    // The whole status label, so the threshold rule and the wording are decided in one
    // testable place rather than inside a view controller.
    static func reconnectingStatusText(
        cause: SessionFailureCause?,
        consecutiveFailures: Int
    ) -> String {
        let base = "Paired (reconnecting)"
        guard let cause, consecutiveFailures >= announceAfterConsecutiveFailures else { return base }
        return "\(base)\n\n\(cause.explanation)"
    }

    static func classify(_ error: Error) -> SessionFailureCause {
        if let rejected = error as? SessionRejected { return .rejected(rejected.reason) }
        if let reason = error as? SessionRejectionReason { return .rejected(reason) }
        // No answer within the whole budget. Indistinguishable from a Mac that is off.
        if error is SessionConnectionReadyTimeout { return .hostUnreachable }
        // Every dial in the attempt came up too slowly to trust and was abandoned. From the
        // screen's point of view that is the same fact as never coming up at all.
        if error is SessionConnectionSlow { return .hostUnreachable }
        // Abandoned while blocked. The transport's own reason string is the only detail, and
        // it carries the same POSIX vocabulary the structured errors do.
        if let blocked = error as? SessionConnectionBlocked {
            return classify(reasonText: blocked.reason)
        }
        if let code = posixCode(from: error) { return classify(posix: code) }
        return classify(reasonText: String(describing: error))
    }

    // MARK: - Signal extraction

    // The transport hands back POSIX failures in several wrappers depending on which layer
    // noticed. All three shapes are checked rather than assuming one, because guessing wrong
    // here degrades silently to `.unknown` and the whole point is not doing that.
    private static func posixCode(from error: Error) -> Int32? {
        if let posix = error as? POSIXError { return posix.code.rawValue }
        if let nwError = error as? NWError, case let .posix(code) = nwError { return code.rawValue }
        let nsError = error as NSError
        if nsError.domain == NSPOSIXErrorDomain { return Int32(nsError.code) }
        return nil
    }

    private static func classify(posix code: Int32) -> SessionFailureCause {
        switch code {
        case ECONNREFUSED:
            return .hostNotRunning
        case EHOSTUNREACH, EHOSTDOWN, ETIMEDOUT, ECONNABORTED, ECONNRESET:
            return .hostUnreachable
        case ENETDOWN, ENETUNREACH, ENETRESET:
            return .networkUnavailable
        default:
            return .unknown
        }
    }

    // Last resort for errors that only survive as text -- a blocked dial's reason, or a
    // transport error whose concrete type this layer cannot see. Matches the POSIX spellings
    // Network.framework prints, not free-form English, so it stays a lookup rather than a
    // guess. Anything unrecognised stays `.unknown` on purpose.
    private static func classify(reasonText text: String) -> SessionFailureCause {
        if text.contains("ECONNREFUSED") || text.contains("Connection refused") {
            return .hostNotRunning
        }
        if text.contains("EHOSTUNREACH") || text.contains("EHOSTDOWN") || text.contains("ETIMEDOUT") {
            return .hostUnreachable
        }
        if text.contains("ENETDOWN") || text.contains("ENETUNREACH") {
            return .networkUnavailable
        }
        return .unknown
    }
}
