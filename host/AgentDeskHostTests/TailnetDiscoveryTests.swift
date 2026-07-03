import Foundation
import Testing

struct TailnetDiscoveryTests {
    // A representative `tailscale status --json` slice: an online iOS peer, an
    // online macOS peer, an offline peer, and a peer with no IPv4 (which must
    // be dropped because the offer is dialed at an IPv4 literal).
    private let fixture = Data("""
    {
      "Self": {
        "HostName": "mac",
        "DNSName": "mac.tailnet.ts.net.",
        "OS": "macOS",
        "TailscaleIPs": ["100.64.0.1", "fd7a:1::1"],
        "Online": true
      },
      "Peer": {
        "key-phone": {
          "HostName": "dev-iphone",
          "DNSName": "dev-iphone.tailnet.ts.net.",
          "OS": "iOS",
          "TailscaleIPs": ["100.64.0.20", "fd7a:1::20"],
          "Online": true
        },
        "key-laptop": {
          "HostName": "work-laptop",
          "DNSName": "work-laptop.tailnet.ts.net.",
          "OS": "linux",
          "TailscaleIPs": ["100.64.0.30"],
          "Online": true
        },
        "key-offline": {
          "HostName": "old-ipad",
          "OS": "iPadOS",
          "TailscaleIPs": ["100.64.0.40"],
          "Online": false
        },
        "key-no-ipv4": {
          "HostName": "ghost",
          "OS": "iOS",
          "TailscaleIPs": ["fd7a:1::99"],
          "Online": true
        }
      }
    }
    """.utf8)

    @Test func parseIdentityPrefersIPv4AndTrimsTrailingDot() throws {
        let identity = try TailscaleStatusParser.parseIdentity(fixture)
        #expect(identity.fqdn == "mac.tailnet.ts.net.")
        #expect(identity.ipv4 == "100.64.0.1")
    }

    @Test func parsePeersDropsIPv4lessPeers() throws {
        let peers = try TailscaleStatusParser.parsePeers(fixture)
        // ghost has only an IPv6 address and must not appear.
        #expect(!peers.contains { $0.hostname == "ghost" })
        #expect(peers.count == 3)
    }

    @Test func parsePeersOrdersOnlineIOSFirst() throws {
        let peers = try TailscaleStatusParser.parsePeers(fixture)
        // Online iOS phone leads, then the other online peer, offline last.
        #expect(peers.first?.hostname == "dev-iphone")
        #expect(peers.first?.isIOS == true)
        #expect(peers.first?.ipv4 == "100.64.0.20")
        #expect(peers.last?.hostname == "old-ipad")
        #expect(peers.last?.online == false)
    }

    @Test func parsePeersToleratesNoPeerKey() throws {
        let selfOnly = Data("""
        {"Self": {"DNSName": "mac.ts.net", "TailscaleIPs": ["100.64.0.1"]}}
        """.utf8)
        #expect(try TailscaleStatusParser.parsePeers(selfOnly).isEmpty)
    }

    // ADR-0049: the picker lists every online iOS candidate, not only whois
    // responders. A candidate present in readyNames is ready and carries its
    // client-reported name; one absent is listed as not-ready by its tailnet name.
    private let candidates = [
        TailnetDeviceOption(hostname: "localhost", os: "iOS", ipv4: "100.64.0.20", online: true),
        TailnetDeviceOption(hostname: "localhost", os: "iOS", ipv4: "100.64.0.21", online: true)
    ]

    @Test func rowsListAllCandidatesNotJustResponders() {
        let rows = PairablePeer.rows(candidates: candidates, readyNames: ["100.64.0.20": "Dev iPhone"])
        // Both appear even though only one answered whois.
        #expect(rows.count == 2)
        #expect(rows.contains { $0.ipv4 == "100.64.0.21" && !$0.ready })
    }

    @Test func rowsUseWhoisNameWhenReadyAndTailnetNameOtherwise() {
        let rows = PairablePeer.rows(candidates: candidates, readyNames: ["100.64.0.20": "Dev iPhone"])
        let ready = rows.first { $0.ipv4 == "100.64.0.20" }
        let notReady = rows.first { $0.ipv4 == "100.64.0.21" }
        #expect(ready?.displayName == "Dev iPhone")
        #expect(ready?.ready == true)
        #expect(notReady?.displayName == "localhost")
        #expect(notReady?.ready == false)
    }

    @Test func rowsSortReadyFirst() {
        // "localhost" (ready via whois name "Zed") would sort after "Aiden" by
        // name alone, but readiness wins: the ready row leads regardless of name.
        let rows = PairablePeer.rows(
            candidates: candidates,
            readyNames: ["100.64.0.21": "Zed"]
        )
        #expect(rows.first?.ipv4 == "100.64.0.21")
        #expect(rows.first?.ready == true)
        #expect(rows.last?.ready == false)
    }
}
