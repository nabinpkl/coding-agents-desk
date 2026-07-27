import ObjectiveC
import UIKit
import AgentDeskWire

/// The iOS gesture panel: a half-screen `GestureSurface` shown below the video
/// when the control-rail gesture button is tapped. Detection runs in the webview; a
/// detected swipe becomes a `NormalizedInput.switchSpaceStep` frame on the input
/// lane, so the phone's camera switches the Mac's Spaces while the desktop stays
/// visible in the top half.
extension PairingViewController {
    private enum GestureSurfaceKeys {
        nonisolated(unsafe) static var surface: UInt8 = 0
    }

    var gestureSurface: GestureSurface? {
        get { objc_getAssociatedObject(self, &GestureSurfaceKeys.surface) as? GestureSurface }
        set {
            objc_setAssociatedObject(
                self, &GestureSurfaceKeys.surface, newValue, .OBJC_ASSOCIATION_RETAIN_NONATOMIC
            )
        }
    }

    @objc func toggleGesturePanel() {
        let surface = ensureGestureSurface()
        let show = surface.isHidden
        surface.isHidden = !show
        if show {
            hostContentView.bringSubviewToFront(surface)
            surface.refreshReferenceSpeechState()
        }
        surfaceControlRail.setUtilityButton(gestureToggleButton, selected: show)
        view.bringSubviewToFront(surfaceControlRail)
    }

    /// Lazily builds the panel pinned to the bottom half of the screen and wires
    /// its Space step to the input lane. Idempotent.
    @discardableResult
    private func ensureGestureSurface() -> GestureSurface {
        if let existing = gestureSurface {
            return existing
        }
        let surface = GestureSurface()
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.isHidden = true
        surface.onSpaceStep = { [weak self] delta in
            self?.sendInput(.switchSpaceStep(delta: delta))
        }
        surface.voiceTransportProvider = { [weak self] in
            self?.pairingClient.activeSessionTransport
        }
        hostContentView.addSubview(surface)
        NSLayoutConstraint.activate([
            // Bottom half of the screen; the video stays visible above it.
            surface.topAnchor.constraint(equalTo: view.centerYAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        gestureSurface = surface
        return surface
    }
}
