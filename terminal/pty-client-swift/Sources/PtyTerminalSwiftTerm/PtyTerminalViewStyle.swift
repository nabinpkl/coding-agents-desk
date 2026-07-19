import CoreGraphics
import SwiftTerm

#if canImport(AppKit)
import AppKit

public typealias PtyTerminalPlatformColor = NSColor
public typealias PtyTerminalPlatformFont = NSFont
#elseif canImport(UIKit)
import UIKit

public typealias PtyTerminalPlatformColor = UIColor
public typealias PtyTerminalPlatformFont = UIFont
#endif

public enum PtyTerminalMetalRendering: Equatable {
    case disabled
    case enabled(bufferingMode: BufferingMode)

    public enum BufferingMode: String, Equatable {
        case perRowPersistent
        case perFrameAggregated
    }

    public static let enabledEnvironmentKey = "AGENT_WORKSPACE_TERMINAL_METAL"
    public static let bufferingEnvironmentKey = "AGENT_WORKSPACE_TERMINAL_METAL_BUFFERING"
    public static let portableEnabledEnvironmentKey = "PTY_TERMINAL_METAL"
    public static let portableBufferingEnvironmentKey = "PTY_TERMINAL_METAL_BUFFERING"

    public static func from(environment: [String: String] = ProcessInfo.processInfo.environment) -> Self {
        let enabled = environment[portableEnabledEnvironmentKey] ?? environment[enabledEnvironmentKey]
        guard isTruthy(enabled) else { return .disabled }
        let rawMode = environment[portableBufferingEnvironmentKey] ?? environment[bufferingEnvironmentKey] ?? ""
        let mode = BufferingMode(rawValue: rawMode) ?? .perRowPersistent
        return .enabled(bufferingMode: mode)
    }

    private static func isTruthy(_ value: String?) -> Bool {
        guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
            return false
        }
        return ["1", "true", "yes", "on"].contains(normalized)
    }
}

public enum PtyTerminalMetalRenderingError: Error, Equatable {
    case metalUnavailable
}

public struct PtyTerminalViewStyle {
    public var fontSize: CGFloat
    public var backgroundColor: PtyTerminalPlatformColor
    public var foregroundColor: PtyTerminalPlatformColor
    public var metalRendering: PtyTerminalMetalRendering

    public init(
        fontSize: CGFloat = 14,
        backgroundColor: PtyTerminalPlatformColor = Self.defaultBackgroundColor,
        foregroundColor: PtyTerminalPlatformColor = Self.defaultForegroundColor,
        metalRendering: PtyTerminalMetalRendering = .disabled
    ) {
        self.fontSize = fontSize
        self.backgroundColor = backgroundColor
        self.foregroundColor = foregroundColor
        self.metalRendering = metalRendering
    }

    public func makeTerminalView(frame: CGRect) throws -> TerminalView {
        let terminalView = TerminalView(frame: frame, font: Self.terminalFont(pointSize: fontSize))
        try apply(to: terminalView)
        return terminalView
    }

    public func apply(to terminalView: TerminalView) throws {
        terminalView.font = Self.terminalFont(pointSize: fontSize)
        #if canImport(AppKit)
        terminalView.configureNativeColors()
        #endif
        terminalView.nativeBackgroundColor = backgroundColor
        terminalView.nativeForegroundColor = foregroundColor
        try applyMetal(to: terminalView)
    }

    public static var defaultBackgroundColor: PtyTerminalPlatformColor {
        #if canImport(AppKit)
        return NSColor(calibratedRed: 0.045, green: 0.048, blue: 0.055, alpha: 1)
        #elseif canImport(UIKit)
        return UIColor(red: 0.045, green: 0.048, blue: 0.055, alpha: 1)
        #endif
    }

    public static var defaultForegroundColor: PtyTerminalPlatformColor {
        #if canImport(AppKit)
        return NSColor(calibratedRed: 0.86, green: 0.88, blue: 0.9, alpha: 1)
        #elseif canImport(UIKit)
        return UIColor(red: 0.86, green: 0.88, blue: 0.9, alpha: 1)
        #endif
    }

    public static func terminalFont(pointSize: CGFloat) -> PtyTerminalPlatformFont {
        PtyTerminalFont.make(pointSize: pointSize)
    }

    private func applyMetal(to terminalView: TerminalView) throws {
        #if canImport(MetalKit)
        switch metalRendering {
        case .disabled:
            return
        case .enabled(let bufferingMode):
            terminalView.metalBufferingMode = bufferingMode.swiftTermMode
            try terminalView.setUseMetal(true)
        }
        #else
        if metalRendering != .disabled {
            throw PtyTerminalMetalRenderingError.metalUnavailable
        }
        #endif
    }
}

#if canImport(MetalKit)
private extension PtyTerminalMetalRendering.BufferingMode {
    var swiftTermMode: MetalBufferingMode {
        switch self {
        case .perRowPersistent:
            return .perRowPersistent
        case .perFrameAggregated:
            return .perFrameAggregated
        }
    }
}
#endif
