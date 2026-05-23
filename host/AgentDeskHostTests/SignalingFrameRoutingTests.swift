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
}
