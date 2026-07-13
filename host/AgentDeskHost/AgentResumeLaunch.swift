import Foundation
import PtyClientSwift

struct AgentResumeLaunch: Equatable, Sendable {
    struct Executables: Equatable, Sendable {
        let claude: String
        let codex: String

        fileprivate func executable(for source: AgentResumeTerminalIdentity.Source) -> String {
            switch source {
            case .claude: claude
            case .codex: codex
            }
        }
    }

    static let positionalForwardingScript = #"exec "$0" "$@""#

    let ptyLaunch: PtySessionLaunch

    init(identity: AgentResumeTerminalIdentity, executables: Executables) throws {
        let harnessExecutable = executables.executable(for: identity.source)
        guard !harnessExecutable.isEmpty, !harnessExecutable.contains("\0") else {
            throw AgentResumeValidationError.invalidExecutable(
                source: identity.source,
                executable: harnessExecutable
            )
        }

        let harnessArguments: [String]
        switch identity.source {
        case .claude:
            harnessArguments = [harnessExecutable, "--resume", identity.harnessSessionID]
        case .codex:
            harnessArguments = [harnessExecutable, "resume", identity.harnessSessionID]
        }

        ptyLaunch = .command(
            cwd: identity.projectDirectory.path,
            executable: "/bin/zsh",
            arguments: ["-l", "-c", Self.positionalForwardingScript] + harnessArguments
        )
    }
}
