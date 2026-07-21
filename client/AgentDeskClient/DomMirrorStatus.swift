// ADR-0046 diagnostic status for the Browser surface's status line. Pure and dependency-free (no
// UIKit) so the chip mapping is unit-testable without a view, matching the ControlSurface.swift
// seam pattern; the surface maps severity -> UIColor.
//
// The Browser surface being on screen already implies mirroring is enabled (the segment only exists
// when the .dom lane is open), so there is no "mirror on/off" chip. Sources of each field:
//   bridgeConnected - host pushed dom-status: the extension<->host native-messaging bridge is
//                     connected. NB it only connects while the extension is streaming (it opens the
//                     port lazily on the first batch), so this reads as "extension streaming to
//                     host", NOT "extension installed". Hence the honest "bridge" label.
//   recordingTab    - host pushed dom-status: recording tab id, nil when none (single-tab v1)
//   lastBatchAgeMs  - client-measured age since the last batch, nil if none yet
//   nodeCount       - last replayer probe node count, nil until the mirror paints
//   batchCount      - total batches received this session (liveness/throughput)
//   paused          - this viewer released source ownership because Browser is not in view
struct DomMirrorStatus: Equatable {
    var bridgeConnected: Bool
    var recordingTab: Int?
    var lastBatchAgeMs: Int?
    var nodeCount: Int?
    var batchCount: Int
    var paused: Bool
}

enum StatusSeverity {
    case ok    // green: healthy
    case warn  // amber: attention (not reachable / idle / paused)
    case off   // gray: feature off
}

struct StatusChip: Equatable {
    let text: String
    let severity: StatusSeverity
}

// Deterministic status -> chip list. Order is fixed left-to-right so the line reads consistently.
func statusChips(_ s: DomMirrorStatus) -> [StatusChip] {
    var chips: [StatusChip] = []

    // Extension <-> host native-messaging bridge. Up only while the extension streams, so "bridge
    // ✗" means "nothing streaming to the host" (not necessarily "extension not installed").
    chips.append(StatusChip(
        text: s.bridgeConnected ? "bridge \u{2713}" : "bridge \u{2717}",
        severity: s.bridgeConnected ? .ok : .warn))

    if let tab = s.recordingTab {
        chips.append(StatusChip(text: "rec tab \(tab)", severity: .ok))
    } else {
        chips.append(StatusChip(text: "no rec", severity: .warn))
    }

    if s.paused {
        chips.append(StatusChip(text: "paused", severity: .warn))
    }

    if let n = s.nodeCount {
        chips.append(StatusChip(text: "\(n) nodes", severity: n > 0 ? .ok : .warn))
    }

    if s.batchCount > 0 {
        chips.append(StatusChip(text: "\(s.batchCount) batches", severity: .ok))
    }

    if let age = s.lastBatchAgeMs {
        if age < 1000 {
            chips.append(StatusChip(text: "just now", severity: .ok))
        } else {
            let sec = age / 1000
            chips.append(StatusChip(text: "\(sec)s ago", severity: sec < 5 ? .ok : .warn))
        }
    } else {
        chips.append(StatusChip(text: "no data", severity: .warn))
    }

    return chips
}
