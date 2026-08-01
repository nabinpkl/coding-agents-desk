import AppKit
import Foundation
import WebKit

/// Native geometry that the web-owned title bar must leave clear.
///
/// The traffic lights remain standard AppKit controls. Immediately after them is one native drag
/// target, while the React header begins after both. Measuring the buttons keeps the layout correct
/// for AppKit changes instead of baking one macOS release's traffic-light positions into CSS.
struct AgentWindowTitlebarLayout: Equatable {
    static let trafficLightGap: CGFloat = 8
    static let dragRegionWidth: CGFloat = 32
    static let dragRegionHeight: CGFloat = 24
    static let contentGap: CGFloat = 8

    let dragRegionLeading: CGFloat
    let dragRegionWidth: CGFloat
    let dragRegionHeight: CGFloat
    let webLeadingInset: CGFloat

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

        let dragRegionLeading = ceil(trafficLightTrailing) + trafficLightGap
        return Self(
            dragRegionLeading: dragRegionLeading,
            dragRegionWidth: dragRegionWidth,
            dragRegionHeight: dragRegionHeight,
            webLeadingInset: dragRegionLeading + dragRegionWidth + contentGap
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
