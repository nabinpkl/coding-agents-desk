#if os(macOS)
import AppKit
#endif
import WebKit

/// The webview every panel runs in.
///
/// On macOS these panels are chrome for an accessory app that never activates,
/// so their window is usually not key when the user reaches for a control in
/// it: they are working somewhere else, which is the entire point of a floating
/// panel. AppKit spends that first click on making the window key unless the
/// view under the pointer accepts it, and a webview does not by default. The
/// result is a control that answers only the second click, which reads as a
/// dead button rather than as a focus rule.
final class WebPanelWebView: WKWebView {
    #if os(macOS)
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    #endif
}
