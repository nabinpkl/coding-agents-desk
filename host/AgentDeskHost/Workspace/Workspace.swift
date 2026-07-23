import CoreGraphics
import Foundation

public struct WorkspaceDesktopAssignment: Codable, Equatable, Sendable {
    public let spaceID: UInt64
    public let displayID: String
    public let ordinal: Int

    public init(spaceID: UInt64, displayID: String, ordinal: Int) {
        self.spaceID = spaceID
        self.displayID = displayID
        self.ordinal = ordinal
    }

    public init(_ desktop: WorkspaceDesktop) {
        self.init(spaceID: desktop.id, displayID: desktop.displayID, ordinal: desktop.ordinal)
    }

    public func matches(_ other: WorkspaceDesktopAssignment) -> Bool {
        spaceID == other.spaceID
    }
}

/// Which tenant the work-area slot shows for a workspace. AgentDesk ships the editor tenant; the
/// donor's browser/debugBrowser tenants are out of scope but the cases decode tolerantly.
public enum WorkspaceMode: String, Codable, Sendable {
    case editor
    case browser
    case debugBrowser

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        if raw == "workspaceBrowser" { self = .editor; return }
        guard let mode = WorkspaceMode(rawValue: raw) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unknown workspace mode \(raw)")
        }
        self = mode
    }
}

/// One project workspace: a root folder plus its persisted workspace state (ported from the
/// agent-workspace-ide donor and merged with AgentDesk's validated registration). `id` is stable
/// across renames. Runtime session/presentation state lives outside this value.
public struct Workspace: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var root: URL
    public var name: String
    public var lastMode: WorkspaceMode
    /// Bars pinned open reserve space (the slot shrinks beside them) instead of auto-hiding.
    public var sidebarPinned: Bool
    public var topBarPinned: Bool
    public var desktopAutoAssignEnabled: Bool
    /// User-sized editor window frame. The editor is app-owned and free-sized, not slot-snapped.
    public var editorFrame: CGRect?
    /// The macOS user Desktop this workspace owns. Nil until assigned from the sidebar.
    public var desktopAssignment: WorkspaceDesktopAssignment?

    public init(
        id: UUID = UUID(),
        root: URL,
        name: String? = nil,
        lastMode: WorkspaceMode = .editor,
        sidebarPinned: Bool = false,
        topBarPinned: Bool = false,
        desktopAutoAssignEnabled: Bool = false,
        editorFrame: CGRect? = nil,
        desktopAssignment: WorkspaceDesktopAssignment? = nil
    ) {
        self.id = id
        self.root = root
        self.name = name ?? root.lastPathComponent
        self.lastMode = lastMode
        self.sidebarPinned = sidebarPinned
        self.topBarPinned = topBarPinned
        self.desktopAutoAssignEnabled = desktopAutoAssignEnabled
        self.editorFrame = editorFrame
        self.desktopAssignment = desktopAssignment
    }

    /// Registers a root that is currently safe to browse: stricter than decoding persisted state,
    /// because a workspace can disappear after it has been saved. AgentDesk-specific validation
    /// (exists, is a directory, not a symlink).
    public static func registering(
        id: UUID = UUID(),
        root: URL,
        name: String,
        fileManager: FileManager = .default
    ) throws -> Workspace {
        let persistedRoot = try validatedRegistrationRoot(root, fileManager: fileManager)
        return Workspace(id: id, root: persistedRoot, name: name)
    }

    /// Decode tolerantly so a store written before a key existed still loads (keys default rather
    /// than failing the whole decode). Encoding stays synthesized.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        root = try Self.persistedRoot(try container.decode(URL.self, forKey: .root))
        name = try container.decode(String.self, forKey: .name)
        lastMode = try container.decodeIfPresent(WorkspaceMode.self, forKey: .lastMode) ?? .editor
        sidebarPinned = try container.decodeIfPresent(Bool.self, forKey: .sidebarPinned) ?? false
        topBarPinned = try container.decodeIfPresent(Bool.self, forKey: .topBarPinned) ?? false
        desktopAutoAssignEnabled = try container.decodeIfPresent(Bool.self, forKey: .desktopAutoAssignEnabled) ?? false
        editorFrame = try container.decodeIfPresent(CGRect.self, forKey: .editorFrame)
        desktopAssignment = try container.decodeIfPresent(WorkspaceDesktopAssignment.self, forKey: .desktopAssignment)
    }

    private static func persistedRoot(_ root: URL) throws -> URL {
        guard root.isFileURL, root.path.hasPrefix("/") else {
            throw WorkspaceStoreError.invalidWorkspaceRoot(root)
        }
        return root.standardizedFileURL
    }

    private static func validatedRegistrationRoot(_ root: URL, fileManager: FileManager) throws -> URL {
        let persistedRoot = try persistedRoot(root)
        if (try? fileManager.destinationOfSymbolicLink(atPath: persistedRoot.path)) != nil {
            throw WorkspaceStoreError.symbolicLinkWorkspaceRoot(persistedRoot)
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: persistedRoot.path, isDirectory: &isDirectory) else {
            throw WorkspaceStoreError.workspaceRootDoesNotExist(persistedRoot)
        }
        guard isDirectory.boolValue else {
            throw WorkspaceStoreError.workspaceRootIsNotDirectory(persistedRoot)
        }
        return persistedRoot
    }
}
