import UIKit

// Wiring for the on-device speech-context comparison probe.
//
// Unlike every other surface, Voice opens no session lane and needs no active
// pairing: capture and recognition are entirely local to the phone. That is why
// `ensureVoiceSurface()` is synchronous and has no transport, generation, or
// reconnect-rebind machinery — there is nothing to rebind.
extension PairingViewController {
    private enum VoiceKeys {
        nonisolated(unsafe) static var surface: UInt8 = 0
    }

    var voiceSurface: UIView? {
        objc_getAssociatedObject(self, &VoiceKeys.surface) as? UIView
    }

    /// Idempotent: builds the playground on first switch to Voice.
    func ensureVoiceSurface() {
        guard #available(iOS 26.0, *) else { return }
        guard voiceSurface == nil else { return }

        let surface = VoicePlaygroundSurface()
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.isHidden = activeControlSurface != .voice
        view.addSubview(surface)
        constrainSurfaceBesideControlRail(surface, bottomAnchor: view.bottomAnchor)
        view.bringSubviewToFront(surfaceControlRail)
        objc_setAssociatedObject(
            self,
            &VoiceKeys.surface,
            surface,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
    }

    func teardownVoiceSurface() {
        guard #available(iOS 26.0, *) else { return }
        guard let surface = voiceSurface as? VoicePlaygroundSurface else { return }
        surface.teardown()
        surface.removeFromSuperview()
        objc_setAssociatedObject(
            self,
            &VoiceKeys.surface,
            nil,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
    }

    /// Stops an in-flight recording when the user leaves the surface, so a live
    /// mic tap and `.record` session do not outlive the view the user is looking
    /// at.
    func suspendVoiceSurfaceIfNeeded() {
        guard #available(iOS 26.0, *) else { return }
        (voiceSurface as? VoicePlaygroundSurface)?.suspend()
    }
}
