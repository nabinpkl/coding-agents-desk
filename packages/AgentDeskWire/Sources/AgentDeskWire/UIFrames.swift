// UIFrames wire types (ADR-0050). Single source of truth for host and client.

import Foundation

// Per-Space dominant-window metadata. Captured by SpaceThumbnailProvider
// on the same cadence as the JPEGs and shipped alongside them so both
// the macOS host and iOS client can label a tile with the actual app /
// project (e.g. "agent-desk", "Slack") instead of "Desktop N".
public struct SpaceTopWindow: Codable, Equatable, Sendable {
    public let title: String
    public let appName: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case title = "t"
        case appName = "a"
    }

    public init(title: String, appName: String? = nil) {
        self.title = title
        self.appName = appName
    }
}
public struct ThumbnailsPush: Codable, Equatable, Sendable {
    public let type: String
    public let thumbnails: [String: String]
    public let topWindows: [String: SpaceTopWindow]?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case thumbnails = "tn"
        case topWindows = "tw"
    }

    public init(thumbnails: [String: String], topWindows: [String: SpaceTopWindow]? = nil) {
        self.type = "thumbnails-push"
        self.thumbnails = thumbnails
        self.topWindows = topWindows
    }
}
public struct AgentSayPush: Codable, Equatable, Sendable {
    public let type: String
    public let id: String
    public let phase: String
    public let sequence: Int?
    public let text: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case id
        case phase = "p"
        case sequence = "q"
        case text = "x"
    }

    public init(id: String, phase: String, sequence: Int? = nil, text: String? = nil) {
        self.type = "agent-say"
        self.id = id
        self.phase = phase
        self.sequence = sequence
        self.text = text
    }
}
// Host -> client cursor-image mirror. Pushed on the session input stream whenever
// NSCursor.currentSystem changes shape (arrow, I-beam, pointing-hand,
// resize, busy, custom app cursors), plus once on attach. The client
// caches the PNG by `hash` and renders it at the locally predicted
// position, so the glyph identity is host-driven while position stays
// zero-latency. `png` is the base64 PNG; it may be nil in a later phase
// once the client is known to already hold `hash`. `hotspotXFrac` /
// `hotspotYFrac` are the cursor hotspot as a fraction of the image
// (top-left origin) so the client can anchor any cursor, not just the
// tip-at-origin arrow.
public struct CursorImagePush: Codable, Equatable, Sendable {
    public let type: String
    public let hash: String
    public let png: String?
    public let hotspotXFrac: Float
    public let hotspotYFrac: Float
    public let widthPoints: Float
    public let heightPoints: Float
    public let hidden: Bool

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case hash = "h"
        case png = "p"
        case hotspotXFrac = "hx"
        case hotspotYFrac = "hy"
        case widthPoints = "iw"
        case heightPoints = "ih"
        case hidden = "hd"
    }

    public init(
        hash: String,
        png: String?,
        hotspotXFrac: Float,
        hotspotYFrac: Float,
        widthPoints: Float,
        heightPoints: Float,
        hidden: Bool
    ) {
        self.type = "cursor"
        self.hash = hash
        self.png = png
        self.hotspotXFrac = hotspotXFrac
        self.hotspotYFrac = hotspotYFrac
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.hidden = hidden
    }
}
// Host -> client cursor-position correction. This is not sent for every
// iPhone-driven cursor delta. It is a low-rate authoritative reseed when the
// Mac-side system cursor moves outside the remote input stream, so the
// client's local cursor overlay and edge-follow model do not drift after a
// physical mouse or trackpad move on the host.
public struct CursorPositionPush: Codable, Equatable, Sendable {
    public let type: String
    public let displayId: String?
    public let cursorX: Float
    public let cursorY: Float

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case displayId = "d"
        case cursorX = "x"
        case cursorY = "y"
    }

    public init(displayId: String?, cursorX: Float, cursorY: Float) {
        self.type = "cursor-position"
        self.displayId = displayId
        self.cursorX = cursorX
        self.cursorY = cursorY
    }
}
public struct ClientMediaQualityTarget: Codable, Equatable, Sendable {
    public let bitrateKbps: Int
    public let fps: Int
    public let resolutionScale: Double

    public enum CodingKeys: String, CodingKey, Sendable {
        case bitrateKbps = "bk"
        case fps = "fps"
        case resolutionScale = "rs"
    }

    public init(bitrateKbps: Int, fps: Int, resolutionScale: Double) {
        self.bitrateKbps = bitrateKbps
        self.fps = fps
        self.resolutionScale = resolutionScale
    }
}

public struct ClientMediaQualityConfig: Codable, Equatable, Sendable {
    public let adaptiveEnabled: Bool
    public let fixedTarget: ClientMediaQualityTarget?

    public enum CodingKeys: String, CodingKey, Sendable {
        case adaptiveEnabled = "a"
        case fixedTarget = "ft"
    }

    public init(adaptiveEnabled: Bool, fixedTarget: ClientMediaQualityTarget? = nil) {
        self.adaptiveEnabled = adaptiveEnabled
        self.fixedTarget = fixedTarget
    }
}

public struct ClientConfig: Codable, Equatable, Sendable {
    public let type: String
    public let thumbnailsEnabled: Bool
    public let thumbnailRefresh: UInt64?
    public let selectedDisplayId: String?
    // Client's preference for the crisp text overlay. Optional tri-state: nil means the
    // client expressed no opinion (host falls back to its Config.ownedMediaCrispEnabled
    // default); true/false is an explicit request. The host composes it with its own gate
    // as an AND, so the host env stays the hard kill switch and the client chooses within it.
    public let crispTextOverlayEnabled: Bool?
    // Client's preference for compositing the OS cursor into the captured video. Optional
    // tri-state: nil = no opinion (host keeps its default, off). Default off because the
    // client draws its own sharp low-latency cursor overlay, so baking it into the video is
    // a redundant double-draw.
    public let showHostCursorInVideo: Bool?
    // Client's control over host-owned media quality. Optional for the same reason as the
    // other client preferences: nil = no opinion, so the host keeps adaptive quality on at
    // the native target. When adaptive is off, fixedTarget pins bitrate/FPS/resolution.
    public let mediaQuality: ClientMediaQualityConfig?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case thumbnailsEnabled = "te"
        case thumbnailRefresh = "tr"
        case selectedDisplayId = "sd"
        case crispTextOverlayEnabled = "ce"
        case showHostCursorInVideo = "hc"
        case mediaQuality = "mq"
    }

    public init(
        thumbnailsEnabled: Bool,
        thumbnailRefresh: UInt64? = nil,
        selectedDisplayId: String? = nil,
        crispTextOverlayEnabled: Bool? = nil,
        showHostCursorInVideo: Bool? = nil,
        mediaQuality: ClientMediaQualityConfig? = nil
    ) {
        self.type = "client-config"
        self.thumbnailsEnabled = thumbnailsEnabled
        self.thumbnailRefresh = thumbnailRefresh
        self.selectedDisplayId = selectedDisplayId
        self.crispTextOverlayEnabled = crispTextOverlayEnabled
        self.showHostCursorInVideo = showHostCursorInVideo
        self.mediaQuality = mediaQuality
    }
}
