import Foundation

enum AgentResumeValidationError: Error, Equatable, Sendable {
    case invalidSource(String)
    case invalidHarnessSessionID(String)
    case projectDirectoryNotAbsolute(String)
    case projectDirectoryOutsideHome(projectDirectory: String, homeDirectory: String)
    case projectDirectoryDoesNotExist(String)
    case projectPathIsNotDirectory(String)
    case invalidExecutable(source: AgentResumeTerminalIdentity.Source, executable: String)
}

struct AgentResumeTerminalIdentity: Equatable, Sendable {
    enum Source: String, Equatable, Sendable, CaseIterable {
        case claude
        case codex
    }

    let source: Source
    let harnessSessionID: String
    let projectDirectory: URL
    let ptySessionName: String

    init(
        source rawSource: String,
        harnessSessionID rawSessionID: String,
        projectDirectoryPath: String,
        homeDirectory: URL,
        fileManager: FileManager = .default
    ) throws {
        guard let source = Source(rawValue: rawSource) else {
            throw AgentResumeValidationError.invalidSource(rawSource)
        }

        guard let sessionUUID = UUID(uuidString: rawSessionID) else {
            throw AgentResumeValidationError.invalidHarnessSessionID(rawSessionID)
        }
        let canonicalSessionID = sessionUUID.uuidString.lowercased()
        guard rawSessionID.lowercased() == canonicalSessionID else {
            throw AgentResumeValidationError.invalidHarnessSessionID(rawSessionID)
        }

        guard (projectDirectoryPath as NSString).isAbsolutePath else {
            throw AgentResumeValidationError.projectDirectoryNotAbsolute(projectDirectoryPath)
        }

        let canonicalHome = Self.canonicalDirectory(homeDirectory)
        let canonicalProject = Self.canonicalDirectory(
            URL(fileURLWithPath: projectDirectoryPath, isDirectory: true)
        )
        guard Self.isStrictDescendant(canonicalProject, of: canonicalHome) else {
            throw AgentResumeValidationError.projectDirectoryOutsideHome(
                projectDirectory: canonicalProject.path,
                homeDirectory: canonicalHome.path
            )
        }

        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: canonicalProject.path, isDirectory: &isDirectory) else {
            throw AgentResumeValidationError.projectDirectoryDoesNotExist(canonicalProject.path)
        }
        guard isDirectory.boolValue else {
            throw AgentResumeValidationError.projectPathIsNotDirectory(canonicalProject.path)
        }

        self.source = source
        harnessSessionID = canonicalSessionID
        projectDirectory = canonicalProject
        ptySessionName = "agent-resume-\(source.rawValue)-\(canonicalSessionID)"
    }

    /// Whether a session name belongs to the agent-resume namespace at all. The workspace terminals
    /// and the agent terminals share one PTY manager, so anything that attaches by name checks that
    /// it is reaching into its own namespace first. This is the same guard
    /// `WorkspaceTerminalIdentity.owns(sessionName:)` performs from the other side.
    static func owns(sessionName: String) -> Bool {
        for source in Source.allCases {
            let prefix = "agent-resume-\(source.rawValue)-"
            guard sessionName.hasPrefix(prefix) else { continue }
            let suffix = String(sessionName.dropFirst(prefix.count))
            return UUID(uuidString: suffix)?.uuidString.lowercased() == suffix
        }
        return false
    }

    private static func canonicalDirectory(_ url: URL) -> URL {
        url.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
    }

    private static func isStrictDescendant(_ candidate: URL, of parent: URL) -> Bool {
        let parentComponents = parent.pathComponents
        let candidateComponents = candidate.pathComponents
        return candidateComponents.count > parentComponents.count
            && candidateComponents.prefix(parentComponents.count).elementsEqual(parentComponents)
    }
}
