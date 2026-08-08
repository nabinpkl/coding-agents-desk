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
// One window the phone can point its video stream at.
//
// `spaceId` joins against DesktopState.spaces, which already carries each Space's
// ordinal, so the Desktop number is derived on the client rather than duplicated here.
// It is optional because SkyLight declines to place a small number of windows (system
// overlays, mostly); those still stream fine, they just get no Desktop badge.
//
// The icon is referenced by hash, not carried inline: icons are per-app, so ten windows
// of one editor cost one image. `WindowListPush.icons` carries the bytes.
public struct WindowSummary: Codable, Equatable, Sendable {
    public let id: UInt32
    public let spaceId: UInt64?
    public let appName: String
    public let title: String
    public let iconHash: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case id = "i"
        case spaceId = "s"
        case appName = "a"
        case title = "ti"
        case iconHash = "ih"
    }

    public init(id: UInt32, spaceId: UInt64?, appName: String, title: String, iconHash: String) {
        self.id = id
        self.spaceId = spaceId
        self.appName = appName
        self.title = title
        self.iconHash = iconHash
    }
}

// App icon bytes for a `WindowSummary.iconHash`. Base64 PNG, matching CursorImagePush.
// The host sends an entry only when it has not already sent that hash to this client, so
// a steady-state push carries no image bytes at all.
public struct WindowAppIcon: Codable, Equatable, Sendable {
    public let hash: String
    public let png: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case hash = "h"
        case png = "p"
    }

    public init(hash: String, png: String) {
        self.hash = hash
        self.png = png
    }
}

// Host -> client window picker contents.
//
// Deliberately its own push rather than a field on ThumbnailsPush: thumbnails are gated on
// `thumbnailsEnabled`, and a user who turned previews off to save CPU has not asked for an
// empty picker. This push is capture-free (window enumeration plus a SkyLight Space lookup),
// so it does not carry the cost that made previews worth turning off.
public struct WindowListPush: Codable, Equatable, Sendable {
    public let type: String
    public let windows: [WindowSummary]
    public let icons: [WindowAppIcon]

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case windows = "w"
        case icons = "ic"
    }

    public init(windows: [WindowSummary], icons: [WindowAppIcon] = []) {
        self.type = "window-list"
        self.windows = windows
        self.icons = icons
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "window-list"
        windows = try container.decode([WindowSummary].self, forKey: .windows)
        icons = try container.decodeIfPresent([WindowAppIcon].self, forKey: .icons) ?? []
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

public enum CursorKind: String, Codable, Equatable, Sendable {
    case arrow
    case ibeam
    case pointingHand
    case resize
    case unknown
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
    public let cursorKind: CursorKind

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case hash = "h"
        case png = "p"
        case hotspotXFrac = "hx"
        case hotspotYFrac = "hy"
        case widthPoints = "iw"
        case heightPoints = "ih"
        case hidden = "hd"
        case cursorKind = "k"
    }

    public init(
        hash: String,
        png: String?,
        hotspotXFrac: Float,
        hotspotYFrac: Float,
        widthPoints: Float,
        heightPoints: Float,
        hidden: Bool,
        cursorKind: CursorKind
    ) {
        self.type = "cursor"
        self.hash = hash
        self.png = png
        self.hotspotXFrac = hotspotXFrac
        self.hotspotYFrac = hotspotYFrac
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.hidden = hidden
        self.cursorKind = cursorKind
    }
}

public enum HostTextInputFocusSource: String, Codable, Equatable, Sendable {
    case accessibility
    case cursorTapHeuristic
    case none
}

public enum HostTextInputEditability: String, Codable, Equatable, Sendable {
    case editable
    case nonEditable
    case ambiguous
}

// Host -> client text-input intent. Carries only metadata required for the
// client to decide whether to show its keyboard. It never carries selected text,
// field values, or password contents.
public struct HostTextInputFocusPush: Codable, Equatable, Sendable {
    public let type: String
    public let editability: HostTextInputEditability
    public let secure: Bool
    public let source: HostTextInputFocusSource
    public let role: String?
    public let subrole: String?
    public let cursorKind: CursorKind?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case editability = "e"
        case secure = "s"
        case source = "src"
        case role = "r"
        case subrole = "sr"
        case cursorKind = "k"
    }

    public init(
        editability: HostTextInputEditability,
        secure: Bool,
        source: HostTextInputFocusSource,
        role: String? = nil,
        subrole: String? = nil,
        cursorKind: CursorKind? = nil
    ) {
        self.type = "text-input-focus"
        self.editability = editability
        self.secure = secure
        self.source = source
        self.role = role
        self.subrole = subrole
        self.cursorKind = cursorKind
    }

    public var isEditable: Bool {
        editability == .editable
    }
}

// Host -> client acknowledgement emitted only after the host posts one
// revisioned iPhone cursor input. An acknowledgement older than the client's
// latest prediction advances applied progress but must not rewind the visible
// client cursor.
public struct CursorAppliedPush: Codable, Equatable, Sendable {
    public let type: String
    public let cursorRevision: UInt64
    public let displayId: String?
    public let cursorX: Float
    public let cursorY: Float

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case cursorRevision = "cr"
        case displayId = "d"
        case cursorX = "x"
        case cursorY = "y"
    }

    public init(cursorRevision: UInt64, displayId: String?, cursorX: Float, cursorY: Float) {
        self.type = "cursor-applied"
        self.cursorRevision = cursorRevision
        self.displayId = displayId
        self.cursorX = cursorX
        self.cursorY = cursorY
    }
}

// Host -> client movement observed outside the remote-input dispatcher. The
// host includes the last cursor revision it applied for this specific client,
// letting the client rebase on the Mac position and replay only newer pending
// operations.
public struct HostCursorMovedPush: Codable, Equatable, Sendable {
    public let type: String
    public let afterCursorRevision: UInt64?
    public let displayId: String?
    public let cursorX: Float
    public let cursorY: Float

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case afterCursorRevision = "ar"
        case displayId = "d"
        case cursorX = "x"
        case cursorY = "y"
    }

    public init(
        afterCursorRevision: UInt64?,
        displayId: String?,
        cursorX: Float,
        cursorY: Float
    ) {
        self.type = "host-cursor-moved"
        self.afterCursorRevision = afterCursorRevision
        self.displayId = displayId
        self.cursorX = cursorX
        self.cursorY = cursorY
    }
}

public enum HostAvailability: String, Codable, Equatable, Sendable {
    case active
    case locked
    case captureUnavailable
    case disconnected
}

public struct HostAvailabilityPush: Codable, Equatable, Sendable {
    public let type: String
    public let availability: HostAvailability
    public let reason: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case availability = "a"
        case reason = "r"
    }

    public init(availability: HostAvailability, reason: String? = nil) {
        self.type = "host-availability"
        self.availability = availability
        self.reason = reason
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

// Pixel size of the area the client is actually drawing host video into -- not the phone's
// screen, which is bigger, because the trackpad takes the rest of it.
//
// Sent so the host can size a watched window to exactly this, which is what makes remote text
// readable: matching pixels means the frame is neither upscaled (which blurs small glyphs,
// and HEVC at a pinned bitrate makes that worse) nor downscaled (which shrinks them). It is
// the largest text achievable with no resampling anywhere in the chain.
//
// Pixels rather than points because the whole point is to land one captured pixel on one
// phone pixel, and the two devices have different scale factors.
public struct ClientVideoViewport: Codable, Equatable, Sendable {
    public let widthPixels: UInt32
    public let heightPixels: UInt32

    public enum CodingKeys: String, CodingKey, Sendable {
        case widthPixels = "w"
        case heightPixels = "h"
    }

    public init(widthPixels: UInt32, heightPixels: UInt32) {
        self.widthPixels = widthPixels
        self.heightPixels = heightPixels
    }
}

public struct ClientConfig: Codable, Equatable, Sendable {
    public let type: String
    public let thumbnailsEnabled: Bool
    public let thumbnailRefresh: UInt64?
    public let selectedDisplayId: String?
    // Watch one window instead of the whole display. nil = display capture (the default);
    // non-nil is a CGWindowID the host streams through a desktop-independent window filter,
    // which costs roughly a quarter of a display's bitrate and works while the window sits
    // on another Space.
    //
    // Additive to selectedDisplayId rather than replacing it: the display still owns the
    // input coordinate space, DesktopState, and thumbnail refresh. Selecting a window makes
    // the host switch to that window's Desktop and raise it, so its pixels are live and the
    // trackpad, scroll strip, and keyboard all drive it.
    public let selectedWindowId: UInt32?
    // Pixel size of the client's video viewport, sent so the host can size a watched window
    // to it. nil means the client is not asking for a fit and the host leaves the window's
    // geometry alone.
    public let videoViewport: ClientVideoViewport?
    // Whether this client wants WindowListPush. Its own flag rather than a ride-along on
    // thumbnailsEnabled: the window list is capture-free, so a user who turned previews off
    // for CPU should still get a populated picker.
    public let windowListEnabled: Bool
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
    // Client's preference for host-side text focus probing after remote clicks. Default
    // true preserves the automatic keyboard-open behavior for peers that predate this
    // setting; false lets the host skip cursor/AX probes for this client.
    public let autoKeyboardEnabled: Bool
    // The client-side privacy decision for paired-host screenshot requests.
    // This advertises capability only; the client re-checks the setting at
    // capture time and remains authoritative.
    public let diagnosticScreenshotsEnabled: Bool

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case thumbnailsEnabled = "te"
        case thumbnailRefresh = "tr"
        case selectedDisplayId = "sd"
        case selectedWindowId = "sw"
        case videoViewport = "vp"
        case windowListEnabled = "wl"
        case crispTextOverlayEnabled = "ce"
        case showHostCursorInVideo = "hc"
        case mediaQuality = "mq"
        case autoKeyboardEnabled = "ak"
        case diagnosticScreenshotsEnabled = "ds"
    }

    public init(
        thumbnailsEnabled: Bool,
        thumbnailRefresh: UInt64? = nil,
        selectedDisplayId: String? = nil,
        selectedWindowId: UInt32? = nil,
        videoViewport: ClientVideoViewport? = nil,
        windowListEnabled: Bool = false,
        crispTextOverlayEnabled: Bool? = nil,
        showHostCursorInVideo: Bool? = nil,
        mediaQuality: ClientMediaQualityConfig? = nil,
        autoKeyboardEnabled: Bool = true,
        diagnosticScreenshotsEnabled: Bool = false
    ) {
        self.type = "client-config"
        self.thumbnailsEnabled = thumbnailsEnabled
        self.thumbnailRefresh = thumbnailRefresh
        self.selectedDisplayId = selectedDisplayId
        self.selectedWindowId = selectedWindowId
        self.videoViewport = videoViewport
        self.windowListEnabled = windowListEnabled
        self.crispTextOverlayEnabled = crispTextOverlayEnabled
        self.showHostCursorInVideo = showHostCursorInVideo
        self.mediaQuality = mediaQuality
        self.autoKeyboardEnabled = autoKeyboardEnabled
        self.diagnosticScreenshotsEnabled = diagnosticScreenshotsEnabled
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "client-config"
        thumbnailsEnabled = try container.decode(Bool.self, forKey: .thumbnailsEnabled)
        thumbnailRefresh = try container.decodeIfPresent(UInt64.self, forKey: .thumbnailRefresh)
        selectedDisplayId = try container.decodeIfPresent(String.self, forKey: .selectedDisplayId)
        selectedWindowId = try container.decodeIfPresent(UInt32.self, forKey: .selectedWindowId)
        videoViewport = try container.decodeIfPresent(ClientVideoViewport.self, forKey: .videoViewport)
        windowListEnabled = try container.decodeIfPresent(Bool.self, forKey: .windowListEnabled) ?? false
        crispTextOverlayEnabled = try container.decodeIfPresent(Bool.self, forKey: .crispTextOverlayEnabled)
        showHostCursorInVideo = try container.decodeIfPresent(Bool.self, forKey: .showHostCursorInVideo)
        mediaQuality = try container.decodeIfPresent(ClientMediaQualityConfig.self, forKey: .mediaQuality)
        autoKeyboardEnabled = try container.decodeIfPresent(Bool.self, forKey: .autoKeyboardEnabled) ?? true
        diagnosticScreenshotsEnabled = try container.decodeIfPresent(Bool.self, forKey: .diagnosticScreenshotsEnabled) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(thumbnailsEnabled, forKey: .thumbnailsEnabled)
        try container.encodeIfPresent(thumbnailRefresh, forKey: .thumbnailRefresh)
        try container.encodeIfPresent(selectedDisplayId, forKey: .selectedDisplayId)
        try container.encodeIfPresent(selectedWindowId, forKey: .selectedWindowId)
        try container.encodeIfPresent(videoViewport, forKey: .videoViewport)
        try container.encode(windowListEnabled, forKey: .windowListEnabled)
        try container.encodeIfPresent(crispTextOverlayEnabled, forKey: .crispTextOverlayEnabled)
        try container.encodeIfPresent(showHostCursorInVideo, forKey: .showHostCursorInVideo)
        try container.encodeIfPresent(mediaQuality, forKey: .mediaQuality)
        try container.encode(autoKeyboardEnabled, forKey: .autoKeyboardEnabled)
        try container.encode(diagnosticScreenshotsEnabled, forKey: .diagnosticScreenshotsEnabled)
    }
}

/// Whether the client is currently looking at the host's video.
///
/// The client's full-screen surfaces (Terminal, Agent, Workspace, IDE, Browser)
/// cover the video entirely, so every frame encoded and sent while one of them
/// is open is spent on pixels nobody sees. That is the whole downlink budget on
/// a slow link, and the encode cost on the Mac. Unlike ClientConfig this is a
/// runtime fact rather than a setting, so it gets its own message and is sent on
/// every surface change.
public struct MediaViewerState: Codable, Equatable, Sendable {
    public let type: String
    public let isWatchingVideo: Bool

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case isWatchingVideo = "w"
    }

    public init(isWatchingVideo: Bool) {
        self.type = "media-viewer"
        self.isWatchingVideo = isWatchingVideo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "media-viewer"
        isWatchingVideo = try container.decode(Bool.self, forKey: .isWatchingVideo)
    }
}
