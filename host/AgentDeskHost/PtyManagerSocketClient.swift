import Foundation
import PtyClientSwift

/// The host's single entry point to the local `pty-manager` daemon (the Rust process spawned and
/// hash-verified by `HostPtyManagerProcess`). Every host-side terminal feature — the top-bar
/// "＋ Terminal" spawn (R55) and the PTY Manager window (R56) — talks to the daemon through a
/// `PtyClient` bound to *our* socket (`Config.ptyManagerSocketURL`), never the donor's `/tmp`
/// default. A fresh `UnixSocketPtyTransport` is dialed per request/stream, matching `PtyClient`'s
/// request-response model; the socket is not opened until a call is actually made.
enum PtyManagerSocketClient {
    /// The Unix-domain socket the bundled pty-manager daemon binds (see `HostPtyManagerProcess`).
    static var socketPath: String { Config.ptyManagerSocketURL.path }

    /// A `PtyClient` that dials our daemon. Each request it issues opens a fresh transport on this
    /// socket, so a dead/replaced daemon surfaces as a per-call connect error rather than a stale
    /// long-lived handle.
    static func makeClient() -> PtyClient {
        PtyClient(makeTransport: { try UnixSocketPtyTransport(socketPath: socketPath) })
    }
}
