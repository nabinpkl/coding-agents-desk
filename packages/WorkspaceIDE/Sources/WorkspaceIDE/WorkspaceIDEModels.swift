import AgentDeskWire
import Foundation

public struct WorkspaceIDEPlatformCapabilities: OptionSet, Sendable {
    public let rawValue: UInt16

    public init(rawValue: UInt16) { self.rawValue = rawValue }

    public static let addWorkspace = Self(rawValue: 1 << 0)
    public static let removeWorkspace = Self(rawValue: 1 << 1)
    public static let reorderWorkspaces = Self(rawValue: 1 << 2)
    public static let assignDesktop = Self(rawValue: 1 << 3)
    public static let autoAssignDesktop = Self(rawValue: 1 << 4)

    public static let macOSWorkspaceManagement: Self = [
        .addWorkspace, .removeWorkspace, .reorderWorkspaces, .assignDesktop, .autoAssignDesktop,
    ]
    public static let iPhone: Self = []
}

public enum WorkspaceIDESidebarSection: String, Codable, Equatable, Sendable {
    case explorer
    case sourceControl
}

public struct WorkspaceIDELocalState: Codable, Equatable, Sendable {
    public static let zoomStepRange = -4...10

    public var selectedWorkspaceID: String?
    public var activePathByWorkspace: [String: String]
    public var previewPathsByWorkspace: [String: Set<String>]
    public var sidebarSection: WorkspaceIDESidebarSection
    public var sidebarVisible: Bool
    public var terminalVisible: Bool
    public var sidebarFraction: Double
    public var terminalFraction: Double
    public private(set) var zoomStep: Int

    public var zoomScale: Double { Double(10 + zoomStep) / 10 }

    public init(
        selectedWorkspaceID: String? = nil,
        activePathByWorkspace: [String: String] = [:],
        previewPathsByWorkspace: [String: Set<String>] = [:],
        sidebarSection: WorkspaceIDESidebarSection = .explorer,
        sidebarVisible: Bool = true,
        terminalVisible: Bool = true,
        sidebarFraction: Double = 0.28,
        terminalFraction: Double = 0.36,
        zoomStep: Int = 0
    ) {
        self.selectedWorkspaceID = selectedWorkspaceID
        self.activePathByWorkspace = activePathByWorkspace
        self.previewPathsByWorkspace = previewPathsByWorkspace
        self.sidebarSection = sidebarSection
        self.sidebarVisible = sidebarVisible
        self.terminalVisible = terminalVisible
        self.sidebarFraction = Self.clamp(sidebarFraction, to: 0.18...0.55)
        self.terminalFraction = Self.clamp(terminalFraction, to: 0.18...0.72)
        self.zoomStep = Self.clamp(zoomStep, to: Self.zoomStepRange)
    }

    public mutating func setSidebarFraction(_ value: Double) {
        sidebarFraction = Self.clamp(value, to: 0.18...0.55)
    }

    public mutating func setTerminalFraction(_ value: Double) {
        terminalFraction = Self.clamp(value, to: 0.18...0.72)
    }

    public mutating func zoomIn() {
        zoomStep = Self.clamp(zoomStep + 1, to: Self.zoomStepRange)
    }

    public mutating func zoomOut() {
        zoomStep = Self.clamp(zoomStep - 1, to: Self.zoomStepRange)
    }

    private static func clamp(_ value: Double, to range: ClosedRange<Double>) -> Double {
        min(max(value, range.lowerBound), range.upperBound)
    }

    private static func clamp(_ value: Int, to range: ClosedRange<Int>) -> Int {
        min(max(value, range.lowerBound), range.upperBound)
    }

    private enum CodingKeys: String, CodingKey {
        case selectedWorkspaceID
        case activePathByWorkspace
        case previewPathsByWorkspace
        case sidebarSection
        case sidebarVisible
        case terminalVisible
        case sidebarFraction
        case terminalFraction
        case zoomStep
    }

    public init(from decoder: any Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            selectedWorkspaceID: try values.decodeIfPresent(String.self, forKey: .selectedWorkspaceID),
            activePathByWorkspace: try values.decodeIfPresent(
                [String: String].self,
                forKey: .activePathByWorkspace
            ) ?? [:],
            previewPathsByWorkspace: try values.decodeIfPresent(
                [String: Set<String>].self,
                forKey: .previewPathsByWorkspace
            ) ?? [:],
            sidebarSection: try values.decodeIfPresent(
                WorkspaceIDESidebarSection.self,
                forKey: .sidebarSection
            ) ?? .explorer,
            sidebarVisible: try values.decodeIfPresent(Bool.self, forKey: .sidebarVisible) ?? true,
            terminalVisible: try values.decodeIfPresent(Bool.self, forKey: .terminalVisible) ?? true,
            sidebarFraction: try values.decodeIfPresent(Double.self, forKey: .sidebarFraction) ?? 0.28,
            terminalFraction: try values.decodeIfPresent(Double.self, forKey: .terminalFraction) ?? 0.36,
            zoomStep: try values.decodeIfPresent(Int.self, forKey: .zoomStep) ?? 0
        )
    }
}

public protocol WorkspaceIDELocalStateStoring: AnyObject {
    func load() -> WorkspaceIDELocalState
    func save(_ state: WorkspaceIDELocalState)
}

public final class WorkspaceIDEUserDefaultsStateStore: WorkspaceIDELocalStateStoring {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "agentDesk.workspaceIDE.localState") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> WorkspaceIDELocalState {
        guard let data = defaults.data(forKey: key),
              let state = try? JSONDecoder().decode(WorkspaceIDELocalState.self, from: data)
        else { return WorkspaceIDELocalState() }
        return state
    }

    public func save(_ state: WorkspaceIDELocalState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: key)
    }
}

public enum WorkspaceIDEDataEvent: Equatable, Sendable {
    case workspaces([WorkspaceSummary])
    case sharedState(WorkspaceIDESharedState)
    case gitStatus(WorkspaceGitStatusResult)
    case workspaceChanged(WorkspaceChangedPush)
}

public enum WorkspaceIDEWriteOutcome: Equatable, Sendable {
    case saved(WorkspaceFileWriteResult)
    case conflict(WorkspaceFileConflict)
}

public protocol WorkspaceIDEDataSource: AnyObject, Sendable {
    func listWorkspaces() async throws -> [WorkspaceSummary]
    func listDirectory(workspaceID: String, path: String) async throws -> [WorkspaceDirectoryEntry]
    func readFile(workspaceID: String, path: String) async throws -> WorkspaceFileReadResult
    func writeFile(
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) async throws -> WorkspaceIDEWriteOutcome
    func subscribe(workspaceID: String) async throws -> WorkspaceIDESharedState
    func unsubscribe(workspaceID: String) async
    func apply(
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async throws -> WorkspaceIDESharedState
    func gitStatus(workspaceID: String) async throws -> WorkspaceGitStatusResult
    func events() async -> AsyncStream<WorkspaceIDEDataEvent>
}

public enum WorkspaceIDEPlatformIntent: Equatable, Sendable {
    case addWorkspace
    case removeWorkspace(id: String)
    case reorderWorkspaces(ids: [String])
    case assignDesktop(id: String)
    case setAutoAssignDesktop(id: String, enabled: Bool)
    case setSidebarVisible(Bool)
    case setTerminalVisible(Bool)
    case setZoomScale(Double)
}

@MainActor
public protocol WorkspaceIDEDelegate: AnyObject {
    func workspaceIDEController(_ controller: WorkspaceIDEController, didSelectWorkspace id: String?)
    func workspaceIDEController(_ controller: WorkspaceIDEController, handle intent: WorkspaceIDEPlatformIntent)
}

public extension WorkspaceIDEDelegate {
    func workspaceIDEController(_ controller: WorkspaceIDEController, didSelectWorkspace id: String?) {}
    func workspaceIDEController(_ controller: WorkspaceIDEController, handle intent: WorkspaceIDEPlatformIntent) {}
}
