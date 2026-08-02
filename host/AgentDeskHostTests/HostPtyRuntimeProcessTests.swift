import Foundation
import Testing

@testable import AgentDeskHost

struct HostPtyRuntimeProcessTests {
    @Test func managerLaunchArgumentsIncludeSocketAndOptionalHandover() {
        let socket = URL(fileURLWithPath: "/tmp/agentdesk-pty.sock")

        #expect(HostPtyRuntimeProcess.managerLaunchArguments(
            socketURL: socket
        ) == [
            "--socket", "/tmp/agentdesk-pty.sock",
        ])
        #expect(Array(HostPtyRuntimeProcess.managerLaunchArguments(
            socketURL: socket,
            handover: true,
            runtimeDigest: "manager-digest"
        ).suffix(3)) == ["--handover", "--runtime-digest", "manager-digest"])
    }

    @Test func vaultLaunchArgumentsIncludeOptionalHandover() {
        let socket = URL(fileURLWithPath: "/tmp/agentdesk-vault.sock")
        #expect(HostPtyRuntimeProcess.vaultLaunchArguments(socketURL: socket) == [
            "--socket", "/tmp/agentdesk-vault.sock",
        ])
        #expect(
            HostPtyRuntimeProcess.vaultLaunchArguments(
                socketURL: socket,
                handover: true,
                runtimeDigest: "vault-digest"
            ) == [
                "--socket", "/tmp/agentdesk-vault.sock",
                "--handover", "--runtime-digest", "vault-digest",
            ]
        )
    }

    @Test func absentPeerLaunchesFreshComponent() {
        #expect(HostPtyRuntimeSocketVerifier.decide(
            peer: nil,
            bundledExecutablePath: "/tmp/pty-manager",
            bundledDigest: "new",
            recordedIdentity: nil
        ) == .launch)
    }

    @Test func matchingRecordedGenerationIsPreserved() {
        let peer = HostPtyRuntimeSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")
        #expect(HostPtyRuntimeSocketVerifier.decide(
            peer: peer,
            bundledExecutablePath: "/tmp/pty-manager",
            bundledDigest: "same",
            recordedIdentity: HostPtyRuntimeIdentity(pid: 42, digest: "same")
        ) == .preserve(peer))
    }

    @Test func changedRecordedGenerationRequestsHandover() {
        let peer = HostPtyRuntimeSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")
        #expect(HostPtyRuntimeSocketVerifier.decide(
            peer: peer,
            bundledExecutablePath: "/tmp/pty-manager",
            bundledDigest: "new",
            recordedIdentity: HostPtyRuntimeIdentity(pid: 42, digest: "old")
        ) == .handover(peer))
    }

    @Test func unrecognizedLivePeerBlocksWithoutKilling() {
        let peer = HostPtyRuntimeSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")
        #expect(HostPtyRuntimeSocketVerifier.decide(
            peer: peer,
            bundledExecutablePath: "/tmp/pty-manager",
            bundledDigest: "new",
            recordedIdentity: nil
        ) == .block(
            reason: "live PTY runtime has no matching durable identity; use the explicit destructive reset"
        ))
    }

    @Test func unreadableBundledDigestBlocks() {
        let peer = HostPtyRuntimeSocketPeer(pid: 42, executablePath: "/tmp/pty-manager")
        #expect(HostPtyRuntimeSocketVerifier.decide(
            peer: peer,
            bundledExecutablePath: "/tmp/pty-manager",
            bundledDigest: nil,
            recordedIdentity: HostPtyRuntimeIdentity(pid: 42, digest: "old")
        ) == .block(reason: "bundled PTY runtime digest could not be read"))
    }

    /// A runtime that cannot launch has to settle its readiness rather than leave awaiting restores
    /// parked forever; a launch-blocked host should come up without terminals, not hang.
    @Test func blockedLaunchResolvesWaitersFalse() async {
        let missing = URL(fileURLWithPath: "/tmp/agentdesk-nonexistent-pty-runtime")
        let socketDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdesk-readiness-\(UUID().uuidString)", isDirectory: true)
        let process = HostPtyRuntimeProcess(
            vaultBinaryURL: missing,
            managerBinaryURL: missing,
            vaultSocketURL: socketDirectory.appendingPathComponent("vault.sock"),
            managerSocketURL: socketDirectory.appendingPathComponent("manager.sock")
        )
        process.start()

        #expect(await process.waitUntilReady() == false)
        // Settled state is remembered, so a later waiter answers immediately instead of re-waiting.
        #expect(await process.waitUntilReady() == false)

        try? FileManager.default.removeItem(at: socketDirectory)
    }

    @Test func differentExecutablePathBlocksWithoutKilling() {
        let peer = HostPtyRuntimeSocketPeer(pid: 42, executablePath: "/tmp/other-manager")
        #expect(HostPtyRuntimeSocketVerifier.decide(
            peer: peer,
            bundledExecutablePath: "/tmp/pty-manager",
            bundledDigest: "new",
            recordedIdentity: HostPtyRuntimeIdentity(pid: 42, digest: "new")
        ) == .block(reason: "live PTY runtime executable path differs from bundled runtime"))
    }
}
