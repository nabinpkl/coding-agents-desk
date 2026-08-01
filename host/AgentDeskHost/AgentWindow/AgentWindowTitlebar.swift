import AppKit
import Foundation
import WebKit

/// Native geometry that the web-owned title bar must leave clear.
///
/// The traffic lights remain standard AppKit controls. The React header begins immediately after
/// them, and a native drag target overlays the inert title area after its leading control. Measuring
/// the buttons keeps the layout correct for AppKit changes instead of baking one macOS release's
/// traffic-light positions into CSS.
struct AgentWindowTitlebarLayout: Equatable {
    static let trafficLightGap: CGFloat = 8
    static let leadingControlWidth: CGFloat = 44
    static let leadingControlGap: CGFloat = 4
    static let dragRegionWidth: CGFloat = 32
    static let dragRegionHeight: CGFloat = 24

    let dragRegionWidth: CGFloat
    let dragRegionHeight: CGFloat
    let webLeadingInset: CGFloat

    func dragRegionLeading(zoomScale: Double) -> CGFloat {
        precondition(zoomScale.isFinite && zoomScale > 0, "Agents title-bar zoom must be positive")
        return webLeadingInset
            + (Self.leadingControlWidth + Self.leadingControlGap) * CGFloat(zoomScale)
    }

    @MainActor
    static func measure(in window: NSWindow) -> Self {
        let contentView = window.contentView
        guard let trafficLightTrailing = [
            NSWindow.ButtonType.closeButton,
            .miniaturizeButton,
            .zoomButton,
        ].compactMap { type -> CGFloat? in
            guard
                let button = window.standardWindowButton(type),
                let superview = button.superview,
                let contentView
            else { return nil }
            return contentView.convert(button.frame, from: superview).maxX
        }.max() else {
            preconditionFailure("Agents window must expose standard traffic-light controls")
        }

        let webLeadingInset = ceil(trafficLightTrailing) + trafficLightGap
        return Self(
            dragRegionWidth: dragRegionWidth,
            dragRegionHeight: dragRegionHeight,
            webLeadingInset: webLeadingInset
        )
    }
}

/// Document-start configuration for the Mac-only title-bar inset.
///
/// `pageZoom` changes how many native points one CSS pixel occupies. Dividing the measured inset by
/// the current zoom keeps the first web control aligned to the same physical point at every level.
@MainActor
enum AgentWindowPanelChrome {
    private static let setterName = "__agentDeskSetTitlebarLeadingInset"

    nonisolated static func cssLeadingInset(
        points: CGFloat,
        zoomScale: Double
    ) -> Double {
        guard zoomScale.isFinite, zoomScale > 0 else { return Double(points) }
        return Double(points) / zoomScale
    }

    static func userScript(
        leadingInset: CGFloat,
        zoomScale: Double
    ) -> WKUserScript {
        let value = javascriptNumber(cssLeadingInset(points: leadingInset, zoomScale: zoomScale))
        return WKUserScript(
            source: """
            (() => {
              const apply = (value) => {
                const update = () => document.documentElement?.style.setProperty(
                  "--agent-window-titlebar-leading",
                  `${value}px`
                );
                if (document.documentElement) update();
                else document.addEventListener("DOMContentLoaded", update, { once: true });
              };
              window.\(setterName) = apply;
              apply(\(value));
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    static func updateScript(
        leadingInset: CGFloat,
        zoomScale: Double
    ) -> String {
        let value = javascriptNumber(cssLeadingInset(points: leadingInset, zoomScale: zoomScale))
        return "window.\(setterName)?.(\(value));"
    }

    private static func javascriptNumber(_ value: Double) -> String {
        String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}

/// A transparent native hit target over the blank section declared by the web header.
///
/// WebKit consumes background mouse events, so `isMovableByWindowBackground` cannot start a drag.
/// Keeping this target native preserves AppKit's Window Server drag behavior without covering any
/// web control or creating a second webview just for chrome.
final class AgentWindowTitlebarDragView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
