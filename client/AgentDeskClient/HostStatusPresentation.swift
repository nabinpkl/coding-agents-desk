import AgentDeskWire

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

    /// The network moved and the session is being rebuilt. The last decoded frame stays on
    /// screen underneath, so this reads as a transition over a live picture rather than an
    /// error over a blank one.
    static let switchingNetwork = HostStatusPresentation(
        message: "Switching network…",
        showsActivity: true,
        offersReconnect: true
    )

    /// The user asked for the session back by hand. The escape hatch is withheld while that
    /// is in flight, since the thing it offers is already happening.
    static let reconnecting = HostStatusPresentation(
        message: "Reconnecting…",
        showsActivity: true,
        offersReconnect: false
    )

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
