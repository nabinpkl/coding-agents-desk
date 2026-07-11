import Foundation

/// Writes edited file content back to disk for the in-shell viewer's autosave. Tiny on
/// purpose, but it is the one path that mutates user files, so it is a named, tested seam and
/// it **fails loud**: a write that cannot complete throws, never silently drops the edit (the
/// viewer then re-marks the tab dirty and shows the error).
public struct FileWriter {
    public enum Failure: Error {
        case notWritable(path: String, underlying: Error)
    }

    public init() {}

    /// Write `text` as UTF-8 to `url`, atomically (a temp file swapped into place, so a crash
    /// mid-write never leaves a half-written file). Throws `Failure.notWritable` on any error.
    public func write(_ text: String, to url: URL) throws {
        do {
            try text.write(to: url, atomically: true, encoding: .utf8)
        } catch {
            throw Failure.notWritable(path: url.path, underlying: error)
        }
    }
}
