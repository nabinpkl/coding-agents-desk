import XCTest
import PtyClientSwift
@testable import AgentDeskHost

/// R53: the host seam dials *our* daemon socket, not the donor's `/tmp` default. A live round-trip
/// needs a running daemon (manual verification); this locks the wiring that a wrong default would
/// silently break — the whole point of routing terminals through the bundled, hash-verified daemon.
final class PtyManagerSocketClientTests: XCTestCase {
    func testSocketPathIsOurBundleScopedDaemonSocket() {
        XCTAssertEqual(PtyManagerSocketClient.socketPath, Config.ptyManagerSocketURL.path)
        XCTAssertTrue(
            PtyManagerSocketClient.socketPath.hasSuffix("/pty-manager.sock"),
            "the seam must dial the pty-manager socket, got \(PtyManagerSocketClient.socketPath)"
        )
        XCTAssertNotEqual(
            PtyManagerSocketClient.socketPath, "/tmp/pty-manager.sock",
            "must not fall back to the donor's /tmp default"
        )
    }

    func testMakeClientDoesNotConnectEagerly() {
        // Constructing the client only stores the transport factory; no socket is dialed until a
        // request is made, so this is safe with no daemon running.
        _ = PtyManagerSocketClient.makeClient()
    }
}
