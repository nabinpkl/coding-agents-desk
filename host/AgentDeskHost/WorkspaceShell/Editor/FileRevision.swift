import Foundation

/// A file's on-disk identity at a moment in time: modification date + byte size. The version
/// token `OpenFileSync` compares to tell a genuine external change from our own autosave echo,
/// modeled on VS Code's mtime+size file-version check. Cheap to take (one `stat`) and to
/// compare. Not a content hash — a same-size, same-mtime edit is not distinguished, but the
/// `FolderWatch` event is what triggers the check, and that pair is what editors rely on.
public struct FileRevision: Equatable {
    public let modified: Date
    public let size: Int

    public init(modified: Date, size: Int) {
        self.modified = modified
        self.size = size
    }

    /// The current revision of the file at `url`, or `nil` when there is no readable file
    /// there. `nil` is the **absent** signal (deleted / never created) — an optional means
    /// absent, never error (Swift idiom); the caller treats it as deletion.
    public static func of(_ url: URL) -> FileRevision? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let modified = attributes[.modificationDate] as? Date,
              let size = attributes[.size] as? Int
        else { return nil }
        return FileRevision(modified: modified, size: size)
    }
}
