import Foundation

public enum FileTabIdentity: Hashable {
    case source(URL)
    case htmlPreview(URL)

    public static func opening(_ url: URL) -> FileTabIdentity {
        let normalized = url.standardizedFileURL
        return FilePreviewKind.classify(normalized) == .html ? .htmlPreview(normalized) : .source(normalized)
    }

    public var url: URL {
        switch self {
        case .source(let url), .htmlPreview(let url):
            return url.standardizedFileURL
        }
    }

    var isHTMLPreview: Bool {
        if case .htmlPreview = self { return true }
        return false
    }

    var displayName: String {
        switch self {
        case .source(let url):
            return url.lastPathComponent
        case .htmlPreview(let url):
            return "Preview \(url.lastPathComponent)"
        }
    }

    var accessibilityKey: String {
        switch self {
        case .source(let url):
            return url.path
        case .htmlPreview(let url):
            return "preview-\(url.path)"
        }
    }
}

enum FileTabDiskState: Equatable {
    case unloaded
    case clean(savedOnce: Bool)
    case dirty
    case saving
    case saveFailed(String)
    case changedOnDisk(String)
    case deletedOnDisk(canRecreate: Bool)
}

final class FileTab {
    let identity: FileTabIdentity
    var text = ""
    var kind: FilePreviewKind? = nil
    var documentURL: URL?
    var mode: FileTabMode = .preview
    var unsupportedReason: String?
    private(set) var diskState: FileTabDiskState = .unloaded
    var saveWorkItem: DispatchWorkItem?

    init(identity: FileTabIdentity) {
        self.identity = identity
    }

    var url: URL {
        identity.url
    }

    var loaded: Bool {
        diskState != .unloaded
    }

    var dirty: Bool {
        switch diskState {
        case .dirty, .saveFailed:
            true
        case .deletedOnDisk(let canRecreate):
            canRecreate
        default:
            false
        }
    }

    var saving: Bool {
        diskState == .saving
    }

    var savedOnce: Bool {
        if case .clean(let savedOnce) = diskState { return savedOnce }
        return false
    }

    var deleted: Bool {
        if case .deletedOnDisk = diskState { return true }
        return false
    }

    var conflictText: String? {
        if case .changedOnDisk(let text) = diskState { return text }
        return nil
    }

    var saveError: String? {
        if case .saveFailed(let message) = diskState { return message }
        return nil
    }

    func markLoaded() {
        diskState = .clean(savedOnce: false)
    }

    func markDirty(_ text: String) {
        self.text = text
        diskState = .dirty
    }

    func beginSave() {
        saveWorkItem?.cancel()
        diskState = .saving
    }

    func markSaved() {
        diskState = .clean(savedOnce: true)
    }

    func markSaveFailed(_ message: String) {
        diskState = .saveFailed(message)
    }

    func markChangedOnDisk(_ text: String) {
        diskState = .changedOnDisk(text)
    }

    func markDeletedOnDisk() {
        diskState = .deletedOnDisk(canRecreate: dirty)
    }

    func keepMine() {
        diskState = .dirty
    }

    func useDisk(_ text: String) {
        self.text = text
        diskState = .clean(savedOnce: true)
    }

    func saveToRecreate() {
        diskState = .dirty
    }
}
