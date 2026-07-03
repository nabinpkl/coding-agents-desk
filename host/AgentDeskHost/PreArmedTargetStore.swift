import Foundation

// ADR-0049: a device the user picked in the Mac pairing picker while its
// AgentDesk app was closed. The pick is the host-side authorization, but the
// offer cannot be pushed until the phone's client is listening, so the intent is
// remembered and a readiness poll fires the offer once the app comes up.
//
// Persisted (like the paired-devices store) so a host restart mid-wait does not
// silently drop the intent. Keyed by the tailnet IPv4, which is stable per node
// and is also the address the readiness poll and the eventual offer push dial.
// `expiresAt` bounds the wait so a phone that never opens does not poll forever.
struct PreArmedTarget: Codable, Equatable {
    let ipv4: String
    let name: String
    let armedAt: Int
    let expiresAt: Int
}

extension PreArmedTarget {
    // Newest pick for an IPv4 wins: drop any prior entry for the same address
    // before appending, so a re-pick replaces rather than duplicates.
    static func upsert(into targets: [PreArmedTarget], target: PreArmedTarget) -> [PreArmedTarget] {
        targets.filter { $0.ipv4 != target.ipv4 } + [target]
    }

    // Drop entries whose TTL has passed so the file cannot grow unbounded and an
    // expired intent cannot auto-approve.
    static func prune(_ targets: [PreArmedTarget], now: Int) -> [PreArmedTarget] {
        targets.filter { $0.expiresAt > now }
    }
}

struct PreArmedTargetStore {
    let url: URL

    init(url: URL = Config.preArmedTargetsURL) {
        self.url = url
    }

    func load() throws -> [PreArmedTarget] {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }
        return try JSONDecoder().decode([PreArmedTarget].self, from: Data(contentsOf: url))
    }

    func save(_ targets: [PreArmedTarget]) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(targets).write(to: url, options: .atomic)
    }

    // Arm one target: replace any prior entry for the same IPv4 and prune expired
    // ones in the same write, so the store stays the newest-wins live set.
    func arm(_ target: PreArmedTarget) throws {
        let next = PreArmedTarget.prune(
            PreArmedTarget.upsert(into: try load(), target: target),
            now: target.armedAt
        )
        try save(next)
    }

    func disarm(ipv4: String) throws {
        try save(try load().filter { $0.ipv4 != ipv4 })
    }

    // Live targets as of `now`, rewriting the file so expired entries are cleaned
    // on read. Used at host launch to resume polling only the intents still valid.
    func liveTargets(now: Int) throws -> [PreArmedTarget] {
        let live = PreArmedTarget.prune(try load(), now: now)
        try save(live)
        return live
    }
}
