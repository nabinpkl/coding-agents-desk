import AgentDeskWire

/// What the client is doing with the session, as distinct from what the host says about
/// itself. Only one of the two can be authoritative at a time; see `resolve`.
enum HostSessionActivity: Equatable {
    /// A session is up, so the host's own availability pushes are the real signal.
    case live
    /// The client tore the session down and is rebuilding it. Whatever availability value is
    /// around belongs to the session that just ended.
    case recovering(MediaSessionLoss)
    /// The user pressed Reconnect.
    case userRequestedReconnect
}

// What the host-status overlay should show, as a value. Dependency-free (no UIKit) so it can
// be compiled into the test target directly, the same arrangement ControlSurface.swift uses.
//
// This exists because the decision and the drawing used to be the same code: four switch arms
// poking `isHidden` on two views and re-ordering subviews by hand, spread across the
// availability push handler, the media teardown, and the transport start. Nothing could state
// what the overlay was meant to show in a given state, so nothing could check it -- which is
// how the reconnect message ended up centered on the video, then rode a collapsed video view
// up under the notch (R230). Deciding here and drawing in HostStatusOverlay separates the two.
struct HostStatusPresentation: Equatable {
    /// Nil hides the overlay entirely.
    let message: String?
    /// Show a spinner: something is in flight and the user should expect this to resolve
    /// on its own.
    let showsActivity: Bool
    /// Offer the manual escape hatch. Any recovery path can have a case it does not cover,
    /// and when that happens the user should not be left holding a dead screen.
    let offersReconnect: Bool

    static let hidden = HostStatusPresentation(
        message: nil,
        showsActivity: false,
        offersReconnect: false
    )

    /// The user asked for the session back by hand. The escape hatch is withheld while that
    /// is in flight, since the thing it offers is already happening.
    static let reconnecting = HostStatusPresentation(
        message: "Reconnecting…",
        showsActivity: true,
        offersReconnect: false
    )

    /// What the overlay should show, given both what the client is doing and what the host
    /// last said about itself.
    ///
    /// Precedence, not last-writer-wins, and that is the whole point. These two inputs used to
    /// race: a handover applied its own state, and milliseconds later the transport reaching
    /// `.closed` synthesized a `captureUnavailable` push -- from the client, about itself --
    /// which overwrote it. The user got "Mac display unavailable" during a WiFi-to-cellular
    /// switch, blaming a Mac that was fine for the phone's own radio moving.
    ///
    /// A recovery in flight wins because the host cannot be speaking: there is no session to
    /// speak over, so any availability value alongside one is the client's own inference.
    static func resolve(
        activity: HostSessionActivity,
        availability: HostAvailability
    ) -> HostStatusPresentation {
        switch activity {
        case .live:
            return forAvailability(availability)
        case .userRequestedReconnect:
            return .reconnecting
        case .recovering(let loss):
            return forLoss(loss)
        }
    }

    /// Every recovery keeps the escape hatch: the messages differ in what they blame, not in
    /// what they offer, because any of them can be a recovery that never lands.
    static func forLoss(_ loss: MediaSessionLoss) -> HostStatusPresentation {
        switch loss {
        case .linkChanged:
            // Says what actually happened, and says nothing about the Mac. The last decoded
            // frame stays on screen underneath, so this reads as a transition over a live
            // picture rather than an error over a blank one.
            return HostStatusPresentation(
                message: "Switching network…",
                showsActivity: true,
                offersReconnect: true
            )
        case .hostSilent:
            return HostStatusPresentation(
                message: "Mac stopped responding",
                showsActivity: true,
                offersReconnect: true
            )
        case .transportFailed:
            return HostStatusPresentation(
                message: "Connection lost",
                showsActivity: true,
                offersReconnect: true
            )
        case .rejected:
            // A refusal ends the session rather than recovering it, so the pairing screen
            // takes over and there is nothing for this overlay to say.
            return .hidden
        }
    }

    static func forAvailability(_ availability: HostAvailability) -> HostStatusPresentation {
        switch availability {
        case .active, .disconnected:
            return .hidden
        case .locked:
            // A locked Mac is a healthy session: nothing is in flight and there is nothing
            // to recover from, so neither the spinner nor the escape hatch belongs here.
            return HostStatusPresentation(
                message: "Mac locked\nKeyboard input stays available",
                showsActivity: false,
                offersReconnect: false
            )
        case .captureUnavailable:
            // Deliberately does not promise that input still works. That claim was measured
            // false: the host had ended the session on a connection timeout and nothing was
            // connected at all, while this text reassured the user otherwise.
            return HostStatusPresentation(
                message: "Mac display unavailable",
                showsActivity: false,
                offersReconnect: true
            )
        }
    }
}
