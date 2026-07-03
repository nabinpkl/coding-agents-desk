import Foundation

struct TailnetIdentity: Equatable {
    let fqdn: String
    let ipv4: String
}

// ADR-0019: one selectable device in the Mac-side pairing picker. Drawn from a
// tailnet peer record; `online` lets the UI dim peers that are not reachable,
// and `isIOS` lets it surface the likely target phone first.
struct TailnetDeviceOption: Equatable {
    let hostname: String
    let os: String
    let ipv4: String
    let online: Bool

    var isIOS: Bool { os.lowercased() == "ios" }
}

// ADR-0049: a row in the Mac pairing picker. Unlike TailnetDeviceOption (a raw
// tailnet peer), this is the resolved shape the picker draws. `ready` means the
// device's AgentDesk client answered the whois probe and can pair immediately;
// a not-ready row is still listed (the app is closed on the phone) so the user
// can pre-arm it. `displayName` is the whois-reported name when ready, otherwise
// the peer's tailnet name (which for iOS is often "localhost", so the row also
// shows the IPv4 to disambiguate).
struct PairablePeer: Equatable {
    let displayName: String
    let os: String
    let ipv4: String
    let ready: Bool

    // Resolve online iOS candidates into picker rows. `readyNames` maps the IPv4
    // of each candidate that answered the whois probe to its client-reported
    // name; a candidate absent from the map is listed as not-ready. Ready rows
    // sort first, then alphabetically by display name, so the phone the user can
    // pair right now leads the list.
    static func rows(
        candidates: [TailnetDeviceOption],
        readyNames: [String: String]
    ) -> [PairablePeer] {
        candidates
            .map { candidate in
                if let name = readyNames[candidate.ipv4] {
                    return PairablePeer(displayName: name, os: candidate.os, ipv4: candidate.ipv4, ready: true)
                }
                return PairablePeer(displayName: candidate.hostname, os: candidate.os, ipv4: candidate.ipv4, ready: false)
            }
            .sorted { lhs, rhs in
                if lhs.ready != rhs.ready { return lhs.ready }
                return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
            }
    }
}

enum TailscaleRequiredError: Error, LocalizedError {
    case tailscaleMissing
    case statusFailed(String)
    case selfRecordMissing
    case ipv4Missing

    var errorDescription: String? {
        switch self {
        case .tailscaleMissing:
            return "Tailscale required"
        case .statusFailed(let message):
            return message
        case .selfRecordMissing:
            return "Tailscale self record missing"
        case .ipv4Missing:
            return "Tailscale IPv4 missing"
        }
    }
}

protocol TailnetDiscovering {
    func currentIdentity() throws -> TailnetIdentity
    func peerDevices() throws -> [TailnetDeviceOption]
}

extension TailnetDiscovering {
    // Default so conformers that only care about identity (test doubles) need
    // not implement enumeration.
    func peerDevices() throws -> [TailnetDeviceOption] { [] }
}

struct TailscaleStatusDiscovery: TailnetDiscovering {
    func currentIdentity() throws -> TailnetIdentity {
        try TailscaleStatusParser.parseIdentity(runStatusJSON())
    }

    func peerDevices() throws -> [TailnetDeviceOption] {
        try TailscaleStatusParser.parsePeers(runStatusJSON())
    }

    private func runStatusJSON() throws -> Data {
        guard let tailscaleURL = executableURL(named: "tailscale") else {
            throw TailscaleRequiredError.tailscaleMissing
        }

        let process = Process()
        process.executableURL = tailscaleURL
        process.arguments = ["status", "--json"]

        let output = Pipe()
        let error = Pipe()
        process.standardOutput = output
        process.standardError = error

        try process.run()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let message = String(data: error.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "tailscale status failed"
            throw TailscaleRequiredError.statusFailed(message.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        return output.fileHandleForReading.readDataToEndOfFile()
    }

    private func executableURL(named name: String) -> URL? {
        let paths = ProcessInfo.processInfo.environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        for path in paths {
            let candidate = URL(fileURLWithPath: path).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate.path) {
                return candidate
            }
        }
        return nil
    }
}

// Pure decode of `tailscale status --json`, split out so the picker's peer
// shaping is unit-testable without running the tailscale binary.
enum TailscaleStatusParser {
    static func parseIdentity(_ data: Data) throws -> TailnetIdentity {
        let status = try JSONDecoder().decode(TailscaleStatus.self, from: data)
        guard let selfRecord = status.selfRecord else {
            throw TailscaleRequiredError.selfRecordMissing
        }
        guard let ipv4 = selfRecord.ipv4 else {
            throw TailscaleRequiredError.ipv4Missing
        }
        return TailnetIdentity(fqdn: selfRecord.dnsName ?? "", ipv4: ipv4)
    }

    static func parsePeers(_ data: Data) throws -> [TailnetDeviceOption] {
        let status = try JSONDecoder().decode(TailscaleStatus.self, from: data)
        let options = (status.peers ?? [:]).values.compactMap { peer -> TailnetDeviceOption? in
            guard let ipv4 = peer.ipv4 else { return nil }
            let name = peer.hostName ?? peer.trimmedDNSName ?? ipv4
            return TailnetDeviceOption(
                hostname: name,
                os: peer.os ?? "",
                ipv4: ipv4,
                online: peer.online ?? false
            )
        }
        // Surface the most likely target first: reachable phones, then other
        // reachable peers, then offline ones; alphabetical within each band.
        return options.sorted { lhs, rhs in
            if lhs.online != rhs.online { return lhs.online }
            if lhs.isIOS != rhs.isIOS { return lhs.isIOS }
            return lhs.hostname.localizedCaseInsensitiveCompare(rhs.hostname) == .orderedAscending
        }
    }
}

private struct TailscaleStatus: Decodable {
    let selfRecord: TailscaleNodeRecord?
    let peers: [String: TailscaleNodeRecord]?

    enum CodingKeys: String, CodingKey {
        case selfRecord = "Self"
        case peers = "Peer"
    }
}

private struct TailscaleNodeRecord: Decodable {
    let hostName: String?
    let dnsName: String?
    let os: String?
    let tailscaleIPs: [String]?
    let online: Bool?

    enum CodingKeys: String, CodingKey {
        case hostName = "HostName"
        case dnsName = "DNSName"
        case os = "OS"
        case tailscaleIPs = "TailscaleIPs"
        case online = "Online"
    }

    var ipv4: String? {
        tailscaleIPs?.first(where: { $0.contains(".") })
    }

    var trimmedDNSName: String? {
        guard let dnsName, !dnsName.isEmpty else { return nil }
        return dnsName.hasSuffix(".") ? String(dnsName.dropLast()) : dnsName
    }
}
