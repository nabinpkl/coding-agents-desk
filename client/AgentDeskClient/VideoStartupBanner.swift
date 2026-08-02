// What the client says between "session connected" and the first frame it can
// actually draw.
//
// The control shell, the sink view and the diagnostics readout are all built
// inside startMediaTransportIfNeeded, so until that runs there is nothing on
// screen; after it runs the video area is a black rectangle until frames decode.
// On a slow link that window is seconds long, and an app drawing nothing there
// is indistinguishable from one that has failed.
//
// This file is intentionally dependency-free (no UIKit) so it can be compiled
// into the test target directly — the repo tests production code via dual
// target membership, not @testable linkage (see GestureTranslator.swift).
struct VideoStartupBanner: Equatable {
    /// Latched: it takes one picture to clear, and only a teardown or a
    /// background suspend arms it again. Without the latch a mid-stream stall
    /// ("video waiting keyframe") would throw the connect banner back over live
    /// video the user is already reading.
    private(set) var isAwaitingFirstFrame = true
    private(set) var detail: String?

    /// `hasPicture` is the frame that reached the display, not the transport
    /// coming up: the transport is connected long before there is anything to
    /// look at, and that gap is the one being explained.
    mutating func note(hasPicture: Bool, detail: String) {
        guard isAwaitingFirstFrame else { return }
        if hasPicture {
            isAwaitingFirstFrame = false
            self.detail = nil
        } else {
            self.detail = detail
        }
    }

    /// Re-arms after a teardown or background suspend, where frames stop and the
    /// next foreground starts black again.
    mutating func awaitFirstFrame(detail: String? = nil) {
        isAwaitingFirstFrame = true
        self.detail = detail
    }

    /// nil once there is a picture, which is the signal to hide the banner.
    ///
    /// Names the device so a wrong-Mac pairing is obvious, then says what the
    /// media stack is doing. That second line is what separates "the link is
    /// slow" from "this is broken", which is the whole reason to show it.
    func text(deviceFingerprint: String) -> String? {
        guard isAwaitingFirstFrame else { return nil }
        return """
        Connected (device \(deviceFingerprint))

        Waiting for the Mac screen
        \(detail ?? "starting media")
        """
    }
}
