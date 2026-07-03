import Foundation
import Testing

struct PreArmedTargetStoreTests {
    private func target(_ ipv4: String, name: String = "iPhone", armedAt: Int = 100, ttl: Int = 60) -> PreArmedTarget {
        PreArmedTarget(ipv4: ipv4, name: name, armedAt: armedAt, expiresAt: armedAt + ttl)
    }

    @Test func upsertReplacesSameIPv4() {
        let existing = [target("100.64.0.20", name: "old")]
        let next = PreArmedTarget.upsert(into: existing, target: target("100.64.0.20", name: "new"))
        #expect(next.count == 1)
        #expect(next.first?.name == "new")
    }

    @Test func upsertKeepsOtherIPv4() {
        let existing = [target("100.64.0.20", name: "phone")]
        let next = PreArmedTarget.upsert(into: existing, target: target("100.64.0.21", name: "ipad"))
        #expect(next.count == 2)
    }

    @Test func pruneDropsExpired() {
        let targets = [
            target("100.64.0.20", armedAt: 100, ttl: 10), // expires at 110
            target("100.64.0.21", armedAt: 100, ttl: 60)  // expires at 160
        ]
        let live = PreArmedTarget.prune(targets, now: 120)
        #expect(live.count == 1)
        #expect(live.first?.ipv4 == "100.64.0.21")
    }

    @Test func armPersistsAndRoundTrips() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("prearm-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = PreArmedTargetStore(url: url)

        try store.arm(target("100.64.0.20", name: "dev-iphone"))
        let loaded = try store.load()
        #expect(loaded.count == 1)
        #expect(loaded.first?.name == "dev-iphone")
    }

    @Test func loadMissingFileIsEmpty() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("prearm-missing-\(UUID().uuidString).json")
        let store = PreArmedTargetStore(url: url)
        #expect(try store.load().isEmpty)
    }

    @Test func disarmRemovesOnlyThatIPv4() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("prearm-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = PreArmedTargetStore(url: url)

        try store.arm(target("100.64.0.20", armedAt: 100))
        try store.arm(target("100.64.0.21", armedAt: 100))
        try store.disarm(ipv4: "100.64.0.20")

        let loaded = try store.load()
        #expect(loaded.count == 1)
        #expect(loaded.first?.ipv4 == "100.64.0.21")
    }

    @Test func liveTargetsRewritesFileWithoutExpired() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("prearm-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = PreArmedTargetStore(url: url)

        // Arm one already-expired and one still-live, then read live as of now=200.
        try store.save([
            target("100.64.0.20", armedAt: 100, ttl: 10), // expires 110
            target("100.64.0.21", armedAt: 190, ttl: 60)  // expires 250
        ])
        let live = try store.liveTargets(now: 200)
        #expect(live.count == 1)
        #expect(live.first?.ipv4 == "100.64.0.21")
        // The expired entry is cleaned from disk, not just filtered in memory.
        #expect(try store.load().count == 1)
    }
}
