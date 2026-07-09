import Testing

@testable import AgentDeskHost

struct HostPtyManagerProcessTests {
    @Test func matchingPeerDigestPreservesLiveManager() {
        let peer = HostPtyManagerSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")

        let decision = HostPtyManagerSocketVerifier.decide(
            peer: peer,
            bundledDigest: "same",
            peerDigest: "same"
        )

        #expect(decision == .preserve(peer))
    }

    @Test func mismatchedPeerDigestTerminatesLiveManager() {
        let peer = HostPtyManagerSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")

        let decision = HostPtyManagerSocketVerifier.decide(
            peer: peer,
            bundledDigest: "new",
            peerDigest: "old"
        )

        #expect(decision == .terminate(
            peer: peer,
            reason: "live pty-manager binary hash differs from bundled binary"
        ))
    }

    @Test func unresolvedPeerBlocksInsteadOfTrustingSocket() {
        let decision = HostPtyManagerSocketVerifier.decide(
            peer: nil,
            bundledDigest: "new",
            peerDigest: nil
        )

        #expect(decision == .block(
            reason: "socket accepted a connection but peer process could not be resolved"
        ))
    }

    @Test func unreadableBundledDigestBlocksInsteadOfKillingPeer() {
        let peer = HostPtyManagerSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")

        let decision = HostPtyManagerSocketVerifier.decide(
            peer: peer,
            bundledDigest: nil,
            peerDigest: "old"
        )

        #expect(decision == .block(reason: "bundled pty-manager digest could not be read"))
    }

    @Test func unreadablePeerDigestBlocksInsteadOfTrustingSocket() {
        let peer = HostPtyManagerSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")

        let decision = HostPtyManagerSocketVerifier.decide(
            peer: peer,
            bundledDigest: "new",
            peerDigest: nil
        )

        #expect(decision == .block(reason: "live pty-manager digest could not be read"))
    }
}
