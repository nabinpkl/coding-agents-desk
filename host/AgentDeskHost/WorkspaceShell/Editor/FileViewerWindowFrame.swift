import AppKit

extension FileViewer: NSWindowDelegate {
    public func windowDidMove(_ notification: Notification) {
        publishFrameChange()
    }

    public func windowDidResize(_ notification: Notification) {
        publishFrameChange()
    }

    public func windowWillClose(_ notification: Notification) {
        publishFrameChange()
    }

    private func publishFrameChange() {
        guard !isApplyingProgrammaticFrame, !window.frame.isEmpty else { return }
        onFrameChanged?(window.frame)
    }
}
