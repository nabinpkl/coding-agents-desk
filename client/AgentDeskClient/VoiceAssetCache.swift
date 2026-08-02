import Foundation
import CryptoKit
import AgentDeskWire

/// Where the voice models live on the phone now that they no longer ship inside
/// the app.
///
/// This is the pure half of the arrangement: what is already on disk, what a
/// manifest says is missing or stale, and where a file belongs. The fetching
/// half needs a live session; this needs nothing, so the decisions that matter
/// are testable without one.
///
/// It is a cache in the sense that it can be thrown away and refetched, but it
/// is deliberately not in `Caches/`: the system may evict that under disk
/// pressure, and re-downloading 220MB because the phone got tight on space is a
/// worse outcome than keeping it. It lives in Application Support, excluded from
/// iCloud backup, since it is reproducible from the Mac.
struct VoiceAssetCache {
    enum CacheError: Error, Equatable {
        /// The bytes that arrived do not match the descriptor. Truncated,
        /// corrupted, or the Mac changed the file mid-transfer; all three mean
        /// the same thing to the phone, which is: do not use this.
        case hashMismatch(path: String)
        case unsafePath(String)
    }

    let root: URL

    /// Every file operation here goes through the process-wide manager. There is
    /// no injection seam because there is nothing to inject: the cache is
    /// tested by pointing it at a temporary root, which is the real thing.
    private var fileManager: FileManager { .default }

    init(root: URL) {
        self.root = root
    }

    static func defaultRoot() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("VoiceAssets", isDirectory: true)
    }

    /// The cache the app reads from. This is the answer to the question the
    /// analyzers used to ask `Bundle.main`.
    static let shared = VoiceAssetCache(root: defaultRoot())

    /// Resolves a fetched asset by name, or nil if it is not on the phone yet.
    ///
    /// Nil is the ordinary state before the first fetch, not a failure. Each
    /// caller turns it into whatever missing-asset error its surface reports.
    func assetURL(named name: String, extension fileExtension: String) -> URL? {
        guard let url = url(for: "\(name).\(fileExtension)"),
              fileManager.fileExists(atPath: url.path)
        else { return nil }
        return url
    }

    /// The on-disk location for a published path, or nil if the path tries to
    /// escape the cache root.
    ///
    /// The manifest comes from the paired Mac, which is authenticated, but a
    /// path from off-device still decides where this writes. Refusing to resolve
    /// an escaping path keeps that decision inside the cache.
    func url(for path: String) -> URL? {
        guard !path.isEmpty else { return nil }
        let candidate = root.appendingPathComponent(path).standardizedFileURL
        let rootPath = root.standardizedFileURL.path
        guard candidate.path == rootPath || candidate.path.hasPrefix(rootPath + "/") else {
            return nil
        }
        return candidate
    }

    func isPresent(_ descriptor: VoiceAssetDescriptor) -> Bool {
        guard let url = url(for: descriptor.path),
              let size = try? fileManager.attributesOfItem(atPath: url.path)[.size] as? NSNumber
        else { return false }
        return size.uint64Value == descriptor.byteCount
    }

    /// What still has to come over the wire.
    ///
    /// Size alone decides, not the hash: hashing 220MB on every launch to learn
    /// what a size check already tells you would cost more than it saves. The
    /// hash is still verified on arrival, so a corrupted file is caught when it
    /// is written rather than every time it is read.
    func missingAssets(from manifest: VoiceAssetManifest) -> [VoiceAssetDescriptor] {
        manifest.assets.filter { !isPresent($0) }
    }

    func isComplete(for manifest: VoiceAssetManifest) -> Bool {
        !manifest.assets.isEmpty && missingAssets(from: manifest).isEmpty
    }

    /// Writes a fully received file, verifying it before it counts as cached.
    ///
    /// Written to a temporary name and moved into place, so an interrupted write
    /// leaves no half-file that a later size check would mistake for complete.
    func store(_ bytes: Data, for descriptor: VoiceAssetDescriptor) throws {
        try resetStaging(for: descriptor)
        try appendToStaging(bytes, for: descriptor)
        try promoteStaging(for: descriptor)
    }

    // MARK: - Streaming a large asset to disk

    // The largest of these is 152MB. Accumulating it in memory to hash it at the
    // end would be the one moment this feature spikes the phone's memory, so
    // chunks append straight to a staging file and the hash is computed by
    // reading that file back.

    func stagingURL(for descriptor: VoiceAssetDescriptor) -> URL? {
        url(for: descriptor.path)?.appendingPathExtension("partial")
    }

    /// How much of this asset already landed, which is where a resumed transfer
    /// asks the Mac to start. Zero if nothing is staged.
    func stagedByteCount(for descriptor: VoiceAssetDescriptor) -> UInt64 {
        guard let staging = stagingURL(for: descriptor),
              let size = try? fileManager.attributesOfItem(atPath: staging.path)[.size] as? NSNumber
        else { return 0 }
        return size.uint64Value
    }

    func resetStaging(for descriptor: VoiceAssetDescriptor) throws {
        guard let staging = stagingURL(for: descriptor) else {
            throw CacheError.unsafePath(descriptor.path)
        }
        try? fileManager.removeItem(at: staging)
    }

    func appendToStaging(_ bytes: Data, for descriptor: VoiceAssetDescriptor) throws {
        guard let staging = stagingURL(for: descriptor) else {
            throw CacheError.unsafePath(descriptor.path)
        }
        try fileManager.createDirectory(
            at: staging.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !fileManager.fileExists(atPath: staging.path) {
            fileManager.createFile(atPath: staging.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: staging)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: bytes)
    }

    /// Verifies the staged file and moves it into place. Only here does an asset
    /// become cached, so a transfer that dies midway leaves a `.partial` that
    /// resumes rather than a file that looks complete.
    func promoteStaging(for descriptor: VoiceAssetDescriptor) throws {
        guard let destination = url(for: descriptor.path),
              let staging = stagingURL(for: descriptor)
        else { throw CacheError.unsafePath(descriptor.path) }
        guard try stagedDigest(at: staging) == descriptor.sha256 else {
            try? fileManager.removeItem(at: staging)
            throw CacheError.hashMismatch(path: descriptor.path)
        }
        try? fileManager.removeItem(at: destination)
        try fileManager.moveItem(at: staging, to: destination)
        try excludeFromBackup()
    }

    private func stagedDigest(at url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// These are reproducible from the Mac, so backing up 220MB of them to
    /// iCloud would be paying for something already stored elsewhere.
    private func excludeFromBackup() throws {
        guard fileManager.fileExists(atPath: root.path) else { return }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var url = root
        try url.setResourceValues(values)
    }
}
