import Foundation

/// Decides whether a file's bytes are previewable text, the same way git / grep / ripgrep /
/// VS Code do: a NUL byte (`0x00`) in the leading chunk means binary. Text files effectively
/// never contain a NUL; most binaries hit one almost immediately. This replaces an
/// extension allowlist — the viewer reads any file and lets content, not the name, decide.
///
/// Pure and tiny: the scan is the whole of it, so it unit-tests directly. The actual read +
/// UTF-8 decode stay in `FileViewer` (the boundary that already does I/O); a binary or
/// non-UTF-8 file there becomes the loud "unsupported" panel, never garbage rendered as text.
public enum TextProbe {
    /// `true` when `data` looks binary: a NUL byte appears within the first `scanLimit` bytes.
    /// Scanning a leading window (not the whole file) keeps it cheap on large files and matches
    /// the standard editor heuristic. Empty data is text.
    public static func isProbablyBinary(_ data: Data, scanLimit: Int = 8192) -> Bool {
        data.prefix(scanLimit).contains(0)
    }
}
