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
    private let fileManager: FileManager

    init(root: URL, fileManager: FileManager = .default) {
        self.root = root
        self.fileManager = fileManager
    }

    static func defaultRoot(fileManager: FileManager = .default) -> URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("VoiceAssets", isDirectory: true)
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
        guard let destination = url(for: descriptor.path) else {
            throw CacheError.unsafePath(descriptor.path)
        }
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard digest == descriptor.sha256 else {
            throw CacheError.hashMismatch(path: descriptor.path)
        }
        try fileManager.createDirectory(
            at: destination.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let staging = destination.appendingPathExtension("partial")
        try? fileManager.removeItem(at: staging)
        try bytes.write(to: staging, options: .atomic)
        try? fileManager.removeItem(at: destination)
        try fileManager.moveItem(at: staging, to: destination)
        try excludeFromBackup()
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
