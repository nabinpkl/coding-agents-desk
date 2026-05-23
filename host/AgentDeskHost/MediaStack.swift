import Foundation

// ADR-0004 composition root. The only file that names concrete impls.
// Swapping the WebRTC library, codec, or capturer is editing this file and
// no other. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.3+.

enum MediaStack {
    static func makeFactory() -> MediaTransportFactory {
        LibWebRTCTransportFactory(codecs: .h264Only)
    }

    // R8.6.3 wires TestPatternFrameSource so the pipe can be verified
    // before Screen Recording TCC is granted. R8.6.5 swaps in
    // ScreenCaptureKitFrameSource.
    static func makeFrameSource() -> VideoFrameSource {
        TestPatternFrameSource()
    }
}
