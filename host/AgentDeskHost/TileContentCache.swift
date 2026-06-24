import Foundation

// Host model of the content the client holds in its slot cache, the RDP bitmap
// cache analog. Keyed by a 64-bit content hash; every hit is verified by a byte
// compare so a hash collision can never reference the wrong pixels. The host
// owns slot assignment (LRU); reassigning a slot overwrites it on both sides, so
// eviction needs no separate message. Updates are staged and applied only on
// commit, riding the engine's send-success surface commit.
struct TileContentCache {
    private let slotCount: Int
    private var byHash: [UInt64: UInt16] = [:]
    private var slotBytes: [UInt16: Data] = [:]
    private var slotHash: [UInt16: UInt64] = [:]
    private var order: [UInt16] = []   // committed slots, front = least recently used
    private struct Pending { let slot: UInt16; let hash: UInt64; let bytes: Data }
    private var pending: [Pending] = []

    init(slotCount: Int) { self.slotCount = max(1, slotCount) }

    static func hash(_ bytes: Data) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        bytes.withUnsafeBytes { raw in
            for byte in raw { h = (h ^ UInt64(byte)) &* 0x00000100000001B3 }
        }
        return h
    }

    func lookup(hash: UInt64, bytes: Data) -> UInt16? {
        guard let slot = byHash[hash], slotBytes[slot] == bytes else { return nil }
        return slot
    }

    mutating func assign(hash: UInt64, bytes: Data) -> UInt16 {
        let slot = chooseSlot()
        pending.append(Pending(slot: slot, hash: hash, bytes: bytes))
        return slot
    }

    mutating func commitPending() {
        for entry in pending {
            if let oldHash = slotHash[entry.slot] { byHash[oldHash] = nil }
            byHash[entry.hash] = entry.slot
            slotBytes[entry.slot] = entry.bytes
            slotHash[entry.slot] = entry.hash
            order.removeAll { $0 == entry.slot }
            order.append(entry.slot)
        }
        pending.removeAll()
    }

    mutating func discardPending() { pending.removeAll() }

    mutating func reset() {
        byHash.removeAll(); slotBytes.removeAll(); slotHash.removeAll()
        order.removeAll(); pending.removeAll()
    }

    // Pick a slot not already used this frame: a free integer if the cache is not
    // full, else the least-recently-used committed slot that is not staged.
    private func chooseSlot() -> UInt16 {
        let staged = Set(pending.map { $0.slot })
        if slotBytes.count + pending.count < slotCount {
            var candidate: UInt16 = 0
            while candidate < UInt16(slotCount) {
                if slotBytes[candidate] == nil && !staged.contains(candidate) { return candidate }
                candidate += 1
            }
        }
        for slot in order where !staged.contains(slot) { return slot }
        return 0
    }
}
