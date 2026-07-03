import UIKit
import AgentDeskWire

// Bounded hash -> UIImage cache for mirrored host cursors. The host sends
// each distinct cursor PNG once, keyed by content hash; the client decodes
// it once and reuses it on subsequent shape changes. A later phase lets
// the host omit the PNG when the client is known to already hold the hash;
// resolve() handles that by returning the cached image for a nil payload.
final class CursorImageStore {
    private var cache: [String: UIImage] = [:]
    private var order: [String] = []
    private let limit: Int

    init(limit: Int = 32) {
        self.limit = limit
    }

    // Returns the image for this push, decoding and caching a new PNG.
    // Returns nil only when the hash is unknown and no PNG was provided.
    func resolve(_ push: CursorImagePush) -> UIImage? {
        if cache[push.hash] == nil,
           let png = push.png,
           let data = Data(base64Encoded: png),
           let image = UIImage(data: data) {
            insert(image, for: push.hash)
        }
        return cache[push.hash]
    }

    private func insert(_ image: UIImage, for hash: String) {
        cache[hash] = image
        order.append(hash)
        if order.count > limit {
            let evicted = order.removeFirst()
            cache.removeValue(forKey: evicted)
        }
    }
}
