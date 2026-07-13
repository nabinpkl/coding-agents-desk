import Foundation
import PtyClientSwift
import Testing

@testable import AgentDeskHost

struct AgentResumeModelsTests {
    private let sessionID = "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"

    private func temporaryDirectory(named name: String = UUID().uuidString) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-resume-tests-\(name)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func directory(named name: String, in parent: URL) throws -> URL {
        let url = parent.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func identity(
        source: String = "claude",
        sessionID: String? = nil,
        projectDirectoryPath: String,
        homeDirectory: URL
    ) throws -> AgentResumeTerminalIdentity {
        try AgentResumeTerminalIdentity(
            source: source,
            harnessSessionID: sessionID ?? self.sessionID,
            projectDirectoryPath: projectDirectoryPath,
            homeDirectory: homeDirectory
        )
    }

    @Test func bothSourcesDeriveDeterministicCanonicalIdentity() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)

        let claude = try identity(projectDirectoryPath: project.path, homeDirectory: home)
        let codex = try identity(
            source: "codex",
            sessionID: sessionID.uppercased(),
            projectDirectoryPath: project.path,
            homeDirectory: home
        )

        #expect(claude.source == .claude)
        #expect(claude.harnessSessionID == sessionID)
        #expect(claude.projectDirectory == project.resolvingSymlinksInPath().standardizedFileURL)
        #expect(claude.ptySessionName == "agent-resume-claude-\(sessionID)")
        #expect(codex.source == .codex)
        #expect(codex.harnessSessionID == sessionID)
        #expect(codex.ptySessionName == "agent-resume-codex-\(sessionID)")

        let repeated = try identity(projectDirectoryPath: project.path, homeDirectory: home)
        #expect(repeated == claude)
    }

    @Test func sourceMustMatchExactly() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)

        for source in ["Claude", "CODEX", "codex ", " codex", "other", ""] {
            #expect(throws: AgentResumeValidationError.invalidSource(source)) {
                try identity(
                    source: source,
                    projectDirectoryPath: project.path,
                    homeDirectory: home
                )
            }
        }
    }

    @Test func sessionIDMustBeCanonicalUUIDText() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)
        let invalidIDs = [
            "",
            "not-a-uuid",
            "a4cdd7b83f9a4d80bc725f4aab6f39e1",
            "{\(sessionID)}",
            " \(sessionID)",
            "\(sessionID); touch /tmp/agent-resume-injected",
        ]

        for invalidID in invalidIDs {
            #expect(throws: AgentResumeValidationError.invalidHarnessSessionID(invalidID)) {
                try identity(
                    sessionID: invalidID,
                    projectDirectoryPath: project.path,
                    homeDirectory: home
                )
            }
        }
    }

    @Test func projectDirectoryMustBeAbsoluteAndExistAsDirectory() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let missing = home.appendingPathComponent("missing", isDirectory: true)
        let file = home.appendingPathComponent("file", isDirectory: false)
        try Data().write(to: file)

        #expect(throws: AgentResumeValidationError.projectDirectoryNotAbsolute("project")) {
            try identity(projectDirectoryPath: "project", homeDirectory: home)
        }
        #expect(throws: AgentResumeValidationError.projectDirectoryDoesNotExist(missing.path)) {
            try identity(projectDirectoryPath: missing.path, homeDirectory: home)
        }
        #expect(throws: AgentResumeValidationError.projectPathIsNotDirectory(file.path)) {
            try identity(projectDirectoryPath: file.path, homeDirectory: home)
        }
    }

    @Test func projectContainmentUsesPathComponentsAfterStandardization() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)
        let sibling = try directory(named: "home-other", in: sandbox)
        let traversal = project.appendingPathComponent("../../home-other", isDirectory: true).path

        #expect(throws: AgentResumeValidationError.projectDirectoryOutsideHome(
            projectDirectory: sibling.path,
            homeDirectory: home.path
        )) {
            try identity(projectDirectoryPath: sibling.path, homeDirectory: home)
        }
        #expect(throws: AgentResumeValidationError.projectDirectoryOutsideHome(
            projectDirectory: sibling.path,
            homeDirectory: home.path
        )) {
            try identity(projectDirectoryPath: traversal, homeDirectory: home)
        }
        #expect(throws: AgentResumeValidationError.projectDirectoryOutsideHome(
            projectDirectory: home.path,
            homeDirectory: home.path
        )) {
            try identity(projectDirectoryPath: home.path, homeDirectory: home)
        }
    }

    @Test func symlinksResolveBeforeContainmentValidation() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)
        let outside = try directory(named: "outside", in: sandbox)
        let internalLink = home.appendingPathComponent("project-link", isDirectory: true)
        let escapeLink = home.appendingPathComponent("escape-link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: internalLink, withDestinationURL: project)
        try FileManager.default.createSymbolicLink(at: escapeLink, withDestinationURL: outside)

        let linkedIdentity = try identity(
            projectDirectoryPath: internalLink.path,
            homeDirectory: home
        )
        #expect(linkedIdentity.projectDirectory == project.resolvingSymlinksInPath().standardizedFileURL)

        #expect(throws: AgentResumeValidationError.projectDirectoryOutsideHome(
            projectDirectory: outside.path,
            homeDirectory: home.path
        )) {
            try identity(projectDirectoryPath: escapeLink.path, homeDirectory: home)
        }
    }

    @Test func symlinkParentTraversalCannotBeStandardizedIntoHome() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        _ = try directory(named: "project", in: home)
        let outside = try directory(named: "outside", in: sandbox)
        let outsideNested = try directory(named: "nested", in: outside)
        let escapedProject = try directory(named: "project", in: outside)
        let link = home.appendingPathComponent("link", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outsideNested)
        let symlinkTraversal = link.appendingPathComponent("../project", isDirectory: true).path

        #expect(throws: AgentResumeValidationError.projectDirectoryOutsideHome(
            projectDirectory: escapedProject.path,
            homeDirectory: home.path
        )) {
            try identity(projectDirectoryPath: symlinkTraversal, homeDirectory: home)
        }
    }

    @Test func claudeLaunchUsesExactLoginZshExecutableCwdAndArgv() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)
        let identity = try identity(projectDirectoryPath: project.path, homeDirectory: home)
        let executables = Config.agentResumeExecutables(environment: [:])

        let launch = try AgentResumeLaunch(identity: identity, executables: executables)

        #expect(launch.ptyLaunch == .command(
            cwd: project.path,
            executable: "/bin/zsh",
            arguments: [
                "-l",
                "-c",
                AgentResumeLaunch.positionalForwardingScript,
                "claude",
                "--resume",
                sessionID,
            ]
        ))
    }

    @Test func codexLaunchUsesExactLoginZshExecutableCwdAndArgv() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)
        let identity = try identity(
            source: "codex",
            projectDirectoryPath: project.path,
            homeDirectory: home
        )
        let executables = Config.agentResumeExecutables(environment: [:])

        let launch = try AgentResumeLaunch(identity: identity, executables: executables)

        #expect(launch.ptyLaunch == .command(
            cwd: project.path,
            executable: "/bin/zsh",
            arguments: [
                "-l",
                "-c",
                AgentResumeLaunch.positionalForwardingScript,
                "codex",
                "resume",
                sessionID,
            ]
        ))
    }

    @Test func executableOverridesAreCentralAndRemainPositional() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project; $(touch escaped)", in: home)
        let identity = try identity(projectDirectoryPath: project.path, homeDirectory: home)
        let executable = "/custom/claude; $(touch injected)"
        let executables = Config.agentResumeExecutables(environment: [
            "AGENTDESK_CLAUDE_EXECUTABLE": executable,
            "AGENTDESK_CODEX_EXECUTABLE": "/custom/codex",
        ])

        let launch = try AgentResumeLaunch(identity: identity, executables: executables)
        guard case .command(let cwd, let shell, let arguments) = launch.ptyLaunch else {
            Issue.record("Expected a direct command launch")
            return
        }

        #expect(executables.claude == executable)
        #expect(executables.codex == "/custom/codex")
        #expect(cwd == project.path)
        #expect(shell == "/bin/zsh")
        #expect(arguments[2] == #"exec "$0" "$@""#)
        #expect(arguments[2].contains(executable) == false)
        #expect(arguments[2].contains(project.path) == false)
        #expect(arguments[2].contains(sessionID) == false)
        #expect(arguments[3...] == [executable, "--resume", sessionID])
    }

    @Test func invalidExecutableOverrideReturnsTypedError() throws {
        let sandbox = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let home = try directory(named: "home", in: sandbox)
        let project = try directory(named: "project", in: home)
        let identity = try identity(projectDirectoryPath: project.path, homeDirectory: home)

        for executable in ["", "claude\0injected"] {
            let executables = AgentResumeLaunch.Executables(
                claude: executable,
                codex: "codex"
            )
            #expect(throws: AgentResumeValidationError.invalidExecutable(
                source: .claude,
                executable: executable
            )) {
                try AgentResumeLaunch(identity: identity, executables: executables)
            }
        }
    }
}
