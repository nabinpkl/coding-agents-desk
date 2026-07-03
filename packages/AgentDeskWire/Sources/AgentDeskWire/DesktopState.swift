// DesktopState wire types (ADR-0050). Single source of truth for host and client.

import Foundation

public struct DisplayMetadata: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let isMain: Bool
    public let originX: Float
    public let originY: Float
    // ADR-0009 cursor-driven viewport pan. Display dimensions in points,
    // matching CGDisplayBounds / what InputDispatcher clamps cursor
    // positions against. The client uses these to clamp its predicted
    // cursor model and to map source-display coords into the iPhone's
    // sinkView for edge-follow viewport math.
    public let widthPoints: Float
    public let heightPoints: Float

    public enum CodingKeys: String, CodingKey, Sendable {
        case id = "i"
        case label = "l"
        case isMain = "m"
        case originX = "x"
        case originY = "y"
        case widthPoints = "w"
        case heightPoints = "h"
    }

    public init(
        id: String,
        label: String = "",
        isMain: Bool = false,
        originX: Float = 0,
        originY: Float = 0,
        widthPoints: Float,
        heightPoints: Float
    ) {
        self.id = id
        self.label = label
        self.isMain = isMain
        self.originX = originX
        self.originY = originY
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? ""
        isMain = try container.decodeIfPresent(Bool.self, forKey: .isMain) ?? false
        originX = try container.decodeIfPresent(Float.self, forKey: .originX) ?? 0
        originY = try container.decodeIfPresent(Float.self, forKey: .originY) ?? 0
        widthPoints = try container.decode(Float.self, forKey: .widthPoints)
        heightPoints = try container.decode(Float.self, forKey: .heightPoints)
    }
}
public struct SpaceMetadata: Codable, Equatable, Sendable {
    public let id: UInt64
    public let displayId: String
    public let index: Int?
    public let type: Int

    public enum CodingKeys: String, CodingKey, Sendable {
        case id = "i"
        case displayId = "d"
        case index = "x"
        case type = "t"
    }

    public init(id: UInt64, displayId: String, index: Int? = nil, type: Int) {
        self.id = id
        self.displayId = displayId
        self.index = index
        self.type = type
    }
}
public struct DesktopState: Codable, Equatable, Sendable {
    public let displays: [DisplayMetadata]
    public let spaces: [SpaceMetadata]
    public let activeDisplayId: String?
    public let selectedDisplayId: String?
    public let activeSpaceId: UInt64?
    // ADR-0009: current Mac cursor position in logical display points at
    // the moment the push was built. Nil when unavailable. The client
    // uses this to seed cursorSourcePos on connect and display change,
    // eliminating the systematic drift that occurs when the real cursor
    // is not at display center.
    public let cursorX: Float?
    public let cursorY: Float?

    public enum CodingKeys: String, CodingKey, Sendable {
        case displays = "d"
        case spaces = "s"
        case activeDisplayId = "ad"
        case selectedDisplayId = "sd"
        case activeSpaceId = "as"
        case cursorX = "cx"
        case cursorY = "cy"
    }

    // Convenience init that keeps cursor fields optional so call sites
    // that don't supply them (tests, older callers) don't need updating.
    public init(
        displays: [DisplayMetadata],
        spaces: [SpaceMetadata],
        activeDisplayId: String?,
        selectedDisplayId: String? = nil,
        activeSpaceId: UInt64?,
        cursorX: Float? = nil,
        cursorY: Float? = nil
    ) {
        self.displays = displays
        self.spaces = spaces
        self.activeDisplayId = activeDisplayId
        self.selectedDisplayId = selectedDisplayId
        self.activeSpaceId = activeSpaceId
        self.cursorX = cursorX
        self.cursorY = cursorY
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        displays = try container.decode([DisplayMetadata].self, forKey: .displays)
        spaces = try container.decode([SpaceMetadata].self, forKey: .spaces)
        activeDisplayId = try container.decodeIfPresent(String.self, forKey: .activeDisplayId)
        selectedDisplayId = try container.decodeIfPresent(String.self, forKey: .selectedDisplayId)
        activeSpaceId = try container.decodeIfPresent(UInt64.self, forKey: .activeSpaceId)
        cursorX = try container.decodeIfPresent(Float.self, forKey: .cursorX)
        cursorY = try container.decodeIfPresent(Float.self, forKey: .cursorY)
    }
}
public struct DesktopStatePush: Codable, Equatable, Sendable {
    public let type: String
    public let state: DesktopState

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case state = "s"
    }

    public init(state: DesktopState) {
        self.type = "desktop-state"
        self.state = state
    }
}
