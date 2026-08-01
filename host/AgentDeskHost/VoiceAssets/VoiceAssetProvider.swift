import CryptoKit
import Foundation
import AgentDeskWire

/// Serves the voice model files out of a directory on the Mac.
///
/// The phone used to carry these in its app bundle, which meant every install
/// re-sent ~220MB that had not changed. They live here now and the phone fetches
/// them once.
///
/// Two things this deliberately does not do. It does not archive anything: the
/// compiled Core ML model is a directory of five files, so they travel
/// individually and an interrupted transfer resumes per file. And it does not
/// serve an arbitrary path from a request. A fetch is answered only if the path
/// appears in the manifest this provider built by walking its own root, which
/// makes path traversal unrepresentable rather than something to filter for.
struct VoiceAssetProvider {
    enum ProviderError: Error, Equatable {
        /// The requested path is not one this provider published.
        case unknownAsset(String)
        case unreadable(String)
    }

    /// Absent on a Mac that has never generated the models. That is a host with
    /// nothing to offer, not a broken one, so it is a real state rather than a
    /// path that happens not to exist.
    private let root: URL?
    private let fileManager: FileManager

    init(root: URL?, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    /// Every file under the root, with the hash the phone uses to decide whether
    /// its cached copy is still current.
    ///
    /// An absent root yields an empty manifest rather than an error: a host that
    /// has never generated the models is a host with nothing to offer, not a
    /// broken one, and the phone reports that plainly.
    func manifest() throws -> VoiceAssetManifest {
        guard let root, fileManager.fileExists(atPath: root.path) else {
            return VoiceAssetManifest(assets: [])
        }
        var descriptors: [VoiceAssetDescriptor] = []
        for url in try regularFiles() {
            let relativePath = try relativePath(for: url)
            let attributes = try fileManager.attributesOfItem(atPath: url.path)
            let byteCount = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
            descriptors.append(VoiceAssetDescriptor(
                path: relativePath,
                byteCount: byteCount,
                sha256: try hash(of: url)
            ))
        }
        // Sorted so the manifest is stable across walks; the phone diffs it.
        descriptors.sort { $0.path < $1.path }
        return VoiceAssetManifest(assets: descriptors)
    }

    /// One bounded slice of a published asset.
    ///
    /// Reads through a file handle rather than loading the file, because the
    /// largest of these is 152MB and the host has no reason to hold it in memory
    /// to hand out half a megabyte.
    func read(path: String, offset: UInt64, length: Int) throws -> (bytes: Data, isLast: Bool) {
        let url = try publishedURL(for: path)
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw ProviderError.unreadable(path)
        }
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        let bytes = try handle.read(upToCount: length) ?? Data()
        let size = (try fileManager.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?
            .uint64Value ?? 0
        return (bytes, offset + UInt64(bytes.count) >= size)
    }

    /// Resolves a requested path against what this root actually publishes.
    ///
    /// The membership check is the security boundary: a path is answerable only
    /// because the walk produced it, so `../` and absolute paths cannot name a
    /// file outside the root no matter how they are spelled.
    private func publishedURL(for path: String) throws -> URL {
        guard let root else { throw ProviderError.unknownAsset(path) }
        let candidate = root.appendingPathComponent(path).standardizedFileURL
        let publishedPaths = try regularFiles().map(\.standardizedFileURL.path)
        guard publishedPaths.contains(candidate.path) else {
            throw ProviderError.unknownAsset(path)
        }
        return candidate
    }

    private func regularFiles() throws -> [URL] {
        guard let root, let enumerator = fileManager.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        var files: [URL] = []
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isRegularFileKey])
            if values.isRegularFile == true {
                files.append(url)
            }
        }
        return files
    }

    private func relativePath(for url: URL) throws -> String {
        guard let root else { throw ProviderError.unknownAsset(url.path) }
        let rootPath = root.standardizedFileURL.path
        let filePath = url.standardizedFileURL.path
        guard filePath.hasPrefix(rootPath + "/") else {
            throw ProviderError.unknownAsset(filePath)
        }
        return String(filePath.dropFirst(rootPath.count + 1))
    }

    private func hash(of url: URL) throws -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            throw ProviderError.unreadable(url.lastPathComponent)
        }
        defer { try? handle.close() }
        var hasher = SHA256()
        // Streamed for the same reason reads are: hashing a 152MB file should
        // not cost 152MB of resident memory.
        while let chunk = try handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
