import Foundation
import Testing

struct SignalingFrameRoutingTests {
    @Test func classifyFirstFramePairTypeRoutesToPair() {
        let data = Data(#"{"type":"pair"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .pair)
    }

    @Test func classifyFirstFrameSessionInitTypeRoutesToSessionInit() {
        let data = Data(#"{"t":"session-init"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .sessionInit)
    }

    @Test func classifyFirstFrameWebRTCBeforeSessionIsMalformed() {
        // A WebRTC frame arriving as the first frame on a connection (i.e.
        // before SessionReady has been delivered) must not be accepted by
        // the first-frame router. The pre-SessionReady rejection is the
        // load-bearing invariant: media-plane control is only valid
        // post-handshake.
        let data = Data(#"{"t":"webrtc-offer","s":"v=0\r\n"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .malformed)
    }

    @Test func classifyFirstFrameEmptyDataIsMalformed() {
        #expect(SignalingFrameRouter.classifyFirstFrame(Data()) == .malformed)
    }

    @Test func classifyFirstFrameMissingTypeIsMalformed() {
        let data = Data(#"{"foo":"bar"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .malformed)
    }

    @Test func classifyActiveSessionFrameOfferDecodes() {
        let frame = WebRTCSignalingFrame.offer(sdp: "v=0\r\n")
        let data = try! JSONEncoder().encode(frame)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .webrtc(frame))
    }

    @Test func classifyActiveSessionFrameAnswerDecodes() {
        let frame = WebRTCSignalingFrame.answer(sdp: "v=0\r\n")
        let data = try! JSONEncoder().encode(frame)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .webrtc(frame))
    }

    @Test func classifyActiveSessionFrameIceDecodes() {
        let frame = WebRTCSignalingFrame.ice(sdp: "candidate:1 1 UDP 1 1.2.3.4 5000 typ host", sdpMid: "0", sdpMLineIndex: 0)
        let data = try! JSONEncoder().encode(frame)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .webrtc(frame))
    }

    @Test func classifyActiveSessionFrameInputCapabilityRefreshDecodes() {
        let request = InputCapabilityRefreshRequest(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123"
        )
        let data = try! JSONEncoder().encode(request)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .inputCapabilityRefresh(request))
    }

    @Test func classifyActiveSessionFrameMalformedIsMalformed() {
        let data = Data(#"{"t":"unknown"}"#.utf8)
        #expect(SignalingFrameRouter.classifyActiveSessionFrame(data) == .malformed)
    }

    @Test func webRTCFrameCodableRoundTripPreservesIceFields() throws {
        let frame = WebRTCSignalingFrame.ice(
            sdp: "candidate:42 1 UDP 100 192.168.1.1 9 typ host",
            sdpMid: "video",
            sdpMLineIndex: 7
        )
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(WebRTCSignalingFrame.self, from: data)
        #expect(decoded == frame)
    }

    @Test func webRTCFrameIceWithNilSdpMidRoundTrips() throws {
        let frame = WebRTCSignalingFrame.ice(sdp: "candidate:1 ...", sdpMid: nil, sdpMLineIndex: 0)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(WebRTCSignalingFrame.self, from: data)
        #expect(decoded == frame)
    }

    @Test func sdpCodecInspectorReportsFirstVideoCodecAndH264Profile() {
        let sdp = """
        v=0
        m=video 9 UDP/TLS/RTP/SAVPF 96 97 98
        a=rtpmap:96 H264/90000
        a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c34
        a=rtpmap:97 rtx/90000
        a=fmtp:97 apt=96
        a=rtpmap:98 VP9/90000
        """
        let codec = SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp)
        #expect(codec?.name == "H264")
        #expect(codec?.payloadType == "96")
        #expect(codec?.h264ProfileLevelId == "640c34")
        #expect(codec?.logSummary == "H264 pt=96 profile-level-id=640c34")
    }

    @Test func sdpCodecInspectorSkipsRepairPayloads() {
        let sdp = """
        v=0
        m=video 9 UDP/TLS/RTP/SAVPF 97 96
        a=rtpmap:97 rtx/90000
        a=fmtp:97 apt=96
        a=rtpmap:96 H264/90000
        a=fmtp:96 profile-level-id=42e034
        """
        let codec = SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp)
        #expect(codec?.name == "H264")
        #expect(codec?.payloadType == "96")
    }

    @Test func sdpCodecInspectorReturnsNilWithoutVideoMedia() {
        let sdp = """
        v=0
        m=audio 9 UDP/TLS/RTP/SAVPF 111
        a=rtpmap:111 opus/48000/2
        """
        #expect(SdpVideoCodecInspector.firstNegotiatedVideoCodec(in: sdp) == nil)
    }

    // ADR-0005 input channel first-frame discriminator.

    @Test func classifyFirstFrameInputHelloRoutesToInputHello() {
        let data = Data(#"{"t":"input-hello"}"#.utf8)
        #expect(SignalingFrameRouter.classifyFirstFrame(data) == .inputHello)
    }

    @Test func inputHelloFrameRoundTripsThroughCodable() throws {
        let hello = InputChannelHello(
            deviceFingerprint: DeviceFingerprint("device-fp"),
            sessionId: "session-123",
            inputCapability: "capability-abc"
        )
        let data = try JSONEncoder().encode(hello)
        let decoded = try JSONDecoder().decode(InputChannelHello.self, from: data)
        #expect(decoded == hello)
        #expect(decoded.type == "input-hello")
        #expect(decoded.deviceFingerprint == DeviceFingerprint("device-fp"))
        #expect(decoded.sessionId == "session-123")
        #expect(decoded.inputCapability == "capability-abc")
    }

    @Test func inputCapabilityGrantRoundTripsThroughCodable() throws {
        let grant = InputCapabilityGrant(
            sessionId: "session-123",
            inputCapability: "capability-def",
            inputCapabilityExpiresAt: 1_800_000_060
        )
        let data = try JSONEncoder().encode(grant)
        let decoded = try JSONDecoder().decode(InputCapabilityGrant.self, from: data)
        #expect(decoded == grant)
        #expect(decoded.type == "input-capability-grant")
        #expect(decoded.sessionId == "session-123")
        #expect(decoded.inputCapability == "capability-def")
        #expect(decoded.inputCapabilityExpiresAt == 1_800_000_060)
    }

    @Test func inputEventFrameRoundTripsThroughCodable() throws {
        let event = NormalizedInput.key(code: "ansi-A", modifiers: [.cmd, .shift])
        let frame = InputChannelEvent(event: event)
        let data = try JSONEncoder().encode(frame)
        let decoded = try JSONDecoder().decode(InputChannelEvent.self, from: data)
        #expect(decoded == frame)
        #expect(decoded.type == "input-event")
        #expect(decoded.event == event)
    }

    @Test func inputCloseFrameRoundTripsThroughCodable() throws {
        let close = InputChannelClose(reason: "revoked")
        let data = try JSONEncoder().encode(close)
        let decoded = try JSONDecoder().decode(InputChannelClose.self, from: data)
        #expect(decoded == close)
        #expect(decoded.type == "input-close")
        #expect(decoded.reason == "revoked")
    }
}
