// DomMirror wire types (ADR-0050). Single source of truth for host and client.

import Foundation

// ADR-0038 DOM mirror wire envelope. The native-messaging shim forwards rrweb batches from
// the Chrome extension as JSON; the host decodes only this lightweight envelope (type, tab,
// checkout marker) and forwards the batch opaquely down the .dom lane -- the rrweb events
// themselves are never modeled in Swift. `checkout` marks a batch that opens a fresh snapshot
// (Meta + FullSnapshot), which DomEventLaneServer uses to reset its late-join buffer. Decode
// is tolerant of the `ev` events array (an unlisted key), which is forwarded verbatim.
public struct DomBatchEnvelope: Codable, Equatable, Sendable {
    public let type: String
    public let tabId: Int
    public let checkout: Bool
    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case tabId = "tb"
        case checkout = "co"
    }

    public init(tabId: Int, checkout: Bool) {
        self.type = "dom-batch"
        self.tabId = tabId
        self.checkout = checkout
    }
}
// ADR-0040 DOM-mirror input command. The client sends this UP the .dom lane when the user taps the
// mirror; the host decodes it (to validate the frame is an input, not something else) and forwards
// the raw JSON to the bridge, which relays it to the extension worker to dispatch as trusted input
// via chrome.debugger. x/y are page CSS-pixel coordinates already mapped by the client.
public struct DomInputCommand: Codable, Equatable, Sendable {
    public let type: String
    public let kind: String
    public let x: Double
    public let y: Double

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case kind = "k"
        case x
        case y
    }

    public init(kind: String = "mouse", x: Double, y: Double) {
        self.type = "dom-input"
        self.kind = kind
        self.x = x
        self.y = y
    }
}
// ADR-0047 DOM-mirror scroll-drive-back. The client sends this UP the .dom lane when the user drags
// the mirror; the host decodes it (to validate the frame is a scroll, not something else) and
// forwards the raw JSON to the bridge, which relays it to the extension worker to drive the REAL
// tab's scroll via chrome.debugger (Input.synthesizeScrollGesture). x/y are the page CSS-pixel
// anchor; dx/dy are the finger movement delta in page CSS px (positive dy = finger moved down), which
// the extension passes straight to Input.synthesizeScrollGesture so the content follows the finger.
// Discrete `t` tag, not overloaded onto DomInputCommand, so the host's verbatim `t`-keyed forwarding
// stays intact.
public struct DomScrollCommand: Codable, Equatable, Sendable {
    public let type: String
    public let x: Double
    public let y: Double
    public let dx: Double
    public let dy: Double

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case x
        case y
        case dx
        case dy
    }

    public init(x: Double, y: Double, dx: Double, dy: Double) {
        self.type = "dom-scroll"
        self.x = x
        self.y = y
        self.dx = dx
        self.dy = dy
    }
}
// ADR-0046 host->client DOM diagnostic status, pushed DOWN the .dom lane and rendered in the
// Browser surface's status line. `ext`: the native-messaging bridge to the Chrome extension is
// connected (extension reachable). `tab`: the recording tab id, nil when nothing is recording.
public struct DomStatus: Codable, Equatable, Sendable {
    public let type: String
    public let ext: Bool
    public let tab: Int?

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case ext
        case tab
    }

    public init(ext: Bool, tab: Int?) {
        self.type = "dom-status"
        self.ext = ext
        self.tab = tab
    }
}
