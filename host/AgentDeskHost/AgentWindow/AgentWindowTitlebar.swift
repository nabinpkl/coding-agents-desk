import AppKit
import Foundation
import WebKit

/// Native geometry that the web-owned title bar must leave clear.
///
/// The traffic lights remain standard AppKit controls, and the React header begins immediately
/// after them. Measuring the buttons keeps the layout correct for AppKit changes instead of baking
/// one macOS release's traffic-light positions into CSS.
struct AgentWindowTitlebarLayout: Equatable {
    static let trafficLightGap: CGFloat = 8

    let webLeadingInset: CGFloat

    @MainActor
    static func measure(in window: NSWindow) -> Self {
        let contentView = window.contentView
        guard let trafficLightTrailing = [
            NSWindow.ButtonType.closeButton,
            .miniaturizeButton,
            .zoomButton,
        ].compactMap({ type -> CGFloat? in
            guard
                let button = window.standardWindowButton(type),
                let superview = button.superview,
                let contentView
            else { return nil }
            return contentView.convert(button.frame, from: superview).maxX
        }).max() else {
            preconditionFailure("Agents window must expose standard traffic-light controls")
        }

        return Self(webLeadingInset: ceil(trafficLightTrailing) + trafficLightGap)
    }
}

/// A command the web title bar asks the native window to carry out.
enum AgentWindowChromeCommand: String, Equatable {
    /// Begin an AppKit window drag for the mouse-down the web header just declined to handle.
    case beginWindowDrag = "drag"
}

/// The left-button press a web-declared drag region can still ask to drag, held from AppKit's
/// dispatch of the press until the button comes back up.
///
/// `NSApp.currentEvent` cannot serve this. The title bar's hit test runs in the web process, so its
/// answer arrives at least one round trip after the press, and a trackpad emits `.pressure` events
/// into that gap. By the time the drag is requested the current event is one of those rather than
/// the press, so press-and-hold never dragged while a quick flick did. The flick only worked
/// because it left a `.leftMouseDragged` as the latest event when the answer landed.
struct AgentWindowPressTracker {
    /// The press currently held down, if any.
    private(set) var activePress: NSEvent?

    /// Records an event on its way through AppKit. Only the press and its release move this;
    /// everything a trackpad emits in between leaves the held press intact.
    mutating func record(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            activePress = event
        case .leftMouseUp:
            activePress = nil
        default:
            break
        }
    }
}

/// The Mac-only bridge between the web-owned title bar and its native window.
///
/// Two narrow directions. Native pushes the measured traffic-light inset in as a CSS variable so
/// the web header never draws under the buttons. The web calls back to start a window drag, because
/// WebKit consumes the background mouse events `isMovableByWindowBackground` would otherwise act
/// on, and only the DOM knows which parts of its own header are inert.
///
/// The drag entry point is installed here rather than exported by the web bundle so the shared iOS
/// build carries no Mac-only branch: the bundle calls the global when it exists and does nothing
/// when it does not.
@MainActor
enum AgentWindowPanelChrome {
    /// Script-message channel for web-initiated window chrome commands.
    static let messageHandlerName = "agentWindowChrome"

    private static let insetSetterName = "__agentDeskSetTitlebarLeadingInset"
    private static let dragFunctionName = "__agentDeskBeginWindowDrag"

    /// `pageZoom` changes how many native points one CSS pixel occupies. Dividing the measured
    /// inset by the current zoom keeps the first web control aligned to the same physical point at
    /// every level.
    nonisolated static func cssLeadingInset(
        points: CGFloat,
        zoomScale: Double
    ) -> Double {
        guard zoomScale.isFinite, zoomScale > 0 else { return Double(points) }
        return Double(points) / zoomScale
    }

    static func leadingInsetUserScript(
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
              window.\(insetSetterName) = apply;
              apply(\(value));
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }

    static func leadingInsetUpdateScript(
        leadingInset: CGFloat,
        zoomScale: Double
    ) -> String {
        let value = javascriptNumber(cssLeadingInset(points: leadingInset, zoomScale: zoomScale))
        return "window.\(insetSetterName)?.(\(value));"
    }

    /// Installs the drag entry point the web title bar calls once it decides a mouse-down landed on
    /// inert chrome. Injected at document start so the bundle never has to wait for it.
    static let windowDragUserScript = WKUserScript(
        source: """
        (() => {
          window.\(dragFunctionName) = () => {
            window.webkit?.messageHandlers?.\(messageHandlerName)?.postMessage({
              t: "\(AgentWindowChromeCommand.beginWindowDrag.rawValue)"
            });
          };
        })();
        """,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )

    static func command(from body: Any) -> AgentWindowChromeCommand? {
        guard
            let payload = body as? [String: Any],
            let tag = payload["t"] as? String
        else { return nil }
        return AgentWindowChromeCommand(rawValue: tag)
    }

    private static func javascriptNumber(_ value: Double) -> String {
        String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), value)
    }
}
