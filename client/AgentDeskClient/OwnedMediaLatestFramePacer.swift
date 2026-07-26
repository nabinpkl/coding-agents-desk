import Foundation

enum OwnedMediaVideoPresentationAction<Frame> {
    case decodeOnly(Frame)
    case display(Frame)
}

extension OwnedMediaVideoPresentationAction: Equatable where Frame: Equatable {}

// ADR-0073: fixed-rate presentation has one replaceable newest-frame slot. A
// frame displaced from that slot is still decoded so later HEVC deltas retain
// their reference chain, but Core Media is told not to display it.
struct OwnedMediaLatestFramePacer<Frame> {
    private var expectedFrameRate: Int
    private var lastPresentationNs: UInt64?
    private var pendingFrame: Frame?

    init(expectedFrameRate: Int) {
        self.expectedFrameRate = max(1, expectedFrameRate)
    }

    mutating func setExpectedFrameRate(_ fps: Int) {
        expectedFrameRate = max(1, fps)
    }

    mutating func submit(
        _ frame: Frame,
        nowNs: UInt64
    ) -> [OwnedMediaVideoPresentationAction<Frame>] {
        guard let deadline = presentationDeadlineNs, nowNs < deadline else {
            var actions: [OwnedMediaVideoPresentationAction<Frame>] = []
            if let pendingFrame {
                actions.append(.decodeOnly(pendingFrame))
            }
            pendingFrame = nil
            lastPresentationNs = nowNs
            actions.append(.display(frame))
            return actions
        }

        var actions: [OwnedMediaVideoPresentationAction<Frame>] = []
        if let pendingFrame {
            actions.append(.decodeOnly(pendingFrame))
        }
        pendingFrame = frame
        return actions
    }

    mutating func takePendingIfDue(
        nowNs: UInt64
    ) -> OwnedMediaVideoPresentationAction<Frame>? {
        guard let deadline = presentationDeadlineNs,
              nowNs >= deadline,
              let pendingFrame else {
            return nil
        }
        self.pendingFrame = nil
        lastPresentationNs = nowNs
        return .display(pendingFrame)
    }

    var nextPresentationDeadlineNs: UInt64? {
        guard pendingFrame != nil else { return nil }
        return presentationDeadlineNs
    }

    mutating func reset() {
        lastPresentationNs = nil
        pendingFrame = nil
    }

    private var presentationDeadlineNs: UInt64? {
        guard let lastPresentationNs else { return nil }
        let intervalNs = UInt64(max(1, 1_000_000_000 / expectedFrameRate))
        let (deadline, overflow) = lastPresentationNs.addingReportingOverflow(intervalNs)
        return overflow ? UInt64.max : deadline
    }
}
