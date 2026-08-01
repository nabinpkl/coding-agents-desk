import CoreAudio
import Testing
@testable import AgentDeskHost

struct DefaultAudioInputTests {
    @Test func onlyTheMacsOwnMicrophonePaysForEchoCancellation() {
        #expect(
            DefaultAudioInput.shouldCancelEcho(
                inputTransportType: kAudioDeviceTransportTypeBuiltIn
            )
        )
        // An iPhone over Continuity, AirPods, or a USB interface cannot hear the
        // Mac's speakers well enough to justify muting them for the whole run.
        #expect(
            !DefaultAudioInput.shouldCancelEcho(
                inputTransportType: kAudioDeviceTransportTypeBluetooth
            )
        )
        #expect(
            !DefaultAudioInput.shouldCancelEcho(
                inputTransportType: kAudioDeviceTransportTypeUSB
            )
        )
        #expect(
            !DefaultAudioInput.shouldCancelEcho(
                inputTransportType: kAudioDeviceTransportTypeVirtual
            )
        )
        // No default input device at all reads as "not ours", which keeps the
        // speakers playing rather than muting them for a microphone we failed
        // to identify.
        #expect(!DefaultAudioInput.shouldCancelEcho(inputTransportType: 0))
    }

    @Test func audioConfigDeliveryCarriesTheRevisedAnswer() {
        #expect(
            InteractionPanelHostConfiguration.audioConfigDelivery(echoCancellation: false)
                == #"{"type":"voiceAudioConfig","payload":{"echoCancellation":false}}"#
        )
        #expect(
            InteractionPanelHostConfiguration.audioConfigDelivery(echoCancellation: true)
                == #"{"type":"voiceAudioConfig","payload":{"echoCancellation":true}}"#
        )
    }
}
