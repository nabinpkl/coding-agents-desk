import Foundation

/// Why the last dial ended, which is the only thing that picks the next backoff rung.
enum SessionDialOutcome: Equatable {
    /// No attempt has failed since the last success (or since launch), so the next dial is
    /// immediate. A carrier loss on a healthy session lands here, which is what keeps
    /// ADR-0089's "re-dial NOW during a handover" true without a special case for it.
    case clean
    case failed
    /// ADR-0104's death verdict: the host has not answered within the silence limit. Still
    /// retried, because the client has nothing better to do and the host may come back; just
    /// on the long rung, since the point of the verdict was never to stop trying, it was to
    /// stop hammering a host that is not there.
    case unreachable
}

/// Everything the dial decision depends on, gathered in one place.
///
/// The completeness is the point. `isForeground` in particular was never a guard in the old
/// per-trigger design -- it worked only because every call site happened to be a foreground
/// path, which is exactly the kind of implicit precondition that goes wrong when someone adds
/// the thirteenth call site.
struct SessionDialInputs: Equatable {
    var state: PairingClientState
    var userRequestedDisconnect: Bool
    var surface: ControlSurface
    var isForeground: Bool
    /// Owned by `SessionSupervisor`, which fills it in before consulting the policy. The
    /// environment closure that supplies the other four does not know it and must not guess:
    /// the rung is a property of the dial history, not of the world the client is looking at.
    var lastOutcome: SessionDialOutcome = .clean
}

enum SessionDialPlan: Equatable {
    /// Nothing to do. Wait for an input to change.
    case idle
    case dial
    /// Wait this long, or until an input changes, whichever comes first.
    case backoff(ms: Int)
}

/// The whole dial decision, as a pure function. No I/O, no clock, no tasks -- so the thing
/// that decides whether a client ever reconnects can be tested exhaustively in microseconds.
enum SessionDialPolicy {
    /// Whether the client is ALLOWED to hold a session at all, independent of what the session
    /// is currently doing.
    ///
    /// This, and NOT the full plan, is what cancels a dial in flight. `.sessionConnecting` is
    /// not a dialable state, but it is the state a dial itself creates: keying cancellation on
    /// the plan would have every dial cancel itself on its own first state transition. The gate
    /// closes only for the three reasons a human or the OS took the session away -- backgrounded,
    /// disconnected on purpose, or switched to the local-only Voice surface.
    static func isAllowed(_ inputs: SessionDialInputs) -> Bool {
        guard inputs.isForeground else { return false }
        guard !inputs.userRequestedDisconnect else { return false }
        // Voice is fully on-device. Showing it must not wait for, start, or hold a host session.
        guard inputs.surface != .voice else { return false }
        return true
    }

    static func plan(for inputs: SessionDialInputs) -> SessionDialPlan {
        guard isAllowed(inputs), inputs.state.isDialable else { return .idle }
        switch inputs.lastOutcome {
        case .clean:
            return .dial
        case .failed:
            return .backoff(ms: Config.sessionReconnectRetryDelayMs)
        case .unreachable:
            return .backoff(ms: Config.sessionEndedRetryDelayMs)
        }
    }
}
