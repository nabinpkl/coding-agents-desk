import UIKit

// Always-present local mode for the on-device speech-context comparison probe.
//
// Voice opens no session lane and needs no active pairing: capture and
// recognition are entirely local to the phone. Its utility toggle lives beside
// Settings from first launch, while this file owns its local lifecycle.
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
        surface.onBackToVideo = { [weak self] in
            self?.leaveVoiceSurface()
        }
        view.addSubview(surface)
        NSLayoutConstraint.activate([
            surface.topAnchor.constraint(equalTo: view.topAnchor),
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        objc_setAssociatedObject(
            self,
            &VoiceKeys.surface,
            surface,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
    }

    @objc func toggleVoiceSurface() {
        if activeControlSurface == .voice {
            leaveVoiceSurface()
            return
        }

        if activeControlSurface == .agent {
            agentTerminalLifecycleRouter.route(.switchAway, to: agentSurface)
        }
        if case .scanning = pairingClient.state {
            stopCamera()
            pairingClient.cancelScanning()
        }
        // A pending reconnect exists only to reach host-backed surfaces. Voice must become
        // usable immediately even when that host is unavailable -- so this assignment does the
        // cancelling, via the observer that closes the supervisor's gate.
        activeControlSurface = .voice
        surfaceControlRail.select(.voice)
        ensureVoiceSurface()
        render()
    }

    func leaveVoiceSurface() {
        guard activeControlSurface == .voice else { return }
        suspendVoiceSurfaceIfNeeded()
        // Reopens the supervisor's gate through the observer; no separate dial call.
        activeControlSurface = .control
        render()
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
