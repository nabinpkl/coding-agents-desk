// ADR-0046 diagnostic status for the Browser surface's status line. Pure and dependency-free (no
// UIKit) so the chip mapping is unit-testable without a view, matching the ControlSurface.swift
// seam pattern; the surface maps severity -> UIColor.
//
// Sources of each field:
//   mirroringOn   - the .dom lane is open (client knows)
//   extReachable  - host pushed dom-status: extension bridge connected (host knows)
//   recordingTab  - host pushed dom-status: recording tab id, nil when none (host knows)
//   lastBatchAgeMs- client-measured age since the last batch, nil if none yet
//   nodeCount     - last replayer probe node count, nil until the mirror paints
//   paused        - client paused capture because Browser is not in view (ADR-0045)
struct DomMirrorStatus: Equatable {
    var mirroringOn: Bool
    var extReachable: Bool
    var recordingTab: Int?
    var lastBatchAgeMs: Int?
    var nodeCount: Int?
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

    chips.append(StatusChip(
        text: s.mirroringOn ? "mirror ON" : "mirror OFF",
        severity: s.mirroringOn ? .ok : .off))

    chips.append(StatusChip(
        text: s.extReachable ? "ext \u{2713}" : "ext \u{2717}",
        severity: s.extReachable ? .ok : .warn))

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
