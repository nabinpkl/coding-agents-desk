#if os(macOS)
import AppKit
#else
import UIKit
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
    /// Set by the container before loading a page that supplies its own keyboard controls.
    var hidesSystemKeyboardAccessory = false

    #if os(macOS)
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    #elseif os(iOS)
    // WebKit's focused content view delegates this public responder property to its WKWebView.
    // Returning nil removes the form-navigation/Done strip, not the software keyboard itself.
    override var inputAccessoryView: UIView? {
        hidesSystemKeyboardAccessory ? nil : super.inputAccessoryView
    }
    #endif
}
