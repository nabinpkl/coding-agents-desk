import Foundation
import Testing
@testable import AgentDeskWire

@Test
func voiceRoleAndFrameLimitAreAdditive() throws {
    #expect(QuicSessionStreamRole.voice.rawValue == 7)
    #expect(
        QuicSessionStreamFrame.maxFrameLength(for: .voice)
            == VoiceLaneCodec.maximumFrameBytes
    )
    let encoded = try QuicSessionStreamFrame.encode(
        role: .voice,
        payload: VoiceLaneCodec.encode(VoiceLaneHello())
    )
    #expect(try QuicSessionStreamFrame.decode(encoded).role == .voice)
}

@Test
func voiceHelloAndReadyRoundTrip() throws {
    let hello = try VoiceLaneCodec.decode(
        VoiceLaneHello.self,
        from: VoiceLaneCodec.encode(VoiceLaneHello())
    )
    #expect(hello.protocolIdentifier == "voice-lane-v2")
    let ready = try VoiceLaneCodec.decode(
        VoiceLaneHostMessage.self,
        from: VoiceLaneCodec.encode(VoiceLaneHostMessage.ready)
    )
    #expect(ready == .ready)
}

@Test
func voiceSocketAndRESTEnvelopesRoundTrip() throws {
    let socket = VoiceLaneClientMessage.socketMessage(
        recordingSessionID: "session-1",
        json: #"{"type":"audioFrame","sequence":0,"pcm":"AAAAAA==","sampleCount":1,"sampleRate":16000,"encoding":"float32","channels":1}"#
    )
    #expect(
        try VoiceLaneCodec.decode(
            VoiceLaneClientMessage.self,
            from: VoiceLaneCodec.encode(socket)
        ) == socket
    )

    let request = VoiceRESTRequest(
        requestID: "request-1",
        method: .post,
        path: "/recordings/id/reanalyze"
    )
    let envelope = VoiceLaneClientMessage.rest(request)
    #expect(
        try VoiceLaneCodec.decode(
            VoiceLaneClientMessage.self,
            from: VoiceLaneCodec.encode(envelope)
        ) == envelope
    )

    let response = VoiceLaneHostMessage.rest(VoiceRESTResponse(
        requestID: "request-1",
        status: 200,
        contentType: "audio/wav",
        sequence: 2,
        isFinal: false,
        body: Data(repeating: 0x7f, count: 96 * 1024)
    ))
    let responseData = try VoiceLaneCodec.encode(response)
    #expect(responseData.count < VoiceLaneCodec.maximumFrameBytes)
    #expect(
        try VoiceLaneCodec.decode(
            VoiceLaneHostMessage.self,
            from: responseData
        ) == response
    )
}

@Test
func voicePayloadLimitsRejectOversizedJSON() {
    let json = #"{"value":""# + String(
        repeating: "x",
        count: VoiceLaneCodec.maximumJSONBytes
    ) + #""}"#
    #expect(throws: VoiceLaneError.payloadTooLarge) {
        try VoiceLaneCodec.encode(
            VoiceLaneClientMessage.socketMessage(
                recordingSessionID: "session-1",
                json: json
            )
        )
    }
}
