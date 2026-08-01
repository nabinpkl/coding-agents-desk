import CoreAudio
import Foundation
import os

/// Whether a voice capture should ask for echo cancellation, and a watcher for
/// the answer changing under it.
///
/// macOS implements browser echo cancellation with a voice-processing audio
/// unit, and that unit takes the OUTPUT device as its echo reference: while it
/// lives, the speakers are muted. Confirmed in the unified log, where
/// `Speaker: Control 'mute' changed to: 1` brackets `AUVoiceProcessor` for the
/// exact duration of every capture.
///
/// That price is worth paying only when the microphone is the Mac's own, where
/// it really can hear the Mac's speakers. Capturing through an iPhone over
/// Continuity, or any other device, would silence the speakers to cancel an
/// echo that microphone never picks up.
enum DefaultAudioInput {
    /// Pure decision, so the rule is testable without a sound card.
    static func shouldCancelEcho(inputTransportType: UInt32) -> Bool {
        inputTransportType == kAudioDeviceTransportTypeBuiltIn
    }

    static func currentTransportType() -> UInt32 {
        guard let device = defaultInputDevice() else { return 0 }
        var transport: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            device, &address, 0, nil, &size, &transport
        )
        return status == noErr ? transport : 0
    }

    static func shouldCancelEcho() -> Bool {
        shouldCancelEcho(inputTransportType: currentTransportType())
    }

    private static func defaultInputDevice() -> AudioObjectID? {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
        )
        guard status == noErr, device != AudioObjectID(kAudioObjectUnknown) else {
            return nil
        }
        return device
    }
}

/// Watches the default input device and reports when the echo-cancellation
/// answer flips, so a webview that was configured at load time does not keep
/// capturing under a rule that stopped being true when the user switched mics.
@MainActor
final class DefaultAudioInputMonitor {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "dictation")
    private let onChange: (Bool) -> Void
    private var listener: AudioObjectPropertyListenerBlock?
    private(set) var shouldCancelEcho: Bool

    init(onChange: @escaping (Bool) -> Void) {
        self.onChange = onChange
        shouldCancelEcho = DefaultAudioInput.shouldCancelEcho()
    }

    func start() {
        guard listener == nil else { return }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            Task { @MainActor in self?.reevaluate() }
        }
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            DispatchQueue.main,
            block
        )
        guard status == noErr else {
            logger.error(
                "default input listener failed status=\(Int(status), privacy: .public); echo cancellation will not follow a device change"
            )
            return
        }
        listener = block
        logger.notice(
            "default input transport=\(Int(DefaultAudioInput.currentTransportType()), privacy: .public) echoCancellation=\(self.shouldCancelEcho, privacy: .public)"
        )
    }

    func stop() {
        guard let listener else { return }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            DispatchQueue.main,
            listener
        )
        self.listener = nil
    }

    private func reevaluate() {
        let transport = DefaultAudioInput.currentTransportType()
        let next = DefaultAudioInput.shouldCancelEcho(inputTransportType: transport)
        guard next != shouldCancelEcho else { return }
        shouldCancelEcho = next
        logger.notice(
            "default input changed transport=\(Int(transport), privacy: .public) echoCancellation=\(next, privacy: .public)"
        )
        onChange(next)
    }
}
