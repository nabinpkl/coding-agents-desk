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
    // ADR-0048: the extension stamps `em` on every batch = whether the recording tab is currently
    // device-emulated (true mobile). This is the AUTHORITATIVE emulation state (the extension owns it);
    // the relay reads it here and fans it to clients in dom-status, so a host-side reset self-corrects
    // the client toggle. Decode-tolerant (nil when absent).
    public let emulated: Bool?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case tabId = "tb"
        case checkout = "co"
        case emulated = "em"
    }

    public init(tabId: Int, checkout: Bool, emulated: Bool? = nil) {
        self.type = "dom-batch"
        self.tabId = tabId
        self.checkout = checkout
        self.emulated = emulated
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
// ADR-0048 host-side mobile device emulation. The client sends this UP the .dom lane when the user
// flips the Browser status bar's Desktop|Mobile control; the host decodes it (to validate the frame is
// an emulate command) and forwards the raw JSON to the bridge, which relays it to the extension worker
// to device-emulate the recorded tab via chrome.debugger. `mobile == true` emulates, `false` restores
// desktop. Twin of the client definition; authoritative emulation state comes back on the batch echo.
public struct DomEmulateCommand: Codable, Equatable, Sendable {
    public let type: String
    public let mobile: Bool

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case mobile
    }

    public init(mobile: Bool) {
        self.type = "dom-emulate"
        self.mobile = mobile
    }
}

// ADR-0046 host->client DOM diagnostic status, pushed DOWN the .dom lane and rendered in the
// Browser surface's status line. `ext`: the native-messaging bridge to the Chrome extension is
// connected (extension reachable). `tab`: the recording tab id, nil when nothing is recording.
public struct DomStatus: Codable, Equatable, Sendable {
    public let type: String
    public let ext: Bool
    public let tab: Int?
    // ADR-0048: whether the recording tab is device-emulated (true mobile), fanned to the client so its
    // Desktop|Mobile control tracks the authoritative host state. Decode-tolerant (nil when absent).
    public let emulated: Bool?

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case ext
        case tab
        case emulated
    }

    public init(ext: Bool, tab: Int?, emulated: Bool? = nil) {
        self.type = "dom-status"
        self.ext = ext
        self.tab = tab
        self.emulated = emulated
    }
}

// ADR-0045 DOM capture pause/resume. Sent UP the .dom lane (like DomInputCommand) when the client
// switches the Browser surface out of / into view. The host forwards it verbatim to the extension,
// which stops rrweb recording while hidden (real CPU win at the capture source) and restarts it on
// resume -- rrweb emits a fresh full snapshot on record(), so the mirror repaints cleanly with no
// mid-stream desync. `on == false` pauses; `on == true` resumes.
public struct DomCaptureCommand: Codable, Equatable, Sendable {
    public let type: String
    public let on: Bool

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case on
    }

    public init(on: Bool) {
        self.type = "dom-capture"
        self.on = on
    }
}
