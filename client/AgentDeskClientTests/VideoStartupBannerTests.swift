import Testing

struct VideoStartupBannerTests {
    @Test func aFreshSessionExplainsTheBlackScreenAndNamesTheDevice() {
        let banner = VideoStartupBanner()

        let text = banner.text(deviceFingerprint: "AB12")

        #expect(banner.isAwaitingFirstFrame)
        #expect(text?.contains("AB12") == true)
        #expect(text?.contains("Waiting for the Mac screen") == true)
        // Before the media stack has said anything, the banner still has to
        // report something rather than trail off after the heading.
        #expect(text?.contains("starting media") == true)
    }

    @Test func transportProgressIsReportedWhileThereIsStillNoPicture() {
        var banner = VideoStartupBanner()

        banner.note(hasPicture: false, detail: "media connecting")
        #expect(banner.text(deviceFingerprint: "AB12")?.contains("media connecting") == true)

        banner.note(hasPicture: false, detail: "video waiting keyframe")
        let text = banner.text(deviceFingerprint: "AB12")
        #expect(text?.contains("video waiting keyframe") == true)
        #expect(text?.contains("media connecting") == false)
        #expect(banner.isAwaitingFirstFrame)
    }

    @Test func theFirstPictureClearsTheBannerForGood() {
        var banner = VideoStartupBanner()
        banner.note(hasPicture: false, detail: "media connecting")

        banner.note(hasPicture: true, detail: "video 30fps")

        #expect(!banner.isAwaitingFirstFrame)
        #expect(banner.text(deviceFingerprint: "AB12") == nil)

        // A mid-stream stall must not throw the connect banner back over video
        // the user is already reading; the diagnostics readout carries that.
        banner.note(hasPicture: false, detail: "video waiting keyframe")
        #expect(!banner.isAwaitingFirstFrame)
        #expect(banner.text(deviceFingerprint: "AB12") == nil)
    }

    @Test func aSuspendArmsTheBannerAgainBecauseTheNextForegroundStartsBlack() {
        var banner = VideoStartupBanner()
        banner.note(hasPicture: true, detail: "video 30fps")

        banner.awaitFirstFrame(detail: "media suspended")

        #expect(banner.isAwaitingFirstFrame)
        #expect(banner.text(deviceFingerprint: "AB12")?.contains("media suspended") == true)

        banner.note(hasPicture: true, detail: "video 30fps")
        #expect(banner.text(deviceFingerprint: "AB12") == nil)
    }

    @Test func aTeardownArmsTheBannerWithNoStaleDetail() {
        var banner = VideoStartupBanner()
        banner.note(hasPicture: false, detail: "video dropped")

        banner.awaitFirstFrame()

        #expect(banner.isAwaitingFirstFrame)
        let text = banner.text(deviceFingerprint: "AB12")
        #expect(text?.contains("video dropped") == false)
        #expect(text?.contains("starting media") == true)
    }
}
