import Foundation

struct TailnetIdentity: Equatable {
    let fqdn: String
    let ipv4: String
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
}

struct TailscaleStatusDiscovery: TailnetDiscovering {
    func currentIdentity() throws -> TailnetIdentity {
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

        let data = output.fileHandleForReading.readDataToEndOfFile()
        let status = try JSONDecoder().decode(TailscaleStatus.self, from: data)
        guard let selfRecord = status.selfRecord else {
            throw TailscaleRequiredError.selfRecordMissing
        }
        guard let ipv4 = selfRecord.tailscaleIPs.first(where: { $0.contains(".") }) else {
            throw TailscaleRequiredError.ipv4Missing
        }
        return TailnetIdentity(fqdn: selfRecord.dnsName ?? "", ipv4: ipv4)
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

private struct TailscaleStatus: Decodable {
    let selfRecord: TailscaleSelfRecord?

    enum CodingKeys: String, CodingKey {
        case selfRecord = "Self"
    }
}

private struct TailscaleSelfRecord: Decodable {
    let dnsName: String?
    let tailscaleIPs: [String]

    enum CodingKeys: String, CodingKey {
        case dnsName = "DNSName"
        case tailscaleIPs = "TailscaleIPs"
    }
}
