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
        ) == .block(reason: "live PTY runtime has no matching durable identity"))
    }

    /// The gap this closes, measured 2026-09-15: a cold-started manager could not reach its vault,
    /// exited two seconds in, and stayed down for twelve hours because the only thing watching was
    /// a log line.
    @Test func aManagerThatExitsOnItsOwnIsBroughtBack() {
        #expect(HostPtyRuntimeSocketVerifier.restart(
            component: .manager,
            deliberate: false,
            openingLadderSettled: true,
            somethingServing: false,
            consecutiveRestarts: 0,
            limit: 5
        ) == .relaunch)
    }

    /// A vault that exited took every master descriptor with it, so whether a fresh one may start
    /// is the manager's custody reseed to settle rather than this callback's.
    @Test func aVaultThatExitsIsLeftAlone() {
        #expect(HostPtyRuntimeSocketVerifier.restart(
            component: .vault,
            deliberate: false,
            openingLadderSettled: true,
            somethingServing: false,
            consecutiveRestarts: 0,
            limit: 5
        ) != .relaunch)
    }

    /// The three exits that are not a crash: one this host asked for, one during the opening
    /// ladder, and the outgoing half of a handover whose successor is already serving.
    @Test func anOrderlyExitIsNotRestarted() {
        for decision in [
            HostPtyRuntimeSocketVerifier.restart(
                component: .manager,
                deliberate: true,
                openingLadderSettled: true,
                somethingServing: false,
                consecutiveRestarts: 0,
                limit: 5
            ),
            HostPtyRuntimeSocketVerifier.restart(
                component: .manager,
                deliberate: false,
                openingLadderSettled: false,
                somethingServing: false,
                consecutiveRestarts: 0,
                limit: 5
            ),
            HostPtyRuntimeSocketVerifier.restart(
                component: .manager,
                deliberate: false,
                openingLadderSettled: true,
                somethingServing: true,
                consecutiveRestarts: 0,
                limit: 5
            ),
        ] {
            #expect(decision != .relaunch)
        }
    }

    /// A manager that cannot stay up is a different fault, and restarting it forever would bury
    /// the log line that says which one.
    @Test func aCrashLoopStopsAtTheLimit() {
        #expect(HostPtyRuntimeSocketVerifier.restart(
            component: .manager,
            deliberate: false,
            openingLadderSettled: true,
            somethingServing: false,
            consecutiveRestarts: 4,
            limit: 5
        ) == .relaunch)
        #expect(HostPtyRuntimeSocketVerifier.restart(
            component: .manager,
            deliberate: false,
            openingLadderSettled: true,
            somethingServing: false,
            consecutiveRestarts: 5,
            limit: 5
        ) == .leave(reason: "restarted 5 times without staying up"))
    }

    /// The invariant behind ADR-0080: whatever goes wrong, a live vault keeps serving. Terminating
    /// it would close the last master descriptor for every session on the machine.
    @Test func liveVaultIsKeptWhateverWentWrong() {
        #expect(HostPtyRuntimeSocketVerifier.recover(
            recovery: .keepPredecessor,
            predecessorAlive: true,
            reason: "handover declined"
        ) == .keepPredecessor(reason: "handover declined"))
    }

    /// A vault that is not actually serving holds nothing, so the bundled binary starts clean.
    @Test func absentVaultColdStarts() {
        #expect(HostPtyRuntimeSocketVerifier.recover(
            recovery: .keepPredecessor,
            predecessorAlive: false,
            reason: "handover declined"
        ) == .coldStart)
    }

    /// A cold-started vault is empty until it reseeds custody from the running manager's leases, so
    /// during that window the manager holds the only descriptors keeping the children alive.
    /// Replacing it there would close the last master for every session, which is the one way the
    /// ladder could still lose everything.
    @Test func rebuiltVaultKeepsTheManagerThatHoldsTheOnlyDescriptors() {
        #expect(HostPtyRuntimeSocketVerifier.recover(
            recovery: .keepPredecessor,
            predecessorAlive: true,
            reason: "vault was rebuilt"
        ) == .keepPredecessor(reason: "vault was rebuilt"))
    }

    /// The manager is disposable: the vault still holds every master descriptor, and a cold-started
    /// manager re-adopts them. Replacing it costs bounded replay state, not sessions.
    @Test func failedManagerHandoverColdStarts() {
        #expect(HostPtyRuntimeSocketVerifier.recover(
            recovery: .replacePredecessor,
            predecessorAlive: true,
            reason: "handover declined"
        ) == .coldStart)
        #expect(HostPtyRuntimeSocketVerifier.recover(
            recovery: .replacePredecessor,
            predecessorAlive: false,
            reason: "handover declined"
        ) == .coldStart)
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
